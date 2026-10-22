/* 隔离世界：面板 UI + Markdown 解析 + 图片准备，与 MAIN world 通过 postMessage 通信。
   v1 与旧插件的根本区别：
   1. 不新建草稿、不判断 URL —— 只要页面上有编辑器就写进去
   2. 支持直接粘贴 Markdown 文本（不只是选文件）
   3. 标题只在标题框为空时填，绝不覆盖已有内容
   4. 图片可来自：本地文件夹 / 剪贴板粘贴 / 远程 URL
   5. 内置诊断：定位失败时能一键把页面结构导出来 */
(() => {
  if (window.__xmdPanel__) return;
  window.__xmdPanel__ = true;

  const SRC_IN = 'xmd-iso', SRC_OUT = 'xmd-main';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toMain = (kind, payload) => window.postMessage({ source: SRC_IN, kind, payload }, '*');

  /* ==================== Markdown 解析 ==================== */
  const esc = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function parseFrontMatter(src) {
    const m = src.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { fm: {}, body: src };
    const fm = {};
    m[1].split(/\r?\n/).forEach((line) => {
      const kv = line.match(/^([\w-]+):\s*(.*)$/);
      if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
    });
    return { fm, body: src.slice(m[0].length) };
  }

  // CommonMark 对中文强调不友好：`用**加粗（注）**和` 结尾的 ** 前是标点，会被当普通字符
  function fixCjkEmphasis(md) {
    let fence = null;
    return md.split('\n').map((line) => {
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        return line;
      }
      if (fence || /^( {4}|\t)/.test(line)) return line;
      return line.split(/(`+[^`]*`+)/).map((part, i) => {
        if (i % 2) return part;
        return part
          .replace(/(^|[^\\*])\*\*(?=\S)([^*\n]*?[^\s\\*])\*\*(?!\*)/g, '$1<strong>$2</strong>')
          .replace(/(^|[^\\*])\*(?=[^\s*])([^*\n]*?[^\s\\*])\*(?!\*)/g, '$1<em>$2</em>');
      }).join('');
    }).join('\n');
  }

  /* Markdown → 片段序列 [{type:'html',html} | {type:'img',src,alt}]
     X 文章编辑器只认 h1/h2、段落、列表、引用、粗斜体、链接；h3+ 降为段落，表格/分割线会丢，先在这里降级 */
  function mdToSegments(md) {
    const { fm, body } = parseFrontMatter(md);
    const src = body.replace(/!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g, (_, p) => `![](${encodeURI(p.trim())})`);
    let tokens = window.marked.lexer(fixCjkEmphasis(src));
    const parser = new window.marked.Parser();
    const inline = (toks) => parser.parseInline(toks || []);

    let title = fm.title || '';
    const firstIdx = tokens.findIndex((t) => t.type !== 'space');
    const first = tokens[firstIdx];
    if (first && first.type === 'heading' && first.depth === 1) {
      title = title || first.text.trim();
      tokens = tokens.filter((_, i) => i !== firstIdx);
    }

    const segs = [];
    const addHtml = (h) => {
      if (!h || !h.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s/g, '')) return;
      const last = segs[segs.length - 1];
      if (last && last.type === 'html') last.html += h;
      else segs.push({ type: 'html', html: h });
    };
    const addImg = (s, alt) => segs.push({ type: 'img', src: s, alt: alt || '' });
    const imgInLink = (t) => t.type === 'link' && t.tokens && t.tokens.length === 1 && t.tokens[0].type === 'image';

    for (const t of tokens) {
      switch (t.type) {
        case 'space': break;
        case 'heading': {
          const tag = t.depth === 1 ? 'h1' : 'h2';
          // 走 inline 解析，保留链接/加粗等行内格式；解析不出再退回纯文本
          let inner = '';
          try { if (t.tokens && t.tokens.length) inner = inline(t.tokens); } catch (e) { inner = ''; }
          if (!inner) inner = esc(t.text.replace(/[*_`]/g, ''));
          addHtml(`<${tag}>${inner}</${tag}>`);
          break;
        }
        case 'paragraph': {
          let buf = [];
          const flush = () => { if (buf.length) addHtml(`<p>${inline(buf).trim()}</p>`); buf = []; };
          for (const it of t.tokens) {
            if (it.type === 'image') { flush(); addImg(it.href, it.text); }
            else if (imgInLink(it)) { flush(); addImg(it.tokens[0].href, it.tokens[0].text); }
            else if (it.type === 'html' && /<img\b/i.test(it.raw)) {
              flush();
              const s = it.raw.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
              if (s) addImg(s[1], '');
            } else buf.push(it);
          }
          flush();
          break;
        }
        case 'html': {
          const parts = t.raw.split(/(<img\b[^>]*>)/i);
          for (const p of parts) {
            if (/^<img\b/i.test(p)) {
              const s = p.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
              if (s) addImg(s[1], (p.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1]);
            } else addHtml(p);
          }
          break;
        }
        case 'table': {
          const cell = (c) => inline(c.tokens);
          addHtml(`<p><strong>${t.header.map(cell).join(' ｜ ')}</strong></p>`);
          for (const row of t.rows) addHtml(`<p>${row.map(cell).join(' ｜ ')}</p>`);
          break;
        }
        case 'hr': addHtml('<p>———</p>'); break;
        case 'code': addHtml(`<pre>${esc(t.text)}</pre>`); break;
        default: {
          let html = parser.parse([t]).replace(/<(\/?)h[3-6]\b[^>]*>/gi, '<$1h2>');
          const parts = html.split(/(<img\b[^>]*>)/i);
          for (const p of parts) {
            if (/^<img\b/i.test(p)) {
              const s = p.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
              if (s) addImg(s[1].replace(/&amp;/g, '&'), '');
            } else addHtml(p);
          }
        }
      }
    }
    return { title, fm, segs };
  }

  /* ==================== 图片准备 ==================== */
  const X_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const MAX_BYTES = 5 * 1024 * 1024;
  const EXT_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic' };

  async function decode(blob) {
    try { return await createImageBitmap(blob); } catch (e) {
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } finally { URL.revokeObjectURL(url); }
    }
  }
  async function reencode(blob, type, quality) {
    const bmp = await decode(blob);
    const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
    const scale = Math.min(1, 4096 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const g = c.getContext('2d');
    if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((ok) => c.toBlob(ok, type, quality));
  }

  // 保证 X 能接收：格式 png/jpg/webp/gif，体积 ≤ 5MB（GIF 不动）
  async function prepareImage(file, fallbackName) {
    let blob = file;
    let type = file.type || EXT_MIME[((file.name || '').split('.').pop() || '').toLowerCase()] || '';
    if (!X_TYPES.has(type)) { blob = await reencode(file, 'image/png'); type = 'image/png'; }
    if (type !== 'image/gif' && blob.size > MAX_BYTES) {
      for (const quality of [0.9, 0.8, 0.7, 0.6]) {
        blob = await reencode(file, 'image/jpeg', quality);
        type = 'image/jpeg';
        if (blob.size <= MAX_BYTES) break;
      }
    }
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type] || 'png';
    const base = (file.name || fallbackName || 'image').replace(/\.[^.]+$/, '');
    return new File([blob], `${base}.${ext}`, { type });
  }

  /* ==================== 面板 UI ==================== */
  const host = document.createElement('div');
  host.id = 'xmd-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;display:none;';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
<style>
  * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif; }
  .fab {
    position: fixed; right: 18px; bottom: 88px; height: 46px; padding: 0 21px 0 17px; border-radius: 999px;
    background: #f2f2f2; color: #0b0b0b; font-size: 14.5px; font-weight: 700; white-space: nowrap;
    display: flex; align-items: center; gap: 8px; cursor: pointer;
    box-shadow: 0 6px 22px rgba(0,0,0,.3); user-select: none;
    transition: transform .15s, background .15s;
  }
  .fab:hover { background: #e4e4e4; transform: translateY(-1px); }
  .fab.hide { display: none; }
  .fab svg { width: 17px; height: 17px; display: block; flex: none; }
  .panel {
    position: fixed; right: 18px; bottom: 88px; width: 380px; max-height: 76vh; overflow: auto;
    background: #fff; color: #0f1419; border: 1px solid #e1e8ed; border-radius: 14px;
    box-shadow: 0 12px 40px rgba(0,0,0,.22); padding: 14px; display: none;
  }
  .panel.open { display: block; }
  .hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .hd h3 { margin: 0; font-size: 14px; font-weight: 700; }
  .hd .x { cursor: pointer; color: #536471; font-size: 18px; line-height: 1; padding: 0 4px; }
  textarea {
    width: 100%; height: 150px; resize: vertical; padding: 9px 10px; font-size: 12.5px;
    line-height: 1.55; border: 1px solid #cfd9de; border-radius: 9px; outline: none;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #0f1419; background: #fff;
  }
  textarea:focus { border-color: #1d9bf0; }
  .drop {
    margin-top: 8px; padding: 12px; border: 1.5px dashed #cfd9de; border-radius: 9px;
    text-align: center; font-size: 12px; color: #536471; cursor: pointer; transition: .15s;
  }
  .drop.over { border-color: #1d9bf0; background: #e8f5fe; color: #1d9bf0; }
  .drop b { color: #0f1419; font-weight: 600; }
  .row { display: flex; gap: 8px; margin-top: 9px; }
  button {
    flex: 1; padding: 8px 10px; font-size: 12.5px; font-weight: 600; border-radius: 8px;
    border: 1px solid #cfd9de; background: #fff; color: #0f1419; cursor: pointer;
  }
  button:hover { background: #f7f9f9; }
  button.primary { background: #1d9bf0; border-color: #1d9bf0; color: #fff; }
  button.primary:hover { background: #1a8cd8; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #cancel { flex: 0 0 84px; }
  #cancel[hidden] { display: none; }
  .meta { margin-top: 9px; font-size: 11.5px; color: #536471; line-height: 1.6; }
  .imgs { margin-top: 9px; max-height: 132px; overflow: auto; border-radius: 8px; }
  .img {
    display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: 6px;
    font-size: 11.5px; background: #f7f9f9; margin-bottom: 4px;
  }
  .img img { width: 26px; height: 26px; object-fit: cover; border-radius: 4px; flex: none; }
  .img .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #0f1419; }
  .img .st { flex: none; color: #00a35c; }
  .img .st.no { color: #f4212e; }
  .img .rm { flex: none; cursor: pointer; color: #536471; padding: 0 3px; }
  .bar { height: 4px; background: #eff3f4; border-radius: 3px; overflow: hidden; margin-top: 9px; }
  .bar i { display: block; height: 100%; width: 0; background: #1d9bf0; transition: width .25s; }
  .msg { margin-top: 8px; font-size: 11.5px; line-height: 1.6; color: #536471; }
  .msg.err { color: #f4212e; }
  .msg.ok { color: #00a35c; }
  .hint { margin-top: 8px; font-size: 11px; color: #8b98a5; line-height: 1.6; }
  .tip { margin-bottom: 10px; padding: 8px 10px; border-radius: 8px; font-size: 11.5px;
    line-height: 1.6; background: #e8f5fe; border: 1px solid #cfe9fb; color: #0f5c8c; }
  .tip b { font-weight: 700; }
  .tip.warn { background: #fdeceb; border-color: #f8c9c5; color: #b3261e; }
  .tip.ok { background: #e7f8ef; border-color: #c6ecd9; color: #0a6b41; }
  .diag { margin-top: 8px; }
  .diag button { flex: none; width: 100%; font-size: 11px; font-weight: 500; color: #536471; }
  .finish {
    position: fixed; inset: 0; z-index: 3; display: flex; align-items: flex-start; justify-content: center;
    padding-top: clamp(70px, 14vh, 150px); pointer-events: none; opacity: 0;
    transition: opacity .2s ease;
  }
  .finish.show { opacity: 1; }
  .finish.out { opacity: 0; }
  .finish-glow {
    position: absolute; top: 8vh; width: 420px; height: 180px; border-radius: 50%;
    background: radial-gradient(ellipse, rgba(0, 186, 124, .34), rgba(29, 155, 240, .12) 45%, transparent 72%);
    filter: blur(24px); opacity: 0;
  }
  .finish.show .finish-glow { animation: finish-glow .9s ease-out both; }
  .finish-card {
    position: relative; display: flex; align-items: center; gap: 12px; min-width: 218px;
    padding: 12px 18px 12px 12px; border-radius: 16px; color: #fff;
    background: linear-gradient(135deg, #0b1117 0%, #101d22 100%);
    border: 1px solid rgba(255, 255, 255, .13);
    box-shadow: 0 18px 55px rgba(0, 0, 0, .34), 0 0 0 1px rgba(0, 186, 124, .08);
    transform: translateY(14px) scale(.92); opacity: 0;
  }
  .finish.show .finish-card { animation: finish-pop .56s cubic-bezier(.2, .9, .22, 1.18) both; }
  .finish.out .finish-card { animation: finish-out .24s ease-in both; }
  .finish-icon {
    width: 42px; height: 42px; flex: none; border-radius: 13px; display: grid; place-items: center;
    background: #00ba7c; box-shadow: 0 0 0 7px rgba(0, 186, 124, .12), 0 8px 22px rgba(0, 186, 124, .28);
  }
  .finish-icon svg { width: 24px; height: 24px; overflow: visible; }
  .finish-icon path {
    fill: none; stroke: #fff; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round;
    stroke-dasharray: 26; stroke-dashoffset: 26;
  }
  .finish.show .finish-icon path { animation: finish-check .42s .16s cubic-bezier(.65, 0, .35, 1) forwards; }
  .finish-copy { display: flex; flex-direction: column; gap: 2px; white-space: nowrap; }
  .finish-copy strong { font-size: 15px; line-height: 1.25; font-weight: 750; letter-spacing: .01em; }
  .finish-copy small { color: #a8b8c2; font-size: 11.5px; line-height: 1.35; }
  .finish.is-warn .finish-icon { background: #f59e0b; box-shadow: 0 0 0 7px rgba(245, 158, 11, .13), 0 8px 22px rgba(245, 158, 11, .25); }
  .finish.is-warn .finish-glow {
    background: radial-gradient(ellipse, rgba(245, 158, 11, .28), rgba(255, 107, 107, .08) 48%, transparent 72%);
  }
  .finish-bits { position: absolute; left: 50%; top: 33px; width: 0; height: 0; }
  .finish-bits i {
    position: absolute; left: 0; top: 0; width: 7px; height: 12px; border-radius: 2px;
    background: var(--c); opacity: 0;
  }
  .finish.show .finish-bits i {
    animation: finish-burst .92s var(--delay) cubic-bezier(.1, .72, .2, 1) both;
  }
  @keyframes finish-pop {
    0% { opacity: 0; transform: translateY(14px) scale(.92); }
    60% { opacity: 1; transform: translateY(-2px) scale(1.018); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes finish-out {
    to { opacity: 0; transform: translateY(-7px) scale(.97); }
  }
  @keyframes finish-check { to { stroke-dashoffset: 0; } }
  @keyframes finish-glow {
    0% { opacity: 0; transform: scale(.72); }
    42% { opacity: 1; }
    100% { opacity: 0; transform: scale(1.22); }
  }
  @keyframes finish-burst {
    0% { opacity: 0; transform: translate(-50%, -50%) rotate(0) scale(.35); }
    9% { opacity: 1; }
    100% {
      opacity: 0;
      transform: translate(calc(-50% + var(--x)), calc(-50% + var(--y))) rotate(var(--r)) scale(var(--s));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .finish, .finish-card, .finish-icon path, .finish-glow, .finish-bits i { animation: none !important; transition: none !important; }
    .finish.show .finish-card { opacity: 1; transform: none; }
    .finish.show .finish-icon path { stroke-dashoffset: 0; }
    .finish-bits { display: none; }
  }
</style>
<div class="fab" id="fab"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg><span>导入 Markdown</span></div>
<div class="panel" id="panel">
  <div class="hd"><h3>Markdown → X 文章</h3><span class="x" id="close">×</span></div>
  <div class="tip" id="tip"></div>
  <textarea id="md" placeholder="把 Markdown 粘到这里（⌘V）&#10;或者把 .md 文件拖进下面的框"></textarea>
  <div class="drop" id="drop">
    <div><b>拖入 .md 文件 / 图片文件夹</b></div>
    <div style="margin-top:3px">或点击选择（支持多选）</div>
  </div>
  <input type="file" id="fileMd" accept=".md,.markdown,.txt" hidden>
  <input type="file" id="fileAny" multiple accept=".md,.markdown,.txt,image/*" hidden>
  <input type="file" id="fileDir" webkitdirectory hidden>
  <div class="row">
    <button id="pickMd">选 .md</button>
    <button id="pickImg">选图片</button>
    <button id="clearImg">清空图片</button>
  </div>
  <div class="imgs" id="imgs"></div>
  <div class="bar"><i id="pb"></i></div>
  <div class="row">
    <button class="primary" id="go">导入到当前编辑器</button>
    <button id="cancel" hidden>中断</button>
  </div>
  <div class="msg" id="msg"></div>
  <div class="hint">本扩展只写你当前打开的那篇文章：不会新建草稿、不会覆盖已有标题，也只会在文章页出现。</div>
  <div class="diag"><button id="probe">定位失败？点这里导出诊断信息</button></div>
</div>
<div class="finish" id="finish" role="status" aria-live="polite" aria-atomic="true">
  <div class="finish-glow"></div>
  <div class="finish-card">
    <span class="finish-icon">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>
    </span>
    <span class="finish-copy">
      <strong id="finishTitle"></strong>
      <small id="finishDetail"></small>
    </span>
    <span class="finish-bits" id="finishBits" aria-hidden="true"></span>
  </div>
</div>`;

  const $ = (s) => shadow.querySelector('#' + s);
  document.documentElement.appendChild(host);

  /* ---------- 状态 ---------- */
  let queue = [];       // 用户提供的图片文件 [{name, file, url}]
  let mdFiles = [];     // 拖入的 md 文件
  let busy = false;
  let aborted = false;  // 本次导入是否被用户中断

  /* ---------- 图片队列渲染 ---------- */
  function renderQueue() {
    const box = $('imgs');
    if (!queue.length) { box.innerHTML = '<div class="hint">图片会自动按 Markdown 里的顺序匹配。也可以直接 ⌘V 粘贴图片。</div>'; return; }
    box.innerHTML = queue.map((it, i) =>
      `<div class="img"><img src="${it.url}"><span class="nm">${esc(it.name)}</span><span class="st" data-i="${i}">待用</span><span class="rm" data-rm="${i}">✕</span></div>`
    ).join('');
    box.querySelectorAll('[data-rm]').forEach((el) => el.addEventListener('click', () => {
      const i = +el.dataset.rm;
      URL.revokeObjectURL(queue[i].url);
      queue.splice(i, 1);
      renderQueue();
    }));
  }

  function addFiles(files) {
    let added = 0;
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      queue.push({ name: f.name || `paste-${queue.length + 1}.png`, file: f, url: URL.createObjectURL(f) });
      added++;
    }
    renderQueue();
    if (added) msg(`+${added} 张图`, 'ok');
  }

  const msg = (t, cls = '') => { const el = $('msg'); el.className = 'msg ' + cls; el.textContent = t; };
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let finishTimer = 0;
  let closeTimer = 0;

  function celebrate(r) {
    const failed = (r && r.failed) || [];
    const hasFailed = failed.length > 0;
    const title = $('finishTitle');
    const detail = $('finishDetail');
    const box = $('finishBits');
    const finish = $('finish');

    title.textContent = '导入完成';
    detail.textContent = hasFailed
      ? `第 ${failed.join('、')} 张图片需要重试`
      : r && r.hadText ? '已追加到当前文章' : '文章已写入编辑器';
    finish.classList.toggle('is-warn', hasFailed);
    finish.classList.remove('show', 'out');
    box.replaceChildren();
    void finish.offsetWidth;

    if (!hasFailed && !(reduceMotion && reduceMotion.matches)) {
      const colors = ['#00ba7c', '#1d9bf0', '#ffd400', '#ff6b6b', '#ffffff'];
      for (let i = 0; i < 28; i++) {
        const angle = (Math.PI * 2 * i) / 28 + (Math.random() - 0.5) * 0.28;
        const distance = 58 + Math.random() * 92;
        const bit = document.createElement('i');
        bit.style.setProperty('--x', `${Math.cos(angle) * distance}px`);
        bit.style.setProperty('--y', `${Math.sin(angle) * distance - 22}px`);
        bit.style.setProperty('--r', `${Math.round((Math.random() - 0.5) * 540)}deg`);
        bit.style.setProperty('--s', (0.65 + Math.random() * 0.85).toFixed(2));
        bit.style.setProperty('--c', colors[i % colors.length]);
        bit.style.setProperty('--delay', `${Math.round(Math.random() * 90)}ms`);
        bit.style.height = `${8 + Math.round(Math.random() * 8)}px`;
        box.appendChild(bit);
      }
    }

    finish.classList.add('show');
    clearTimeout(closeTimer);
    if (!hasFailed) closeTimer = setTimeout(closePanel, 700);
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      finish.classList.add('out');
      finishTimer = setTimeout(() => finish.classList.remove('show', 'out'), 260);
    }, 2600);
  }

  // 导入中的 UI 状态：主按钮禁用 + 出现「中断」
  function setBusyUI(v) { $('go').disabled = v; $('cancel').hidden = !v; }

  /* ---------- 图片解析：把 md 里的引用落到文件 ---------- */
  const basename = (p) => String(p).split(/[\\/]/).pop();
  const norm = (p) => String(p).replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();

  function resolveLocal(src) {
    const want = norm(decodeURIComponent(String(src).replace(/[?#].*$/, '')));
    const wantBase = basename(want);
    // 1) 全路径匹配 2) 只匹配文件名
    let hit = queue.find((q) => norm(q.name) === want);
    if (!hit) hit = queue.find((q) => basename(norm(q.name)) === wantBase);
    return hit ? hit.file : null;
  }

  async function fetchRemote(url) {
    // 交给后台代抓（有 host_permissions，绕 CORS）
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'xmd:fetch', url }, (r) => {
          if (chrome.runtime.lastError || !r || !r.ok) resolve(null);
          else resolve(r.dataUrl);
        });
      } catch (e) { resolve(null); }
    });
  }

  /* ---------- 组装并导入 ---------- */
  async function buildPayload() {
    const text = $('md').value;
    if (!text.trim()) throw new Error('先粘一段 Markdown，或拖入 .md 文件。');
    const { title, segs } = mdToSegments(text);

    const prefix = 'XMDIMG' + Math.random().toString(36).slice(2, 8).toUpperCase() + '_';
    const images = [];
    let html = '';
    const missing = [];

    for (const seg of segs) {
      if (aborted) throw new Error('已中断');
      if (seg.type === 'html') { html += seg.html; continue; }
      const n = images.length + missing.length + 1;
      let file = null;
      const src = String(seg.src || '');
      if (/^data:/i.test(src)) {
        try {
          const blob = await (await fetch(src)).blob();
          file = await prepareImage(new File([blob], `inline-${n}.png`, { type: blob.type }), `inline-${n}`);
        } catch (e) { /* ignore */ }
      } else if (/^https?:/i.test(src)) {
        const dataUrl = await fetchRemote(src);
        if (dataUrl) {
          try {
            const blob = await (await fetch(dataUrl)).blob();
            file = await prepareImage(new File([blob], basename(src) || `remote-${n}.png`, { type: blob.type }), `remote-${n}`);
          } catch (e) { /* ignore */ }
        }
      } else {
        const local = resolveLocal(src);
        if (local) file = await prepareImage(local, `local-${n}`);
      }

      if (!file) { missing.push({ n, src }); continue; }
      const marker = prefix + n;
      html += `<p>${marker}</p>`;
      images.push({ marker, file, n });
    }

    const div = document.createElement('div');
    div.innerHTML = html;
    return { html, plain: div.innerText, images, prefix, title, setTitleOn: true, missing };
  }

  /* ---------- 监听 MAIN world ---------- */
  function runMain(payload, onProgress) {
    return new Promise((resolve, reject) => {
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.source !== SRC_OUT) return;
        const d = e.data;
        if (d.kind === 'progress') onProgress(d.msg, d.p);
        else if (d.kind === 'note' && d.msg) onProgress(d.msg, null);
        else if (d.kind === 'done') { window.removeEventListener('message', onMsg); resolve(d); }
        else if (d.kind === 'error') { window.removeEventListener('message', onMsg); reject(new Error(d.error)); }
      };
      window.addEventListener('message', onMsg);
      toMain('run', payload);
      setTimeout(() => { window.removeEventListener('message', onMsg); reject(new Error('等待超时（编辑器无响应）')); }, 10 * 60 * 1000);
    });
  }

  async function doImport() {
    if (busy) return;
    busy = true;
    aborted = false;
    setBusyUI(true);
    $('pb').style.width = '0%';
    msg('准备中…');
    try {
      const payload = await buildPayload();
      if (aborted) throw new Error('已中断');
      if (payload.missing.length) {
        msg(`有 ${payload.missing.length} 张图没找到，先跳过：${payload.missing.map((m) => basename(m.src)).join('、')}`, 'err');
      }
      const r = await runMain(payload, (t, p) => {
        msg(t);
        if (p != null) $('pb').style.width = Math.round(p * 100) + '%';
      });
      if (aborted) throw new Error('已中断');
      $('pb').style.width = '100%';
      const parts = ['✓ 已写入当前编辑器，X 会自动保存'];
      if (r && r.hadText) parts.push('（编辑器里原有内容，本次是追加）');
      if (r && r.failed && r.failed.length) parts.push(`\n有 ${r.failed.length} 张图没插进去：第 ${r.failed.join('、')} 张`);
      msg(parts.join(' '), r && r.failed && r.failed.length ? 'err' : 'ok');
      celebrate(r);
    } catch (e) {
      const isAbort = aborted || /已中断/.test(e.message || '');
      $('pb').style.width = isAbort ? '0%' : '0%';
      msg(isAbort ? '已中断。编辑器里已写入的内容会保留，占位段已清理。' : '导入中断：' + e.message, isAbort ? '' : 'err');
    } finally {
      busy = false;
      aborted = false;
      setBusyUI(false);
    }
  }

  /* ==================== 事件 ==================== */
  const openPanel = () => { $('panel').classList.add('open'); $('fab').classList.add('hide'); refreshTip(); };
  const closePanel = () => { $('panel').classList.remove('open'); $('fab').classList.remove('hide'); };
  $('fab').addEventListener('click', openPanel);
  $('close').addEventListener('click', closePanel);

  // 面板内粘贴图片
  shadow.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  // 全页拖拽
  const drop = $('drop');
  drop.addEventListener('click', () => $('fileAny').click());
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));

  async function intakeFileList(files) {
    const list = [...files];
    const mds = list.filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    const imgs = list.filter((f) => f.type.startsWith('image/'));
    if (imgs.length) addFiles(imgs);
    if (mds.length) {
      const f = mds[0];
      $('md').value = await f.text();
      msg(`已载入 ${f.name}（${mds.length > 1 ? `另有 ${mds.length - 1} 个 .md 未载入` : ''}）`, 'ok');
    }
    if (!mds.length && !imgs.length) msg('没识别到 .md 或图片文件', 'err');
  }

  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    // 支持拖入文件夹
    const items = [...(e.dataTransfer.items || [])];
    const entries = items.map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (entries.length) {
      const files = [];
      const walk = async (entry) => {
        if (entry.isFile) files.push(await new Promise((ok, no) => entry.file(ok, no)));
        else if (entry.isDirectory) {
          const reader = entry.createReader();
          const all = await new Promise((ok) => { const acc = []; const next = () => reader.readEntries((b) => { if (!b.length) return ok(acc); acc.push(...b); next(); }); next(); });
          for (const en of all) await walk(en);
        }
      };
      for (const en of entries) await walk(en);
      await intakeFileList(files);
    } else {
      await intakeFileList(e.dataTransfer.files);
    }
  });

  $('pickMd').addEventListener('click', () => $('fileMd').click());
  $('fileMd').addEventListener('change', async (e) => { if (e.target.files[0]) { $('md').value = await e.target.files[0].text(); msg('已载入 ' + e.target.files[0].name, 'ok'); } });
  $('pickImg').addEventListener('click', () => $('fileAny').click());
  $('fileAny').addEventListener('change', (e) => intakeFileList(e.target.files));
  $('clearImg').addEventListener('click', () => { queue.forEach((q) => URL.revokeObjectURL(q.url)); queue = []; renderQueue(); msg('图片已清空'); });
  $('go').addEventListener('click', doImport);
  $('cancel').addEventListener('click', () => {
    if (!busy) return;
    aborted = true;
    toMain('cancel');
    msg('正在中断…', '');
  });

  // 诊断 / 页面探测
  function probeEditor() {
    return new Promise((resolve) => {
      const onMsg = (e) => {
        if (e.source !== window || !e.data || e.data.source !== SRC_OUT || e.data.kind !== 'probe-result') return;
        window.removeEventListener('message', onMsg);
        resolve(e.data);
      };
      window.addEventListener('message', onMsg);
      toMain('probe');
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, 3000);
    });
  }

  $('probe').addEventListener('click', async () => {
    msg('正在读取页面结构…');
    const d = await probeEditor();
    if (!d) { msg('没收到编辑器响应，请刷新页面重试', 'err'); return; }
    console.log('[xmd 诊断]', d);
    const txt = JSON.stringify(d, null, 1);
    navigator.clipboard?.writeText(txt).then(
      () => msg('诊断信息已复制到剪贴板，粘给我即可', 'ok'),
      () => msg('诊断信息已打印到 Console（F12）', 'ok'),
    );
  });

  /* ==================== 只在 X 文章页出现 ==================== */
  const ARTICLE_RE = /^\/(?:compose\/articles|i\/articles)(?:\/|$)/;
  const EDIT_URL_RE = /^\/compose\/articles\/edit\//;
  const onArticlePage = () => ARTICLE_RE.test(location.pathname);

  const TIP_CREATE = '先在 X 里<b>手动新建一篇文章</b>（点「Write / 新建文章」），进到编辑页、能看到标题框和正文区后，再点下面的按钮导入。';
  const TIP_LIST = '现在还在文章<b>列表页</b>，这里没有编辑区 —— 请先<b>手动新建一篇文章</b>（或打开一篇草稿），进到编辑页再点导入。';
  const TIP_READY = '已进入文章编辑页，可以导入了。';

  let probed = null;   // null=未探测 / true=页面里已有编辑器 / false=没有
  let probing = false;

  function setTip(kind, html) {
    const el = $('tip');
    if (!el) return;
    el.className = 'tip' + (kind === 'warn' ? ' warn' : kind === 'ok' ? ' ok' : '');
    el.innerHTML = html;
  }

  function applyTip() {
    if (!onArticlePage()) return;
    if (probed === true || EDIT_URL_RE.test(location.pathname)) setTip('ok', TIP_READY);
    else if (probed === false) setTip('warn', TIP_LIST);
    else setTip('', TIP_CREATE);
  }

  async function refreshTip() {
    if (!onArticlePage() || probing) return;
    if (EDIT_URL_RE.test(location.pathname)) { probed = true; applyTip(); return; }
    probing = true;
    try {
      const d = await probeEditor();
      probed = d ? !!d.editorFound : null;
    } finally { probing = false; }
    applyTip();
  }

  let shown = null;
  function syncVisible() {
    const on = onArticlePage();
    if (on === shown) return;
    shown = on;
    host.style.display = on ? 'block' : 'none';
    if (on) { applyTip(); refreshTip(); }
    else { $('panel').classList.remove('open'); $('fab').classList.remove('hide'); }
  }

  // X 是 SPA：切页不刷新、pushState 不触发 popstate，所以盯 URL + 轮询兜底
  ['popstate', 'hashchange'].forEach((ev) => window.addEventListener(ev, () => { syncVisible(); refreshTip(); }));
  let lastHref = location.href;
  setInterval(() => {
    syncVisible();
    if (location.href !== lastHref) { lastHref = location.href; applyTip(); refreshTip(); }
  }, 1000);

  syncVisible();

  renderQueue();
  msg('就绪。');

  // 调试/自测钩子（不影响功能）
  window.__xmd = {
    mdToSegments, parseFrontMatter, fixCjkEmphasis, resolveLocal,
    queue: () => queue,
    busy: () => busy,
    setBusyUI,
    celebrate,
    syncVisible,
    onArticlePage,
    tip: () => { const e = $('tip'); return { cls: e.className, html: e.innerHTML, hostDisplay: host.style.display }; },
    _setPath: (p) => { history.replaceState(null, '', p); syncVisible(); },
    _probe: (v) => { probed = v; applyTip(); },
  };
})();
