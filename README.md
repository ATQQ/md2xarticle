# Markdown → X 文章

把 Markdown 粘贴进 X（Twitter）文章编辑器，自动转成富文本并上传图片。

不新建草稿，只写入你当前打开的那篇文章。适用于 Chrome、Edge、Arc、Brave 等 Chromium 浏览器。

在线安装页：<https://atqq.github.io/md2xarticle/>

## 下载

**[下载最新版](../../releases/latest/download/md2xarticle.zip)**

也可以打开 [Releases](../../releases/latest)，下载 `md2xarticle-v*.zip`。

环境要求：Chromium 111+。

## 安装

1. 下载 ZIP 并解压。
2. 打开浏览器扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
   - Arc：`arc://extensions`
3. 打开右上角的 **开发者模式**。
4. 点 **加载已解压的扩展程序**，选择解压后包含 `manifest.json` 的文件夹。
5. 点工具栏的拼图图标，把「Markdown → X 文章」固定出来。

更新时下载新版 ZIP，覆盖原文件夹，再回扩展管理页点一次「重新加载」。

## 使用

1. 打开 `x.com/compose/articles`，手动新建或打开一篇草稿。
2. 进入能看到标题框和正文编辑区的位置，点击右下角 **「↑ 导入 Markdown」**。
3. 粘贴 Markdown，或把 `.md` / 图片文件夹拖进面板。
4. 点击 **「导入到当前编辑器」**，等待进度完成。

支持：

- 直接粘贴 Markdown 文本
- 选择或拖入 `.md` 文件
- 拖入整个文章文件夹，自动读取 Markdown 和本地图片
- 直接粘贴剪贴板图片
- 自动下载 Markdown 中的远程图片

## 常见问题

| 问题 | 处理 |
| --- | --- |
| 页面右下角没有按钮 | 只会在 `x.com/compose/articles` 相关的文章页面出现 |
| 提示找不到编辑器 | 先在 X 里手动新建文章，进入编辑页后再导入 |
| 标题没有变化 | 只有标题框为空时才会自动填写，已有标题不会被覆盖 |
| 某张图片没插进去 | 检查图片是否过大或格式异常，重试一次通常即可 |
| 远程图片失败 | 常见于防盗链，把图片下载到本地后再拖入面板 |

更多排查与开发说明见 [docs/DETAILS.md](docs/DETAILS.md)。

## License

[MIT](./LICENSE) © sugar
