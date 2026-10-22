/* MAIN world：直接操作 X 文章编辑器的 Draft.js 实例。
   思路：找到承载 Draft 编辑器的 DOM → 沿 React fiber 拿到 editorState →
   用「合成 paste 事件」把富文本/图片交给 X 自己处理（不碰它的内部 API，改版也不容易挂）。
   与旧插件的关键区别：不新建草稿、不看 URL，只认当前页面上真实存在的编辑器。 */
(() => {
  if (window.__xmdMain__) return;
  window.__xmdMain__ = true;

  const SRC_IN = 'xmd-iso', SRC_OUT = 'xmd-main';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (kind, data = {}) => window.postMessage({ source: SRC_OUT, kind, ...data }, '*');
  const q = (s) => document.querySelector(s);

  /* ==================== 定位 ==================== */

  const fiberKey = (el) => (el ? Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) : null);

  // 沿 fiber 向上找持有 editorState + onChange 的组件实例
  function holderOf(el) {
    if (!el) return null;
    const k = fiberKey(el);
    if (!k) return null;
    let f = el[k];
    for (let i = 0; f && i < 150; i++) {
      const sn = f.stateNode;
      if (sn && sn.props && sn.props.editorState && typeof sn.props.onChange === 'function') return sn;
      f = f.return;
    }
    return null;
  }

  // 编辑器 DOM：先试已知 testid，再退回所有 contenteditable，逐个验 fiber（不依赖单一选择器）
  function editorEl() {
    const list = [];
    const a = q('[data-testid="composer"]');
    if (a) list.push(a);
    document.querySelectorAll('[contenteditable="true"]').forEach((e) => { if (!list.includes(e)) list.push(e); });
    for (const el of list) if (holderOf(el)) return el;
    return null;
  }

  function titleEl() {
    const sels = [
      '[data-testid="twitter-article-title"] textarea',
      '[data-testid="twitter-article-title"] input',
      'textarea[placeholder="Add a title"]',
      'textarea[placeholder="添加标题"]',
      'textarea[placeholder*="title" i]',
      'input[placeholder*="title" i]',
    ];
    for (const s of sels) { const e = q(s); if (e) return e; }
    return null;
  }

  /* ==================== 中断 ==================== */
  let ABORT = false;
  const checkAbort = () => { if (ABORT) { const e = new Error('已中断'); e.aborted = true; throw e; } };

  /* ==================== 等 ==================== */
  async function waitFor(fn, timeout, step = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (ABORT) return null;
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  /* ==================== 编辑器状态 ==================== */
  let HOLDER = null;
  const ES = () => HOLDER.props.editorState;
  const content = () => ES().getCurrentContent();
  const blocks = () => content().getBlockMap();
  const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 图片块身份：上传中 key 会变，用实体里的 localMediaId 认，退回 block key
  function atomId(c, b) {
    try {
      const ek = b.getEntityAt(0);
      const d = ek ? c.getEntity(ek).getData() : null;
      const m = d && d.mediaItems && d.mediaItems[0];
      if (m && m.localMediaId != null) return 'L' + m.localMediaId;
    } catch (e) { /* ignore */ }
    return 'K' + b.getKey();
  }
  function atomMap() {
    const c = content(), out = new Map();
    c.getBlockMap().forEach((b, k) => { if (b.getType() === 'atomic') out.set(atomId(c, b), k); });
    return out;
  }
  const findMarkerBlock = (text) => blocks().find((b) => b.getType() !== 'atomic' && b.getText().trim() === text);

  async function commit(prev, timeout = 2500) {
    await waitFor(() => ES() !== prev, timeout, 25);
  }

  /* ==================== 写入原语 ==================== */
  function pasteEvent(el, dt) {
    if (!el) return;
    try { el.focus(); } catch (e) { /* ignore */ }
    let ev;
    try {
      ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    } catch (e) {
      ev = new Event('paste', { bubbles: true, cancelable: true });
    }
    if (ev.clipboardData !== dt) {
      try { Object.defineProperty(ev, 'clipboardData', { value: dt }); } catch (e) { /* ignore */ }
    }
    el.dispatchEvent(ev);
  }

  function selectEndOf(block) {
    const es = ES();
    const SS = es.getSelection().constructor;
    const len = block.getLength();
    const sel = SS.createEmpty(block.getKey()).merge({ anchorOffset: len, focusOffset: len, hasFocus: true });
    HOLDER.props.onChange(es.constructor.forceSelection(es, sel));
    return es;
  }

  function moveToEnd() {
    const es = ES();
    HOLDER.props.onChange(es.constructor.moveFocusToEnd(es));
    return es;
  }

  function removeBlocks(pred) {
    const es = ES();
    const c = es.getCurrentContent();
    let bm = c.getBlockMap();
    const keys = [];
    bm.forEach((b, k) => { if (b.getType() !== 'atomic' && pred(b)) keys.push(k); });
    if (!keys.length) return null;
    keys.forEach((k) => { bm = bm.delete(k); });
    if (!bm.size) return null;
    const SS = es.getSelection().constructor;
    const sel = SS.createEmpty(bm.last().getKey());
    const next = c.set('blockMap', bm).set('selectionBefore', sel).set('selectionAfter', sel);
    HOLDER.props.onChange(es.constructor.moveSelectionToEnd(es.constructor.push(es, next, 'remove-range')));
    return es;
  }

  // 只剔除文本里的占位符；X 若把占位符和正文合并到一段，也不会误删正文
  function stripMarkersFromBlock(block, re) {
    const text = block.getText();
    re.lastIndex = 0;
    if (!re.test(text)) return block;

    const chars = block.getCharacterList();
    let nextText = '';
    let nextChars = null;
    let last = 0;
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(text))) {
      nextText += text.slice(last, match.index);
      const part = chars.slice(last, match.index);
      nextChars = nextChars ? nextChars.concat(part) : part;
      last = match.index + match[0].length;
    }
    nextText += text.slice(last);
    const tail = chars.slice(last);
    nextChars = nextChars ? nextChars.concat(tail) : tail;

    return block.set('text', nextText).set('characterList', nextChars);
  }

  // 把新插入的图片块挪到 marker 段的位置，同时清掉同内容的重复占位段
  function moveInto(atomKey, markerText) {
    const es = ES();
    const c = es.getCurrentContent();
    const bm = c.getBlockMap();
    const mk = findMarkerBlock(markerText);
    const atom = bm.get(atomKey);
    if (!mk || !atom) return null;
    const mKey = mk.getKey();
    if (mKey === atomKey) return null;
    const next = bm.clear().withMutations((m) => {
      bm.forEach((blk, k) => {
        if (k === atomKey) return;
        if (k === mKey) m.set(atomKey, atom);
        else m.set(k, blk);
      });
    });
    const re = new RegExp(escapeRe(markerText), 'g');
    const withDuplicatesRemoved = next.withMutations((m) => {
      next.forEach((blk, k) => {
        if (k === atomKey || blk.getType() === 'atomic') return;
        re.lastIndex = 0;
        if (!re.test(blk.getText())) return;
        const clean = stripMarkersFromBlock(blk, re);
        if (!clean.getText().replace(INVISIBLE_RE, '').trim()) m.delete(k);
        else m.set(k, clean);
      });
    });
    const SS = es.getSelection().constructor;
    const sel = SS.createEmpty(withDuplicatesRemoved.last().getKey());
    const nc = c.set('blockMap', withDuplicatesRemoved).set('selectionBefore', sel).set('selectionAfter', sel);
    HOLDER.props.onChange(es.constructor.push(es, nc, 'insert-fragment'));
    return es;
  }

  /* ==================== X 的忙碌检测 ====================
     X 上传/处理图片期间会吞掉新的图片粘贴，必须等它闲下来再动 */
  const BUSY_RE = /Processing media|Uploading|Cancel upload|正在处理|处理媒体|上传中|正在上传|取消上传/i;
  const mediaBusy = () =>
    !!document.querySelector('[role="progressbar"]') ||
    [...document.querySelectorAll('h2, button, [role="button"]')].some((el) => BUSY_RE.test(el.textContent || ''));

  /* ==================== 插入一张图 ==================== */
  async function insertImage(markerText, file) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (ABORT) return false;
      await waitFor(() => !mediaBusy(), 90000, 250);
      if (ABORT) return false;
      const mk = findMarkerBlock(markerText);
      if (!mk) return false;
      const known = new Set(atomMap().keys());
      const prev = selectEndOf(mk);
      await commit(prev);
      await sleep(80);

      const dt = new DataTransfer();
      dt.items.add(file);
      pasteEvent(editorEl(), dt);

      const newId = () => [...atomMap().keys()].find((id) => !known.has(id));
      let id = await waitFor(newId, 25000, 120);
      // X 处理完前别动编辑器，否则会被它的异步回调覆盖
      await waitFor(() => !mediaBusy(), 90000, 250);
      await sleep(900);
      id = id || newId();
      if (id) {
        const key = atomMap().get(id);
        const p = key && moveInto(key, markerText);
        if (p) await commit(p);
        await sleep(250);
        return true;
      }
    }
    return false;
  }

  function removeEmptyBlocks() {
    const c = content();
    const lastKey = c.getBlockMap().last().getKey();
    return removeBlocks((b) => !b.getText().trim() && b.getType() === 'unstyled' && b.getKey() !== lastKey);
  }

  /* ==================== 主流程 ==================== */
  async function run({ html, plain, images, prefix, title, setTitleOn }) {
    post('progress', { msg: '定位编辑器…', p: 0.03 });

    const el = await waitFor(editorEl, 25000, 200);
    checkAbort();
    if (!el) {
      throw new Error('找不到 X 文章编辑器。请先打开一篇文章的编辑页（能看到标题框 + 正文输入区），再点导入。');
    }
    HOLDER = holderOf(el);
    if (!HOLDER) throw new Error('读不到编辑器实例，请刷新页面后重试。');

    const hadText = content().hasText();

    // ---- 标题 ----
    checkAbort();
    if (setTitleOn && title) {
      const tb = titleEl();
      if (tb) {
        if (!tb.value.trim()) {
          const proto = tb instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(tb, title);
          tb.dispatchEvent(new Event('input', { bubbles: true }));
          post('note', { msg: '标题已填入' });
        } else {
          post('note', { msg: '标题框已有内容，未覆盖' });
        }
      } else {
        post('note', { msg: '没找到标题框，只导入正文' });
      }
      await sleep(300);
    }

    // ---- 正文 ----
    post('progress', { msg: '写入正文…', p: 0.08 });
    const prev = moveToEnd();
    await commit(prev);
    await sleep(120);

    const rich = `<meta charset="utf-8">${html}`;
    const dt = new DataTransfer();
    try { dt.setData('text/html', rich); } catch (e) { /* ignore */ }
    try { dt.setData('text/plain', plain); } catch (e) { /* ignore */ }
    pasteEvent(editorEl(), dt);

    const markerCount = () => images.filter((im) => findMarkerBlock(im.marker)).length;
    const landed = await waitFor(
      () => (images.length ? markerCount() === images.length : content().hasText()),
      12000, 120,
    );
    if (!landed && !content().hasText()) {
      throw new Error('正文没写进去。请刷新页面重试；若编辑器里已有内容，请先清空再导入。');
    }

    // ---- 图片 ----
    const failed = [];
    try {
      for (let i = 0; i < images.length; i++) {
        checkAbort();
        const im = images[i];
        post('progress', { msg: `插入图片 ${i + 1} / ${images.length}…`, p: 0.1 + 0.85 * (i / Math.max(images.length, 1)) });
        const good = await insertImage(im.marker, im.file);
        if (!good) failed.push(im.n);
      }
    } catch (e) {
      // 用户中断：清掉还没插成功的占位段，已写入的正文/图片保留
      try {
        const p0 = removeBlocks((b) => b.getText().trim().startsWith(prefix));
        if (p0) await commit(p0, 1500);
      } catch (_) { /* ignore */ }
      throw e;
    }
    images.forEach((im) => { if (findMarkerBlock(im.marker) && !failed.includes(im.n)) failed.push(im.n); });
    failed.sort((a, b) => a - b);

    // ---- 收尾：清掉没插成功的占位段和 X 留下的空段 ----
    let p = removeBlocks((b) => b.getText().trim().startsWith(prefix));
    if (p) await commit(p);
    p = removeEmptyBlocks();
    if (p) await commit(p);
    await waitFor(() => !mediaBusy(), 90000, 250);
    await sleep(1200); // 让 X 自动保存一下

    return { failed, hadText };
  }

  /* ==================== 消息桥 ==================== */
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== SRC_IN) return;
    const d = e.data;

    if (d.kind === 'ping') { post('pong'); return; }

    if (d.kind === 'cancel') { ABORT = true; return; }

    if (d.kind === 'probe') {
      const el = editorEl();
      const tb = titleEl();
      post('probe-result', {
        url: location.href,
        editorFound: !!el,
        editorDesc: el ? `${el.tagName}[testid=${el.getAttribute('data-testid') || '-'}]` : null,
        titleFound: !!tb,
        titleDesc: tb ? `${tb.tagName}[ph=${tb.placeholder || '-'}]` : null,
        editables: document.querySelectorAll('[contenteditable="true"]').length,
        testids: [...new Set([...document.querySelectorAll('[data-testid]')].map((x) => x.getAttribute('data-testid')))]
          .filter((x) => /article|composer|draft|title|editor|cover/i.test(x)),
      });
      return;
    }

    if (d.kind === 'run') {
      ABORT = false;
      run(d.payload)
        .then((r) => post('done', r))
        .catch((err) => post('error', { error: String((err && err.message) || err), aborted: !!(err && err.aborted) }));
    }
  });

  post('pong');

  // 调试/自测钩子
  window.__xmdMainAPI = {
    editorEl, holderOf, titleEl, fiberKey, waitFor,
    abortState: () => ABORT,
    setAbort: (v) => { ABORT = !!v; },
  };
})();
