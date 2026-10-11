/* 后台 Service Worker：代抓远程图片。
   content script 里的 fetch 受页面 CORS 限制，放进后台（有 host_permissions）就能直接拉。 */
const MAX_REMOTE = 20 * 1024 * 1024; // 20MB 上限，避免超大文件把消息撑爆

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'xmd:fetch' || !msg.url) return;

  (async () => {
    try {
      const res = await fetch(msg.url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'follow',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (blob.size > MAX_REMOTE) throw new Error('文件过大（' + Math.round(blob.size / 1048576) + 'MB）');

      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
      sendResponse({ ok: true, dataUrl: `data:${type};base64,${btoa(bin)}` });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();

  return true; // 异步响应
});
