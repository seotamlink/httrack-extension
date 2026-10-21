
import { NON_HTML_EXT, getExt, runCases } from './naming.js';

// Domain quảng cáo / analytics: không tải, không lưu
export const BLOCKED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com',
  'facebook.net', 'connect.facebook.net', 'hotjar.com', 'clarity.ms', 'scorecardresearch.com'
];

export function isBlockedUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

const TRACKING = /^(utm_.*|fbclid|gclid|ref|mc_cid|mc_eid)$/i;

// Chuẩn hóa URL: tuyệt đối, bỏ fragment, bỏ "/" cuối path, bỏ tham số theo dõi
export function normalizeUrl(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  if (u.search) {
    const keys = [...new Set(u.searchParams.keys())].filter((k) => TRACKING.test(k));
    if (keys.length) {
      keys.forEach((k) => u.searchParams.delete(k));
      // URLSearchParams mã hóa lại; chấp nhận vì chỉ xảy ra khi có tham số theo dõi
    }
    if (u.search === '?') u.search = '';
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.href;
}

// Domain gốc (đăng ký) của một hostname, có xử lý sơ bộ co.uk, com.vn...
export function rootDomain(hostname) {
  const p = hostname.split('.');
  if (p.length <= 2) return hostname;
  const sld = ['com', 'co', 'net', 'org', 'gov', 'edu', 'ac'];
  if (p[p.length - 1].length === 2 && sld.includes(p[p.length - 2])) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}

export function hostAllowed(url, rootHost, includeSub) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.host.toLowerCase() === rootHost) return true;
  if (!includeSub) return false;
  const rd = rootDomain(rootHost.replace(/:\d+$/, ''));
  const h = u.hostname.toLowerCase();
  return h === rd || h.endsWith('.' + rd);
}

const LOGOUT_RE = /logout|signout|wp-admin|wp-login|cart\/add/i;

/*
 * Phân loại một href tìm thấy trong trang.
 * Trả về { action: 'follow' | 'resource' | 'self' | 'skip', url, reason }
 * scope = { rootHost, includeSub }
 */
export function classifyLink(href, baseUrl, scope) {
  const raw = String(href || '').trim();
  if (!raw) return { action: 'skip', reason: 'href rỗng' };
  if (raw.startsWith('#')) return { action: 'skip', reason: 'link chỉ có fragment' };
  const sch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (sch && !/^https?$/i.test(sch[1])) return { action: 'skip', reason: `scheme không hỗ trợ (${sch[1].toLowerCase()}:)` };
  let u;
  try { u = new URL(raw, baseUrl); } catch { return { action: 'skip', reason: 'URL không hợp lệ' }; }
  const url = normalizeUrl(u.href);
  if (!url) return { action: 'skip', reason: 'scheme không hỗ trợ' };
  if (url === normalizeUrl(baseUrl)) return { action: 'self', url };
  if (!hostAllowed(url, scope.rootHost, scope.includeSub)) return { action: 'skip', url, reason: 'ngoài phạm vi (khác host)' };
  if (LOGOUT_RE.test(u.pathname) || /[?&]add-to-cart/i.test(u.search)) {
    return { action: 'skip', url, reason: 'link đăng xuất / thay đổi trạng thái' };
  }
  if (NON_HTML_EXT.has(getExt(u.pathname))) return { action: 'resource', url, reason: 'file không phải HTML' };
  return { action: 'follow', url };
}

// ===== Hàng đợi BFS =====
export class CrawlQueue {
  constructor({ maxDepth, maxPages }) {
    this.maxDepth = maxDepth;
    this.maxPages = maxPages;
    this.items = [];
    this.head = 0;
    this.seen = new Set();
    this.pathCount = new Map();
    this.warnings = [];
  }
  // Trả { added, reason, silent }
  tryAdd(url, depth) {
    if (this.seen.has(url)) return { added: false, silent: true, reason: 'đã có trong hàng đợi' };
    if (depth > this.maxDepth) return { added: false, reason: 'vượt maxDepth' };
    if (this.seen.size >= this.maxPages) return { added: false, reason: 'vượt maxPages' };
    this.seen.add(url);
    this.items.push({ url, depth });
    try {
      const p = new URL(url);
      const key = p.host + p.pathname;
      const c = (this.pathCount.get(key) || 0) + 1;
      this.pathCount.set(key, c);
      if (c === 51) this.warnings.push(`Cảnh báo: hơn 50 trang cùng path ${key} (khác query) - có thể là nội dung động/lọc sản phẩm`);
    } catch { /* bỏ qua */ }
    return { added: true };
  }
  markSeen(url) { this.seen.add(url); }
  next() { return this.head < this.items.length ? this.items[this.head++] : null; }
  get total() { return this.items.length; }
  get index() { return this.head; }
}

// ===== robots.txt =====
function patternToRegex(p) {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc.replace(/\\\$$/, '$'));
}

// Trả về hàm isAllowed(pathAndQuery). Ưu tiên nhóm "chrome", sau đó "*".
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (let line of String(text).split(/\r?\n/)) {
    line = line.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
    } else if (k === 'allow' || k === 'disallow') {
      lastWasAgent = false;
      if (cur && v !== '') cur.rules.push({ allow: k === 'allow', re: patternToRegex(v), len: v.length });
    } else {
      lastWasAgent = false;
    }
  }
  const pick = groups.filter((g) => g.agents.includes('chrome'));
  const chosen = pick.length ? pick : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  return (pathAndQuery) => {
    let best = null;
    for (const r of rules) {
      if (!r.re.test(pathAndQuery)) continue;
      if (!best || r.len > best.len || (r.len === best.len && r.allow)) best = r;
    }
    return best ? best.allow : true;
  };
}

// So sánh bản responsive với bản mobile: trang có trả giao diện riêng cho điện thoại không?
// a, b = { cssUrls: [], htmlLen }. Trả { different, reason }
export function isDifferentLayout(a, b) {
  const strip = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };
  const A = new Set(a.cssUrls.map(strip));
  const B = new Set(b.cssUrls.map(strip));
  if (A.size || B.size) {
    let inter = 0;
    A.forEach((u) => { if (B.has(u)) inter++; });
    const j = inter / (A.size + B.size - inter);
    if (j < 0.6) return { different: true, reason: `bộ CSS khác nhau (độ giống ${Math.round(j * 100)}%)` };
  }
  const ratio = b.htmlLen / Math.max(a.htmlLen, 1);
  if (ratio < 0.4 || ratio > 2.5) return { different: true, reason: `HTML chênh lệch lớn (tỉ lệ ${ratio.toFixed(2)})` };
  return { different: false, reason: 'CSS và HTML tương đương' };
}

// ===== Test =====
export function runCrawlerTests() {
  const results = [];
  const base = 'https://example.com/a/b';
  results.push(runCases('normalizeUrl', [
    [['HTTP://Example.COM/x/?utm_source=a&id=2#top'], 'http://example.com/x?id=2'],
    [['/c#frag', base], 'https://example.com/c'],
    [['https://example.com/'], 'https://example.com/'],
    [['https://example.com/p?page=2'], 'https://example.com/p?page=2'],
    [['https://example.com/p?fbclid=1&gclid=2'], 'https://example.com/p'],
    [['mailto:a@b.c'], null],
    [['../up', base], 'https://example.com/up']
  ], normalizeUrl));
  const scope = { rootHost: 'example.com', includeSub: false };
  results.push(runCases('classifyLink', [
    [['#top', base, scope], 'skip'],
    [['mailto:x@y.z', base, scope], 'skip'],
    [['https://other.com/', base, scope], 'skip'],
    [['/logout', base, scope], 'skip'],
    [['/files/a.pdf', base, scope], 'resource'],
    [['/trang-2', base, scope], 'follow'],
    [['https://sub.example.com/', base, { rootHost: 'example.com', includeSub: true }], 'follow']
  ], (...a) => classifyLink(...a).action));
  const allow = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\n');
  results.push(runCases('robots', [
    [['/'], true], [['/private/x'], false], [['/private/ok'], true], [['/a.pdf'], false], [['/a.pdf?x=1'], true]
  ], allow));
  const q = new CrawlQueue({ maxDepth: 1, maxPages: 2 });
  results.push(runCases('CrawlQueue', [
    [['https://a.com/1', 0], true],
    [['https://a.com/1', 0], false],
    [['https://a.com/2', 2], false],
    [['https://a.com/3', 1], true],
    [['https://a.com/4', 1], false]
  ], (u, d) => q.tryAdd(u, d).added));
  const L = (c, n) => ({ cssUrls: c, htmlLen: n });
  results.push(runCases('isDifferentLayout', [
    [[L(['https://a.com/x.css?v=1'], 1000), L(['https://a.com/x.css?v=2'], 1100)], false],
    [[L(['https://a.com/d/s.css'], 1000), L(['https://a.com/m/s.css'], 1000)], true],
    [[L(['https://a.com/x.css'], 1000), L(['https://a.com/x.css'], 5000)], true],
    [[L([], 1000), L([], 900)], false],
    [[L(['https://a.com/1.css', 'https://a.com/2.css'], 1000), L(['https://a.com/1.css', 'https://a.com/2.css', 'https://a.com/3.css'], 1000)], false]
  ], (a, b) => isDifferentLayout(a, b).different));
  results.push(runCases('isBlockedUrl', [
    [['https://www.google-analytics.com/collect'], true],
    [['https://connect.facebook.net/x.js'], true],
    [['https://example.com/a.png'], false]
  ], isBlockedUrl));
  return results;
}
