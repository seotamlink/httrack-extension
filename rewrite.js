/*
 * rewrite.js — Viết lại HTML và CSS để xem offline.
 * Service worker không có DOMParser nên dùng bộ tách thẻ (tokenizer) tự viết:
 * giữ nguyên từng ký tự của phần không đổi, chỉ sửa các thẻ/thuộc tính cần thiết.
 * - relativePath(): đường dẫn tương đối giữa hai file cục bộ
 * - tokenizeHtml(), processHtml(): xóa script, thuộc tính on..., preload; đổi src, href, srcset, style, url()
 * - rewriteCssText(): đổi url() và @import trong CSS
 * Có kèm hàm test: runRewriteTests().
 */
import { runCases } from './naming.js';
import { normalizeUrl } from './crawler.js';

// ===== relativePath =====
// Ví dụ: relativePath('wp-content/x/index.html', 'wp-content/a.css') -> '../a.css'
export function relativePath(fromFile, toFile) {
  const f = fromFile.split('/');
  f.pop();
  const t = toFile.split('/');
  const name = t.pop();
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const up = f.length - i;
  return [...Array(up).fill('..'), ...t.slice(i), name].join('/');
}

// Như relativePath nhưng mã hóa từng thành phần để dùng được trong URL
export function relUrl(fromFile, toFile) {
  return relativePath(fromFile, toFile).split('/').map((s) => (s === '..' || s === '.' ? s : encodeURIComponent(s))).join('/');
}

// ===== Entity =====
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
export function decodeEntities(s) {
  return String(s).replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (m, d, h, n) => {
    try {
      if (d) return String.fromCodePoint(+d);
      if (h) return String.fromCodePoint(parseInt(h, 16));
    } catch { return m; }
    return Object.prototype.hasOwnProperty.call(ENTITIES, n) ? ENTITIES[n] : m;
  });
}
export function encodeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;');
}

// ===== Tokenizer HTML =====
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const TAG_RE = /<(\/?)([a-zA-Z][^\s/>]*)/y;
const ATTR_NAME_RE = /[^\s"'>/=]+/y;
const WS_RE = /\s*/y;
const UNQ_RE = /[^\s>]*/y;

export function tokenizeHtml(html) {
  const tokens = [];
  const lower = html.toLowerCase();
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { tokens.push({ type: 'text', raw: html.slice(i) }); break; }
    if (lt > i) tokens.push({ type: 'text', raw: html.slice(i, lt) });
    i = lt;
    if (html.startsWith('<!--', i)) {
      let e = html.indexOf('-->', i + 4);
      e = e === -1 ? n : e + 3;
      tokens.push({ type: 'comment', raw: html.slice(i, e) });
      i = e;
      continue;
    }
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(html);
    if (!m) {
      if (html[i + 1] === '!' || html[i + 1] === '?') {
        let e = html.indexOf('>', i);
        e = e === -1 ? n : e + 1;
        tokens.push({ type: 'decl', raw: html.slice(i, e) });
        i = e;
      } else {
        tokens.push({ type: 'text', raw: '<' });
        i++;
      }
      continue;
    }
    const closing = m[1] === '/';
    const rawName = m[2];
    const name = rawName.toLowerCase();
    let j = TAG_RE.lastIndex;
    const attrs = [];
    let selfClosing = false;
    while (j < n) {
      WS_RE.lastIndex = j; WS_RE.exec(html); j = WS_RE.lastIndex;
      const c = html[j];
      if (c === '>') { j++; break; }
      if (c === '/') {
        if (html[j + 1] === '>') { selfClosing = true; j += 2; break; }
        j++; continue;
      }
      ATTR_NAME_RE.lastIndex = j;
      const am = ATTR_NAME_RE.exec(html);
      if (!am) { j++; continue; }
      const start = j;
      j = ATTR_NAME_RE.lastIndex;
      const attr = { name: am[0].toLowerCase(), rawName: am[0], value: null, raw: '' };
      WS_RE.lastIndex = j; WS_RE.exec(html);
      const afterWs = WS_RE.lastIndex;
      if (html[afterWs] === '=') {
        j = afterWs + 1;
        WS_RE.lastIndex = j; WS_RE.exec(html); j = WS_RE.lastIndex;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          const end = e === -1 ? n : e;
          attr.value = html.slice(j + 1, end);
          j = e === -1 ? n : e + 1;
        } else {
          UNQ_RE.lastIndex = j; UNQ_RE.exec(html);
          attr.value = html.slice(j, UNQ_RE.lastIndex);
          j = UNQ_RE.lastIndex;
        }
      }
      attr.raw = html.slice(start, j);
      attrs.push(attr);
    }
    tokens.push({ type: 'tag', closing, name, rawName, attrs, selfClosing, raw: html.slice(i, j), dirty: false, removed: false });
    i = j;
    if (!closing && !selfClosing && RAW_TEXT.has(name)) {
      let end = lower.indexOf('</' + name, i);
      if (end === -1) end = n;
      tokens.push({ type: 'raw', tag: name, raw: html.slice(i, end) });
      i = end;
    }
  }
  return tokens;
}

function buildTag(t) {
  const attrs = t.attrs.map((a) => {
    if (a.removed) return '';
    if (a.raw !== null) return ' ' + a.raw;
    return a.value === null ? ' ' + a.rawName : ` ${a.rawName}="${a.value}"`;
  }).join('');
  return `<${t.rawName}${attrs}${t.selfClosing ? ' /' : ''}>`;
}

export function serializeTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    if (t.removed) continue;
    out += t.type === 'tag' && t.dirty ? buildTag(t) : t.raw;
  }
  return out;
}

function getAttr(tag, name) {
  const a = tag.attrs.find((x) => x.name === name && !x.removed);
  return a ? decodeEntities(a.value ?? '') : null;
}
function setAttrObj(tag, a, value) {
  a.value = encodeAttr(value);
  a.raw = null;
  tag.dirty = true;
}
function removeAttr(tag, a) {
  a.removed = true;
  tag.dirty = true;
}

// ===== srcset =====
export function parseSrcset(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    let desc = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let k = j, depth = 0;
      while (k < s.length) {
        const c = s[k];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) break;
        k++;
      }
      desc = s.slice(j, k).trim();
      j = k;
    }
    out.push({ url, desc });
    i = j;
  }
  return out;
}
export function joinSrcset(entries) {
  return entries.map((e) => (e.desc ? `${e.url} ${e.desc}` : e.url)).join(', ');
}

// ===== Tham chiếu URL =====
// Trả { key (URL tuyệt đối không fragment), hash } hoặc null nếu không phải http(s)
export function resolveRef(value, baseUrl) {
  const v = String(value || '').trim();
  if (!v || v.startsWith('#') || /^(data|javascript|about|mailto|tel):/i.test(v)) return null;
  try {
    const u = new URL(v, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const hash = u.hash;
    u.hash = '';
    return { key: u.href, hash };
  } catch { return null; }
}

// ===== CSS =====
const CSS_RE = new RegExp(
  '/\\*[\\s\\S]*?\\*/' +
  '|@import\\s+(?:url\\(\\s*(?:"((?:\\\\.|[^"\\\\])*)"|\'((?:\\\\.|[^\'\\\\])*)\'|([^)\\s\'"][^)]*?))\\s*\\)|"((?:\\\\.|[^"\\\\])*)"|\'((?:\\\\.|[^\'\\\\])*)\')([^;{}]*)' +
  '|url\\(\\s*(?:"((?:\\\\.|[^"\\\\])*)"|\'((?:\\\\.|[^\'\\\\])*)\'|([^)\\s\'"][^)]*?))\\s*\\)',
  'gi'
);

function cssUnescape(s) {
  return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (m, hex, ch) => {
    if (hex) { try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return m; } }
    return ch;
  });
}
function cssEscape(s) {
  return s.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ');
}

// fn(ref, isImport) -> chuỗi URL mới hoặc null (giữ nguyên)
export function replaceCssUrls(css, fn) {
  return css.replace(CSS_RE, (match, i1, i2, i3, i4, i5, tail, u1, u2, u3) => {
    if (match.startsWith('/*')) return match;
    if (/^@import/i.test(match)) {
      const ref = cssUnescape(i1 ?? i2 ?? i3 ?? i4 ?? i5 ?? '').trim();
      if (!ref) return match;
      const nv = fn(ref, true);
      return nv === null || nv === undefined ? match : `@import url("${cssEscape(nv)}")${tail}`;
    }
    const ref = cssUnescape(u1 ?? u2 ?? u3 ?? '').trim();
    if (!ref) return match;
    const nv = fn(ref, false);
    return nv === null || nv === undefined ? match : `url("${cssEscape(nv)}")`;
  });
}

// Thay từng @import bằng chuỗi do fn(ref, mediaTail) trả về (null = giữ nguyên)
export function replaceCssImports(css, fn) {
  return css.replace(CSS_RE, (match, i1, i2, i3, i4, i5, tail) => {
    if (!/^@import/i.test(match)) return match;
    const ref = cssUnescape(i1 ?? i2 ?? i3 ?? i4 ?? i5 ?? '').trim();
    const out = ref ? fn(ref, (tail || '').trim()) : null;
    return out === null || out === undefined ? match : out;
  });
}

export function extractCssRefs(css) {
  const out = [];
  replaceCssUrls(css, (ref, isImport) => { out.push({ ref, isImport }); return null; });
  return out;
}

// opts: { baseUrl, fromLocal, resolveAsset(absUrl) -> localPath | null }
export function rewriteCssText(css, opts) {
  return replaceCssUrls(css, (ref) => {
    const r = resolveRef(ref, opts.baseUrl);
    if (!r) return null;
    const local = opts.resolveAsset(r.key);
    if (local) {
      if (local.startsWith('data:')) return local;
      // Chế độ gọn: CSS dùng chung chưa biết nó sẽ nằm ở thư mục nào, đánh dấu \u0001 để thay bằng ../ khi ghi file
      if (opts.rootMarker) return '\u0001' + local.split('/').map(encodeURIComponent).join('/') + r.hash;
      return relUrl(opts.fromLocal, local) + r.hash;
    }
    return r.key + r.hash; // không lưu được: dùng URL tuyệt đối gốc
  });
}

// ===== Phân loại thuộc tính =====
const SRCSET_ATTRS = new Set(['srcset', 'data-srcset', 'data-lazy-srcset', 'imagesrcset', 'data-original-set']);
const DATA_URLISH = /^data-(?:src|lazy|original|bg|background|image|img|poster|thumb|full|large|hi-?res|retina|echo|url|mobile|desktop)/;
const URLISH_VALUE = /^(?:https?:)?\/\/|^\.{0,2}\/|\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm)(?:[?#]|$)/i;
const LINK_RES_RELS = ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'stylesheet', 'mask-icon', 'image_src'];
const REMOVED_LINK_RELS = ['preload', 'modulepreload', 'prefetch'];
const META_IMAGE_KEYS = new Set(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src']);
const IMG_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i;

function relTokens(tag) {
  return (getAttr(tag, 'rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// Trả 'style' | 'srcset' | 'url' | 'guess' | 'iframe' | null
export function attrKind(tag, attr) {
  const n = attr.name;
  const t = tag.name;
  if (n === 'style') return 'style';
  if (SRCSET_ATTRS.has(n) || /^data-.*srcset$/.test(n)) return 'srcset';
  if (t === 'a' || t === 'area' || t === 'script') return null;
  if (n === 'src') return t === 'iframe' ? 'iframe' : 'url';
  if (n === 'poster') return 'url';
  if (n === 'href' || n === 'xlink:href') {
    if (t === 'link') return relTokens(tag).some((r) => LINK_RES_RELS.includes(r)) ? 'url' : null;
    if (t === 'use' || t === 'image' || t === 'feimage') return 'url';
    return null;
  }
  if (n === 'content' && t === 'meta') {
    const key = (getAttr(tag, 'property') || getAttr(tag, 'name') || '').toLowerCase();
    return META_IMAGE_KEYS.has(key) ? 'url' : null;
  }
  if (DATA_URLISH.test(n)) return 'guess';
  return null;
}

/*
 * Xử lý HTML. mode:
 *  - 'extract'   : chỉ thu thập tham chiếu (không sửa)
 *  - 'resources' : xóa script, thuộc tính on..., preload; viết lại tài nguyên và CSS
 *  - 'links'     : chỉ viết lại link <a>/<area> nội bộ
 * opts: { baseUrl, fromLocal, resolveAsset(key)->local|null, resolveLink(normUrl)->local|null,
 *         isBlocked(url), isInternal(url) }
 * Trả { html, refs: {resources:Set, links:[], blobs:Set, scripts, iframesRemoved:[], baseRemoved},
 *       unresolved: [] }
 */
export function processHtml(html, mode, opts) {
  const tokens = tokenizeHtml(html);
  const refs = { resources: new Set(), stylesheets: new Set(), links: [], blobs: new Set(), scripts: 0, iframesRemoved: [], baseRemoved: 0 };
  const unresolved = [];
  const apply = mode === 'resources';
  const baseUrl = opts.baseUrl;

  const noteRef = (value) => {
    if (/^blob:/i.test(String(value).trim())) { refs.blobs.add(String(value).trim()); return null; }
    const r = resolveRef(value, baseUrl);
    if (r) refs.resources.add(r.key);
    return r;
  };
  const mapRef = (r, keepOnFail) => {
    const local = opts.resolveAsset(r.key);
    if (local) return local.startsWith('data:') ? local : relUrl(opts.fromLocal, local) + r.hash;
    return keepOnFail ? null : r.key + r.hash;
  };
  const removeElement = (idx, name) => {
    tokens[idx].removed = true;
    for (let j = idx + 1; j < Math.min(tokens.length, idx + 6); j++) {
      const x = tokens[j];
      if (x.type === 'tag' && x.closing && x.name === name) {
        for (let k = idx + 1; k <= j; k++) tokens[k].removed = true;
        return;
      }
    }
  };

  let hasCharset = false;
  let headIdx = -1;
  // Chế độ gói gọn: gộp mọi stylesheet/style vào một file CSS, chèn <link> tại vị trí của cái đầu tiên
  let slot = null;
  const bundleSlot = (tok) => { if (!slot) slot = tok; else tok.removed = true; };
  const wrapMedia = (text, media) => (media && media.trim().toLowerCase() !== 'all' ? `@media ${media}{${text}}` : text);

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.type === 'raw') {
      if (t.tag === 'style' && !tokens[idx - 1]?.removed && mode !== 'links') {
        for (const { ref } of extractCssRefs(t.raw)) noteRef(ref);
        if (apply && opts.bundle) {
          const open = tokens[idx - 1];
          const close = tokens[idx + 1];
          opts.bundle.parts.push(wrapMedia(rewriteCssText(t.raw, opts), open ? getAttr(open, 'media') : null));
          if (open) bundleSlot(open);
          t.removed = true;
          if (close && close.type === 'tag' && close.closing && close.name === 'style') close.removed = true;
          continue;
        }
        if (apply) t.raw = rewriteCssText(t.raw, opts);
      }
      continue;
    }
    if (t.type !== 'tag' || t.closing) continue;
    const name = t.name;

    if (name === 'head' && headIdx === -1) headIdx = idx;

    if (name === 'script') {
      refs.scripts++;
      if (apply) removeElement(idx, 'script');
      continue;
    }
    if (name === 'base') {
      refs.baseRemoved++;
      if (apply) { t.removed = true; }
      continue;
    }
    if (apply) {
      for (const a of t.attrs) {
        if (a.removed) continue;
        if (/^on[a-z]+$/.test(a.name) || a.name === 'integrity' || a.name === 'crossorigin') removeAttr(t, a);
      }
    }
    if (name === 'meta') {
      const he = (getAttr(t, 'http-equiv') || '').toLowerCase();
      if (he === 'content-security-policy' || he === 'content-security-policy-report-only') {
        if (apply) t.removed = true;
        continue;
      }
      if (t.attrs.some((a) => a.name === 'charset' && !a.removed)) {
        hasCharset = true;
        if (apply) { const a = t.attrs.find((x) => x.name === 'charset'); if (a.value.toLowerCase() !== 'utf-8') setAttrObj(t, a, 'utf-8'); }
      } else if (he === 'content-type') {
        hasCharset = true;
        if (apply) { const a = t.attrs.find((x) => x.name === 'content'); if (a) setAttrObj(t, a, 'text/html; charset=utf-8'); }
      }
    }
    if (name === 'link') {
      const rels = relTokens(t);
      if (rels.some((r) => REMOVED_LINK_RELS.includes(r))) {
        if (apply) t.removed = true;
        continue;
      }
      if (apply && opts.bundle && rels.includes('stylesheet')) {
        const href = getAttr(t, 'href');
        const r = href ? resolveRef(href, baseUrl) : null;
        const text = r ? opts.bundle.cssTextFor(r.key) : null;
        if (text !== null && text !== undefined) {
          opts.bundle.parts.push(wrapMedia(text, getAttr(t, 'media')));
          bundleSlot(t);
          continue;
        }
      }
    }
    if (name === 'iframe') {
      const src = getAttr(t, 'src');
      if (src && opts.isBlocked) {
        const r = resolveRef(src, baseUrl);
        if (r && opts.isBlocked(r.key)) {
          refs.iframesRemoved.push(r.key);
          if (apply) removeElement(idx, 'iframe');
          continue;
        }
      }
    }

    if (name === 'a' || name === 'area') {
      const a = t.attrs.find((x) => x.name === 'href' && !x.removed);
      if (!a) continue;
      const raw = decodeEntities(a.value ?? '');
      refs.links.push(raw);
      if (mode !== 'links') continue;
      const r = resolveRef(raw, baseUrl);
      if (!r) continue;
      const norm = normalizeUrl(r.key);
      const local = norm ? opts.resolveLink(norm, r.key) : null;
      if (local) {
        setAttrObj(t, a, relUrl(opts.fromLocal, local) + r.hash);
      } else {
        if (opts.isInternal && opts.isInternal(r.key)) unresolved.push(r.key);
        if (raw.trim() !== r.key + r.hash) setAttrObj(t, a, r.key + r.hash);
      }
      continue;
    }
    if (mode === 'links') continue;

    for (const a of t.attrs) {
      if (a.removed) continue;
      const kind = attrKind(t, a);
      if (!kind) continue;
      const val = decodeEntities(a.value ?? '');
      // Chế độ gọn: thuộc tính data-* của lazy-load vô nghĩa khi offline và sẽ nhân đôi dung lượng ảnh
      if (opts.compact && a.name.startsWith('data-') && (kind === 'srcset' || kind === 'guess')) {
        if (apply) removeAttr(t, a);
        continue;
      }
      if (kind === 'style') {
        for (const { ref } of extractCssRefs(val)) noteRef(ref);
        if (apply) { const nv = rewriteCssText(val, opts); if (nv !== val) setAttrObj(t, a, nv); }
      } else if (kind === 'srcset') {
        let entries = parseSrcset(val);
        let changed = false;
        if (opts.compact && entries.length > 1) {
          // Chỉ giữ ứng viên lớn nhất để không phải nhúng cùng một ảnh nhiều khổ
          const score = (e) => parseFloat(e.desc) || 1;
          entries = [entries.reduce((b, e) => (score(e) > score(b) ? e : b))];
          changed = true;
        }
        for (const e of entries) {
          const r = noteRef(e.url);
          if (r && apply) { e.url = mapRef(r, false); changed = true; }
        }
        if (apply && changed) setAttrObj(t, a, joinSrcset(entries));
      } else if (kind === 'iframe') {
        const r = resolveRef(val, baseUrl);
        if (r && IMG_EXT_RE.test(r.key)) {
          refs.resources.add(r.key);
          if (apply) { const nv = mapRef(r, true); if (nv) setAttrObj(t, a, nv); }
        }
      } else if (kind === 'guess') {
        if (!URLISH_VALUE.test(val.trim())) continue;
        const r = noteRef(val);
        if (r && apply) { const nv = mapRef(r, true); if (nv) setAttrObj(t, a, nv); }
      } else {
        const r = noteRef(val);
        if (r && t.name === 'link' && relTokens(t).includes('stylesheet')) refs.stylesheets.add(r.key);
        if (r && apply) { const nv = mapRef(r, false); if (nv !== val) setAttrObj(t, a, nv); }
      }
    }
  }

  if (apply && opts.bundle && slot && opts.bundle.parts.length) {
    slot.removed = false;
    slot.dirty = false;
    slot.type = 'tag';
    slot.raw = `<link rel="stylesheet" href="${relUrl(opts.fromLocal, opts.bundle.cssLocal)}">`;
  }
  if (apply && !hasCharset && headIdx !== -1) {
    tokens.splice(headIdx + 1, 0, { type: 'text', raw: '<meta charset="utf-8">' });
  }
  return { html: mode === 'extract' ? html : serializeTokens(tokens), refs, unresolved };
}

// ===== Test =====
export function runRewriteTests() {
  const results = [];
  results.push(runCases('relativePath', [
    [['wp-content/x/index.html', 'wp-content/a.css'], '../a.css'],
    [['index.html', 'a/b.css'], 'a/b.css'],
    [['a/b/c.html', 'a/b/d.png'], 'd.png'],
    [['a/index.html', 'index.html'], '../index.html'],
    [['a/b/c/index.html', 'x/y.js'], '../../../x/y.js'],
    [['index.html', 'index.html'], 'index.html']
  ], relativePath));
  results.push(runCases('parseSrcset', [
    [['a.jpg 1x, b.jpg 2x'], 'a.jpg 1x, b.jpg 2x'],
    [['a.jpg 300w,b.jpg 600w'], 'a.jpg 300w, b.jpg 600w'],
    [['single.png'], 'single.png'],
    [['data:image/png;base64,AAA, b.png 2x'], 'data:image/png;base64,AAA, b.png 2x']
  ], (s) => joinSrcset(parseSrcset(s))));
  const cssOpts = {
    baseUrl: 'https://example.com/css/site.css',
    fromLocal: 'css/site.css',
    resolveAsset: (k) => ({ 'https://example.com/img/a.png': 'img/a.png', 'https://example.com/css/b.css': 'css/b.css' }[k] || null)
  };
  results.push(runCases('rewriteCssText', [
    ['a{background:url(../img/a.png)}', 'a{background:url("../img/a.png")}'],
    ['a{background:url( "../img/a.png" ) no-repeat}', 'a{background:url("../img/a.png") no-repeat}'],
    ["@import 'b.css';", '@import url("b.css");'],
    ['a{background:url(data:image/png;base64,AAA)}', 'a{background:url(data:image/png;base64,AAA)}'],
    ['/* url(x.png) */a{b:url(/missing.png)}', '/* url(x.png) */a{b:url("https://example.com/missing.png")}']
  ], (c) => rewriteCssText(c, cssOpts)));
  const hOpts = {
    baseUrl: 'https://example.com/blog/post', fromLocal: 'blog/post/index.html',
    resolveAsset: (k) => (k === 'https://example.com/img/a.jpg' ? 'img/a.jpg' : null),
    resolveLink: (n) => (n === 'https://example.com/about' ? 'about/index.html' : null),
    isBlocked: (u) => /doubleclick/.test(u), isInternal: (u) => u.startsWith('https://example.com/')
  };
  const src = '<html><head><title>T</title><script>var a="<b>";</script><link rel="preload" href="/x.css"></head>' +
    '<body onload="x()"><img src="/img/a.jpg" srcset="/img/a.jpg 1x, /img/b.jpg 2x"><a href="/about#top">A</a><a href="/other">B</a>' +
    '<iframe src="https://ad.doubleclick.net/x"></iframe></body></html>';
  const r1 = processHtml(src, 'resources', hOpts);
  const r2 = processHtml(r1.html, 'links', hOpts);
  const checks = [
    ['không còn script', !/<script/i.test(r1.html)],
    ['không còn onload/preload/iframe', !/onload|preload|iframe/i.test(r1.html)],
    ['src đổi tương đối', /src="\.\.\/\.\.\/img\/a\.jpg"/.test(r1.html)],
    ['srcset giữ descriptor', /srcset="\.\.\/\.\.\/img\/a\.jpg 1x, https:\/\/example\.com\/img\/b\.jpg 2x"/.test(r1.html)],
    ['có meta charset', /<head><meta charset="utf-8">/.test(r1.html)],
    ['link nội bộ đã lưu', /href="\.\.\/\.\.\/about\/index\.html#top"/.test(r2.html)],
    ['link chưa lưu thành tuyệt đối', /href="https:\/\/example\.com\/other"/.test(r2.html) && r2.unresolved.length === 1]
  ];
  results.push(runCases('processHtml', checks.map(([label, ok]) => [[label, ok], 'ok']), (label, ok) => (ok ? 'ok' : 'sai')));
  return results;
}
