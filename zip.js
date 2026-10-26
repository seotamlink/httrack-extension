/*
 * zip.js — Gom file vào ZIP, tạo report.txt và manifest.json.
 * - ZipClient (chạy trong service worker): gửi từng file sang offscreen document ngay khi tải xong
 * - ZipSink (chạy trong offscreen document): giữ JSZip, tạo Blob URL bằng streamFiles
 * - Report: thu thập mọi thông tin để ghi report.txt
 */

const CHUNK = 12 * 1024 * 1024; // gửi file lớn theo từng khúc 12MB

function bytesToB64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(bin);
}

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Tạo Blob URL cho file ZIP vì service worker không có URL.createObjectURL'
  });
}

async function call(msg) {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Offscreen không phản hồi');
  return res;
}

// ===== Phía service worker =====
export class ZipClient {
  constructor() { this.chain = Promise.resolve(); this.fileCount = 0; this.totalBytes = 0; }

  async init() {
    await ensureOffscreen();
    await call({ type: 'zip-init' });
    this.fileCount = 0;
    this.totalBytes = 0;
  }

  // data: string (UTF-8) hoặc Uint8Array. Các lệnh được tuần tự hóa để không lẫn khúc
  addFile(path, data, { compress = false } = {}) {
    const run = async () => {
      if (typeof data === 'string') {
        await call({ type: 'zip-add', path, text: data, compress, last: true });
        this.totalBytes += data.length;
      } else {
        for (let off = 0; off < data.length || off === 0; off += CHUNK) {
          const part = data.subarray(off, Math.min(off + CHUNK, data.length));
          await call({ type: 'zip-add', path, b64: bytesToB64(part), compress, append: off > 0, last: off + CHUNK >= data.length });
          if (data.length === 0) break;
        }
        this.totalBytes += data.length;
      }
      this.fileCount++;
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => {});
    return p;
  }

  async finalize() {
    await this.chain;
    const r = await call({ type: 'zip-finalize' });
    return { url: r.url, size: r.size };
  }

  async dispose() {
    try { await call({ type: 'zip-dispose' }); } catch { /* bỏ qua */ }
    try { await chrome.offscreen.closeDocument(); } catch { /* đã đóng */ }
  }
}

// ===== Phía offscreen document =====
export class ZipSink {
  constructor(JSZipCtor) {
    this.JSZip = JSZipCtor;
    this.reset();
  }
  reset() {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.zip = new this.JSZip();
    this.partial = new Map(); // path -> mảng khúc
  }
  add({ path, text, b64, compress, append, last }) {
    const opts = {
      createFolders: false,
      compression: compress ? 'DEFLATE' : 'STORE',
      compressionOptions: { level: 6 }
    };
    if (typeof text === 'string') { this.zip.file(path, text, opts); return; }
    const bin = atob(b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!append && last) { this.zip.file(path, bytes, opts); return; }
    if (!append) this.partial.set(path, []);
    const parts = this.partial.get(path);
    parts.push(bytes);
    if (last) {
      const total = parts.reduce((n, p) => n + p.length, 0);
      const all = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      this.partial.delete(path);
      this.zip.file(path, all, opts);
    }
  }
  async finalize() {
    const blob = await this.zip.generateAsync({ type: 'blob', streamFiles: true, platform: 'UNIX' });
    this.url = URL.createObjectURL(blob);
    return { url: this.url, size: blob.size };
  }
}

// ===== Trang gộp: một file index.html hiện bản responsive hoặc mobile theo độ rộng cửa sổ =====
export function buildLauncher({ rootUrl, responsive, mobile, breakpoint = 768 }) {
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const r = enc(responsive);
  const m = enc(mobile);
  const title = rootUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bản lưu offline - ${title}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{position:fixed;top:0;left:0;width:100%;height:100%;border:0}iframe[hidden]{display:none}</style>
</head>
<body>
<iframe id="wide" title="Bản responsive" hidden></iframe>
<iframe id="narrow" title="Bản mobile" hidden></iframe>
<noscript><p><a href="${r}">Bản Responsive</a> | <a href="${m}">Bản Mobile</a></p></noscript>
<script>
(function () {
  var src = { wide: ${JSON.stringify(r)}, narrow: ${JSON.stringify(m)} };
  var mq = window.matchMedia('(max-width: ${breakpoint}px)');
  var q = location.search.match(/[?&]v=(mobile|responsive)/);
  function show() {
    var narrow = q ? q[1] === 'mobile' : mq.matches;
    ['wide', 'narrow'].forEach(function (k) {
      var f = document.getElementById(k);
      var on = (k === 'narrow') === narrow;
      if (on && !f.getAttribute('src')) f.setAttribute('src', src[k]); // chỉ tải bản đang cần, đổi qua lại không tải lại
      f.hidden = !on;
    });
  }
  show();
  if (!q) (mq.addEventListener ? mq.addEventListener('change', show) : mq.addListener(show));
})();
</script>
</body>
</html>
`;
}

// ===== Report =====
export class Report {
  constructor(meta) {
    this.meta = meta;
    this.pagesSaved = [];
    this.pagesSkipped = [];
    this.resOk = [];
    this.resFail = [];
    this.resSkipped = [];
    this.scripts = [];
    this.unresolved = [];
    this.notes = [];
    this.queryMap = [];
    this.skipKeys = new Set();
  }
  note(s) { this.notes.push(s); console.log('[HTTrack]', s); }
  skipPage(device, url, reason) {
    const k = device + '|' + url + '|' + reason;
    if (this.skipKeys.has(k) || this.pagesSkipped.length > 5000) return;
    this.skipKeys.add(k);
    this.pagesSkipped.push({ device, url, reason });
  }

  text() {
    const m = this.meta;
    const L = [];
    const sec = (t) => { L.push('', '=== ' + t + ' ==='); };
    L.push('HTTrack Extension VN - BÁO CÁO');
    L.push('URL gốc: ' + m.rootUrl);
    L.push('Bắt đầu: ' + m.startedAt.toISOString());
    L.push('Kết thúc: ' + (m.finishedAt || new Date()).toISOString());
    L.push('Thiết bị: ' + m.devices.join(', '));
    L.push('Chế độ: ' + (m.config.mode === 'mirror' ? 'Mirror website' : 'Chỉ trang hiện tại'));
    L.push(`Cấu hình: maxDepth=${m.config.maxDepth}, maxPages=${m.config.maxPages}, sameHostOnly=${!m.config.includeSub}, ` +
      `bao gồm subdomain=${m.config.includeSub}, delayBetweenPagesMs=${m.config.delay}, respectRobotsTxt=${m.config.robots}`);
    if (m.cancelled) L.push('TRẠNG THÁI: Đã hủy, lưu phần đã hoàn thành');
    if (m.limitHit) L.push('CẢNH BÁO: Vượt giới hạn 1GB, đã dừng và đóng gói phần đã tải được');
    if (m.error) L.push('LỖI: ' + m.error);
    if (this.notes.length) { sec('Ghi chú'); this.notes.forEach((n) => L.push('- ' + n)); }

    sec(`Trang đã lưu (${this.pagesSaved.length})`);
    this.pagesSaved.forEach((p) => L.push(`[${p.device}] depth ${p.depth} | ${p.url} -> ${p.file}`));
    if (this.queryMap.length) {
      sec('Ánh xạ URL có query string -> file');
      this.queryMap.forEach((q) => L.push(`[${q.device}] ${q.url} -> ${q.file}`));
    }
    sec(`Trang / link bị bỏ qua (${this.pagesSkipped.length})`);
    this.pagesSkipped.forEach((p) => L.push(`[${p.device}] ${p.url} | ${p.reason}`));

    sec(`Tài nguyên thành công (${this.resOk.length})`);
    this.resOk.forEach((r) => L.push(`[${r.device}] ${r.local}  <-  ${r.url}`));
    sec(`Tài nguyên thất bại (${this.resFail.length})`);
    this.resFail.forEach((r) => L.push(`[${r.device}] ${r.url} | ${r.reason}`));
    sec(`Tài nguyên bị bỏ qua (${this.resSkipped.length})`);
    this.resSkipped.forEach((r) => L.push(`[${r.device}] ${r.url} | ${r.reason}`));

    sec('Script đã xóa theo trang');
    this.scripts.forEach((s) => L.push(`[${s.device}] ${s.url} | ${s.count} thẻ script${s.extra ? ' | ' + s.extra : ''}`));
    sec(`Link nội bộ chưa được viết lại vì trang đích không lưu được (${this.unresolved.length})`);
    this.unresolved.forEach((u) => L.push(`[${u.device}] ${u.page} -> ${u.target}`));
    return L.join('\n') + '\n';
  }

  manifest() {
    return JSON.stringify({
      rootUrl: this.meta.rootUrl,
      createdAt: (this.meta.finishedAt || new Date()).toISOString(),
      pages: this.pagesSaved.map((p) => ({ url: p.url, device: p.device, file: p.file, depth: p.depth }))
    }, null, 2);
  }
}
