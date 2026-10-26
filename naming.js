/*
 * naming.js — Đặt tên file cục bộ cho trang HTML và tài nguyên.
 * - sanitize tên, giới hạn độ dài, hash SHA-1 (đồng bộ) để chống trùng tên
 * - xử lý trùng tên không phân biệt hoa thường (Windows)
 * - ánh xạ Content-Type <-> đuôi file
 * Có kèm hàm test: runNamingTests() (chạy được trong console của service worker).
 */

// ===== Bảng đuôi file và MIME =====
const MIME_EXT = {
  'image/png': 'png', 'image/apng': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp', 'image/heic': 'heic',
  'font/woff2': 'woff2', 'font/woff': 'woff', 'font/ttf': 'ttf', 'font/otf': 'otf', 'font/sfnt': 'ttf',
  'application/font-woff': 'woff', 'application/font-woff2': 'woff2', 'application/x-font-woff': 'woff',
  'application/x-font-ttf': 'ttf', 'application/x-font-otf': 'otf', 'application/vnd.ms-fontobject': 'eot',
  'text/css': 'css', 'text/html': 'html', 'text/plain': 'txt', 'text/xml': 'xml', 'application/xml': 'xml',
  'application/json': 'json', 'application/pdf': 'pdf', 'application/zip': 'zip',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/webm': 'weba'
};

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', heic: 'image/heic',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  css: 'text/css', html: 'text/html', htm: 'text/html', txt: 'text/plain', xml: 'application/xml',
  json: 'application/json', pdf: 'application/pdf', zip: 'application/zip',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav'
};

export const HTML_EXT = ['html', 'htm', 'php', 'asp', 'aspx', 'jsp'];

// Đuôi file KHÔNG phải trang HTML (được coi là tài nguyên)
export const NON_HTML_EXT = new Set([
  'pdf', 'zip', 'rar', '7z', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp3', 'mp4', 'avi', 'mov', 'exe', 'dmg', 'apk',
  'json', 'xml', 'txt', 'csv', 'css', 'js', 'mjs', 'map', 'rss', 'atom',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'heic',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'webm', 'ogg', 'wav', 'm4a', 'm3u8', 'mpd', 'gz', 'tar', 'iso', 'webmanifest'
]);

// Đuôi được coi là "rõ ràng" khi đặt tên tài nguyên
const KNOWN_EXT = new Set([...Object.values(MIME_EXT), ...Object.keys(EXT_MIME), ...NON_HTML_EXT, ...HTML_EXT]);

export function cleanMime(m) {
  return String(m || '').split(';')[0].trim().toLowerCase();
}
export function extFromMime(m) {
  return MIME_EXT[cleanMime(m)] || '';
}
export function mimeFromExt(ext) {
  return EXT_MIME[String(ext || '').toLowerCase()] || '';
}
export function getExt(pathname) {
  const last = String(pathname).split('/').pop() || '';
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(last);
  return m ? m[1].toLowerCase() : '';
}

// ===== SHA-1 đồng bộ (dùng để tạo hậu tố hash ngắn) =====
export function sha1Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const l = bytes.length;
  const buf = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  buf.set(bytes);
  buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor((l * 8) / 0x100000000));
  dv.setUint32(buf.length - 4, (l * 8) >>> 0);
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Uint32Array(80);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const t = ((((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0);
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}
export const shortHash = (s) => sha1Hex(s).slice(0, 6);

// ===== Sanitize =====
function decodeSeg(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Làm sạch MỘT thành phần đường dẫn: ký tự cấm -> "_", tối đa 120 ký tự (giữ đuôi file)
export function sanitizeSegment(s) {
  let out = String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (out === '' || out === '.' || out === '..') out = '_';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = '_' + out;
  if (out.length > 120) {
    const m = /(\.[A-Za-z0-9]{1,8})$/.exec(out);
    const ext = m ? m[1] : '';
    out = out.slice(0, 120 - ext.length) + ext;
  }
  return out;
}

function withHash(file, hash) {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})?$/.exec(file);
  const base = m[1] || file;
  const ext = m[2] || '';
  const room = 120 - ext.length - hash.length - 1;
  return base.slice(0, Math.max(1, room)) + '_' + hash + ext;
}

// Đăng ký đường dẫn vào bảng `used` (khóa chữ thường -> chủ sở hữu); trùng thì thêm hậu tố hash
function claimPath(dir, file, owner, used) {
  const make = (f) => (dir.length ? dir.join('/') + '/' : '') + f;
  let path = make(file);
  let key = path.toLowerCase();
  if (!used.has(key) || used.get(key) === owner) { used.set(key, owner); return path; }
  let h = shortHash(owner);
  for (let n = 0; ; n++) {
    path = make(withHash(file, n ? shortHash(owner + n) : h));
    key = path.toLowerCase();
    if (!used.has(key) || used.get(key) === owner) { used.set(key, owner); return path; }
  }
}

function hostPrefix(u, rootHost) {
  const host = u.host.toLowerCase();
  return host === rootHost ? [] : ['_external', sanitizeSegment(host)];
}

// ===== Tên file trang HTML =====
// used: Map dùng chung giữa trang và tài nguyên của một thiết bị. Trả về đường dẫn cục bộ.
export function pageLocalPath(rawUrl, rootHost, used, devicePrefix = '') {
  const u = new URL(rawUrl);
  const segs = u.pathname.split('/').filter(Boolean).map(decodeSeg);
  const endsSlash = u.pathname.endsWith('/') || segs.length === 0;
  let dir, name, ext;
  const last = segs[segs.length - 1] || '';
  const m = /^(.*)\.([A-Za-z0-9]{1,6})$/.exec(last);
  if (!endsSlash && m && HTML_EXT.includes(m[2].toLowerCase())) {
    dir = segs.slice(0, -1); name = m[1] || 'index'; ext = m[2];
  } else {
    dir = segs; name = 'index'; ext = 'html';
  }
  if (u.search) name += '_' + shortHash(u.href); // trang có query: tránh ghi đè
  const file = sanitizeSegment(name + '.' + ext);
  const fullDir = [...(devicePrefix ? [devicePrefix] : []), ...hostPrefix(u, rootHost), ...dir].map(sanitizeSegment);
  return claimPath(fullDir, file, u.href, used);
}

// ===== Tên file tài nguyên =====
export function assetLocalPath(rawUrl, rootHost, mime, used) {
  const u = new URL(rawUrl);
  const segs = u.pathname.split('/').filter(Boolean).map(decodeSeg);
  const endsSlash = u.pathname.endsWith('/') || segs.length === 0;
  const mimeExt = extFromMime(mime);
  let dir, name, ext;
  if (endsSlash) {
    dir = segs; name = 'index'; ext = mimeExt || 'bin';
  } else {
    const last = segs[segs.length - 1];
    dir = segs.slice(0, -1);
    const m = /^(.*)\.([A-Za-z0-9]{1,6})$/.exec(last);
    if (m && KNOWN_EXT.has(m[2].toLowerCase())) { name = m[1]; ext = m[2]; }
    else { name = last; ext = mimeExt; }
  }
  if (!name) name = 'file';
  const file = sanitizeSegment(ext ? name + '.' + ext : name);
  const fullDir = [...hostPrefix(u, rootHost), ...dir].map(sanitizeSegment);
  return claimPath(fullDir, file, u.href, used);
}

// Chế độ gọn: mọi tài nguyên không phải HTML/CSS nằm phẳng trong images/ (ảnh), fonts/ (font), media/ (còn lại)
export function flatAssetPath(rawUrl, mime, used) {
  const u = new URL(rawUrl);
  const last = decodeSeg(u.pathname.split('/').filter(Boolean).pop() || '');
  const mimeExt = extFromMime(mime);
  let name = last, ext = mimeExt;
  const m = /^(.*)\.([A-Za-z0-9]{1,6})$/.exec(last);
  if (m && KNOWN_EXT.has(m[2].toLowerCase())) { name = m[1]; ext = m[2]; }
  if (!name) name = 'file';
  if (u.search) name += '_' + shortHash(u.href);
  const file = sanitizeSegment(ext ? name + '.' + ext : name);
  const folder = /^image\//.test(mime) ? 'images' : (/font/.test(mime) ? 'fonts' : 'media');
  return claimPath([folder], file, u.href, used);
}

// ===== Test =====
export function runCases(name, cases, fn) {
  const failures = [];
  for (const [input, expected] of cases) {
    let got;
    try { got = fn(...[].concat(input)); } catch (e) { got = 'LỖI: ' + e.message; }
    if (got !== expected) failures.push({ input, expected, got });
  }
  const res = { name, total: cases.length, passed: cases.length - failures.length, failures };
  console.log(`[HTTrack] test ${name}: ${res.passed}/${res.total}`, failures.length ? failures : '');
  return res;
}

export function runNamingTests() {
  const root = 'example.com';
  const page = (url, used = new Map()) => pageLocalPath(url, root, used);
  const results = [];
  results.push(runCases('pageLocalPath', [
    ['https://example.com/', 'index.html'],
    ['https://example.com/about.html', 'about.html'],
    ['https://example.com/gioi-thieu/', 'gioi-thieu/index.html'],
    ['https://example.com/blog', 'blog/index.html'],
    ['https://example.com/shop/login.php', 'shop/login.php'],
    ['https://example.com/product.html?id=5', 'product_' + shortHash('https://example.com/product.html?id=5') + '.html'],
    ['https://blog.example.com/a', '_external/blog.example.com/a/index.html']
  ], page));
  results.push(runCases('pageLocalPath-thiet-bi', [
    [['https://example.com/a/', 'mobile'], 'mobile/a/index.html'],
    [['https://example.com/', 'responsive'], 'responsive/index.html']
  ], (u, d) => pageLocalPath(u, root, new Map(), d)));
  const used = new Map();
  const a = pageLocalPath('https://example.com/About', root, used);
  const b = pageLocalPath('https://example.com/about', root, used);
  results.push(runCases('pageLocalPath-hoa-thuong', [
    [[a, b], 'ok']
  ], () => (a !== b && a.toLowerCase() !== b.toLowerCase() ? 'ok' : 'trùng')));
  const asset = (url, mime = '', u = new Map()) => assetLocalPath(url, root, mime, u);
  results.push(runCases('assetLocalPath', [
    [['https://example.com/wp-content/uploads/a.jpg'], 'wp-content/uploads/a.jpg'],
    [['https://cdn.site.net/fonts/x.woff2?v=3'], '_external/cdn.site.net/fonts/x.woff2'],
    [['https://example.com/img/12345', 'image/png'], 'img/12345.png'],
    [['https://example.com/dir/', 'text/css'], 'dir/index.css'],
    [['https://example.com/a/b:c*.png'], 'a/b_c_.png']
  ], asset));
  const u2 = new Map();
  const p1 = asset('https://example.com/logo.png?v=1', '', u2);
  const p2 = asset('https://example.com/logo.png?v=2', '', u2);
  results.push(runCases('assetLocalPath-trung-ten', [[[p1, p2], 'ok']], () => (p1 !== p2 && /^logo_[0-9a-f]{6}\.png$/.test(p2) ? 'ok' : 'sai:' + p1 + ' ' + p2)));
  results.push(runCases('sha1/sanitize', [
    [['sha1'], 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    [['san1'], 'a_b_c'],
    [['san2'], '120']
  ], (k) => {
    if (k === 'sha1') return sha1Hex('abc');
    if (k === 'san1') return sanitizeSegment('a:b*c');
    return String(sanitizeSegment('x'.repeat(200) + '.png').length === 120 ? 120 : 'sai');
  }));
  return results;
}
