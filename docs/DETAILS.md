# md2xarticle 细节文档

README 只讲「解决什么问题 + 怎么用」。这里放实现细节、排查与开发相关的内容。

- [权限说明](#权限说明)
- [图片处理规则](#图片处理规则)
- [工作原理](#工作原理)
- [常见问题](#常见问题)
- [开发与自测](#开发与自测)
- [目录结构](#目录结构)
- [Roadmap](#roadmap)

---

## 权限说明

| 权限                                       | 用途                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `https://x.com/*`、`https://twitter.com/*` | 在 X 页面注入面板与写入脚本                                                             |
| `https://*/*`、`http://*/*`                | **只**用于代抓 Markdown 里的远程图片（页面里直接 fetch 会被 CORS 挡住，必须放到后台拿） |

**不需要远程图抓取**的话，把 `manifest.json` 里 `host_permissions` 的 `https://*/*`、`http://*/*` 两行删掉即可，其余功能完全不受影响。

**不收集任何数据**：不上报、不埋点、不联网（唯一的出网请求，就是替你去下载你写在 Markdown 里的那张远程图）。

---

## 图片处理规则

图片会**自动整理成 X 能接收的格式与体积**：

- 非 `png / jpg / webp / gif` → 转成 PNG；
- 超过 5MB → 自动压成 JPEG（逐级降质量直到达标）；
- 长边超过 4096px → 等比缩小；
- GIF **原样保留**（不动画帧）。

> 图片如果在面板里出现同名的多张，按拖入/选择的顺序入队；本地路径按**文件名**与 Markdown 里的引用自动配对。

---

## 工作原理

写入靠的是**合成 `paste` 事件**，不调 X 的任何内部接口，也不用账号凭证。

1. **定位编辑器** —— 多级兜底，不依赖单一选择器：
   `[data-testid="composer"]` → 页面上所有 `contenteditable` → 逐个沿 **React fiber** 向上找持有 `editorState` + `onChange` 的组件实例。
2. **写正文** —— 构造 `DataTransfer`（`text/html` + `text/plain`），向编辑器派发 `ClipboardEvent('paste')`，让 X 自己解析这段富文本。
3. **插图片** —— 每张图先在正文里留一个占位段（`XMDIMGxxxx_1`），然后把 `File` 塞进 `DataTransfer` 派发 paste，**由 X 自己的上传通道**处理；等新的图片块（atomic block）出现后，把它**挪到占位段的位置**并删掉占位。
4. **不与 X 抢编辑器** —— 全程检测 X 的「正在上传 / 处理媒体」状态，它忙的时候不动编辑器，否则会被它的异步回调覆盖。
5. **只在文章页出现** —— 页面内按 URL 门禁：

```js
/^\/(?:compose\/articles|i\/articles)(?:\/|$)/   // 命中才显示面板
```

| 路径                                                                   | 结果   |
| ---------------------------------------------------------------------- | ------ |
| `/compose/articles`                                                    | ✓ 显示 |
| `/compose/articles/edit/<id>`                                          | ✓ 显示 |
| `/i/articles/...`                                                      | ✓ 显示 |
| `/home`、`/explore`、`/messages`、`/compose/post`（发推）、`/settings` | ✗ 隐藏 |

X 是 SPA，切页不刷新，而且 `pushState` **不触发 `popstate`**。所以除了监听 `popstate` / `hashchange`，还有 **1 秒一次的 URL 轮询兜底**（只跑一次正则，开销可忽略）。

因为走的都是 X 自己的粘贴/上传通路，代价是 X 若大改编辑器结构可能需要跟着调整 —— 届时点面板底部的「导出诊断信息」把页面结构发出来即可定位。

---

## 常见问题

**Q：面板没出现？**
只有 `x.com/compose/articles`（含子路径）会显示。别在首页 / 时间线里找。

**Q：提示「找不到 X 文章编辑器」？**
你还没进编辑页。先手动新建一篇文章，看到标题框和正文输入区再导入。

**Q：标题没填上？**
只有标题框**为空**时才会填。已有标题不会被覆盖（这是故意的）。

**Q：某张图没插进去？**
面板会列出失败的是第几张。常见原因是 X 那边上传失败，重试一次通常就好（扩展本身会重试 3 轮）。

**Q：远程图抓不到？**
部分是图床的防盗链。把图片下载到本地，按文件名放进 Markdown 的路径里即可。

**Q：Markdown 里的表格 / 分割线变形了？**
X 文章不支持表格和分割线，这是编辑器本身的限制。要保真就把表格**截成图片**再当图片插。

**Q：导入到一半 X 卡住了？**
点「中断」。已写入的内容会保留，占位段会自动清理。

**Q：定位一直失败？**
点面板最下面 **「定位失败？点这里导出诊断信息」**，它会把当前页面的编辑器结构复制到剪贴板，提 issue 时贴上即可。

---

## 开发与自测

零构建：`vendor/marked.min.js` 是本地化的 Markdown 解析器（marked 12.0.2）。改完源码，在扩展管理页点「重新加载」即可生效。

仓库里带了一个**离线测试台** `test/harness.html`：它 mock 了扩展环境，并造了一个**带 React fiber 结构的假编辑器**，可以在不登录 X 的情况下验证：

- 编辑器定位逻辑（`editorEl` / `holderOf` / `titleEl`）
- Markdown 解析与降级（`mdToSegments`）
- 页面门禁与提示条（`syncVisible` / `tip`）
- 中断链路（`abortState` / `setAbort` / `waitFor`）

起一个静态服务打开即可：

```bash
python3 -m http.server 4199
# 打开 http://127.0.0.1:4199/test/harness.html
```

控制台里有两个调试入口：

```js
window.__xmd          // 隔离世界：mdToSegments / syncVisible / tip / setBusyUI / _setPath ...
window.__xmdMainAPI   // MAIN world：editorEl / holderOf / titleEl / waitFor / abortState / setAbort
```

示例：

```js
window.__xmd.mdToSegments('# 标题\n\n## [链接标题](https://example.com)')
window.__xmd._setPath('/compose/articles')   // 模拟 SPA 路由
window.__xmdMainAPI.setAbort(true)           // 模拟中断
```

> 注意：测试台必须用 `http://` 打开 —— `file://` 下 `history.pushState` 受限，模拟不了 X 的 SPA 路由。

### 示例样本

`test/sample/` 放了一份可直接拿去试的文章：

| 文件 | 说明 |
| ---- | ---- |
| `视野修炼第136期.md` | 取自博客周刊第 136 期，配图已全部改成相对路径 `./images/NN.png` |
| `images/01.png` ~ `05.png` | 对应的 5 张本地图片（约 1.1MB） |

用法：把整个 `sample/` 文件夹拖进扩展面板 —— 扩展会递归读取目录，自动载入 `.md`、把 5 张图入队，并按**文件名**与 Markdown 里的相对路径配对。也可以只拖 `.md`，再单独把图片拖进去。

---

## 目录结构

```
x-md-to-article/
├── manifest.json         扩展清单（MV3）
├── src/
│   ├── main.js           MAIN world：定位 Draft.js 实例、合成 paste 写入正文与图片
│   ├── panel.js          隔离世界：面板 UI + Markdown 解析 + 图片准备 + 页面门禁
│   └── bg.js             Service Worker：代抓远程图片（绕 CORS）
├── vendor/
│   └── marked.min.js     Markdown 解析器（本地化，离线可用）
├── docs/
│   └── DETAILS.md        本文档（权限 / 原理 / FAQ / 开发）
└── test/
    ├── harness.html      离线自测台（mock 扩展环境 + 假 Draft 编辑器）
    └── sample/           示例文章：视野修炼第136期.md + images/（相对路径引用）
```

---

## Roadmap

- [ ] 上架 Chrome Web Store / Edge Add-ons
- [ ] 表格自动转成图片插入
- [ ] 记住上次粘贴的 Markdown
- [ ] 面板可拖动 / 折叠
