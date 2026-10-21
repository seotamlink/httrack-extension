/*
 * capture.js — Điều khiển Chrome qua chrome.debugger (CDP) để chụp trang.
 * - Một tab tạm không active cho cả lượt thiết bị; gắn debugger giữ suốt lượt
 * - Giả lập thiết bị (Desktop / iPhone), điều hướng, chờ load + network idle
 * - Cuộn để kích hoạt lazy-load, chờ ảnh tải xong, lấy HTML đã render
 * - Bắt response Network (CSS, ảnh, font...) và lấy body ngay khi tải xong
 * Các hàm gửi vào trang (Runtime.evaluate) tự đứng được, không tham chiếu biến ngoài.
 */
import { isBlockedUrl } from './crawler.js';
import { cleanMime } from './naming.js';
import { assetKey, sleep } from './resources.js';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const DEVICES = {
  // Bản responsive: viewport rộng 1440; CSS media query được giữ nguyên nên tự co giãn khi xem offline
  desktop: {
    key: 'responsive', label: 'Responsive',
    metrics: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
  }
};

// Bản mobile riêng, bề rộng tùy chọn (không gắn với một model iPhone cụ thể)
export function mobileDevice(width = 393) {
  return {
    key: 'mobile', label: 'Mobile',
    metrics: { width, height: Math.round(width * 852 / 393), deviceScaleFactor: 3, mobile: true },
    touch: true,
    userAgent: MOBILE_UA
  };
}

const sessions = new Map(); // tabId -> CaptureSession

// Đăng ký listener ở mức module (bắt buộc với service worker MV3)
chrome.debugger.onEvent.addListener((source, method, params) => {
  sessions.get(source.tabId)?.onEvent(method, params);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const s = sessions.get(source.tabId);
  if (s) { s.detached = true; s.detachReason = reason; }
});

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// ===== Hàm chạy BÊN TRONG trang =====

// Cuộn tới vị trí y, trả về chiều cao nội dung
function pageScrollTo(y) {
  window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
}

// Chờ mọi <img> chưa complete, tối đa perImageMs mỗi ảnh. Trả danh sách ảnh lỗi/quá hạn.
function pageWaitImages(perImageMs) {
  const pending = Array.from(document.images).filter((i) => !i.complete);
  return Promise.all(pending.map((img) => new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      resolve(ok ? null : (img.currentSrc || img.src));
    };
    const onLoad = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), perImageMs);
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
  }))).then((r) => r.filter(Boolean));
}

// Cuộn các vùng cuộn BÊN TRONG trang (overflow auto/scroll). Trả { count, more }
function pageInnerScrollStep(step) {
  const els = [];
  for (const el of document.querySelectorAll('*')) {
    if (els.length >= 80) break;
    if (el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 50) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') els.push(el);
    }
  }
  let more = false;
  for (const el of els) {
    el.scrollTop = Math.min(step * Math.max(200, el.clientHeight * 0.8), el.scrollHeight);
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 5) more = true;
  }
  return { count: els.length, more };
}

// Đưa phần tử thứ idx trong danh sách ảnh lazy vào khung nhìn để kích hoạt IntersectionObserver
function pageRevealLazy(idx) {
  const sel = 'img[loading="lazy"], img[src^="data:"], [data-status="placeholder"], img[data-src], img[data-original], img[data-lazy-src], [data-bg], [data-background]';
  const list = Array.from(document.querySelectorAll(sel));
  const el = list[idx];
  if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  return list.length;
}

// Đưa mọi vùng cuộn về đầu
function pageResetScroll() {
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollLeft || el.scrollTop) { el.scrollLeft = 0; el.scrollTop = 0; }
  }
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  return true;
}

// Thu thập HTML đã render và các URL bổ sung từ DOM, CSSOM, computed style
function pageCollect() {
  const out = { html: '', baseUrl: document.baseURI, finalUrl: location.href, extra: [], blobs: [], cssErrors: [], broken: [] };
  const extra = new Set();
  const blobs = new Set();
  const add = (u, base) => {
    if (!u) return;
    u = String(u).trim();
    if (!u || u.startsWith('data:') || u.startsWith('#')) return;
    if (u.startsWith('blob:')) { blobs.add(u); return; }
    try { extra.add(new URL(u, base || document.baseURI).href); } catch (e) { /* bỏ qua */ }
  };
  const addCss = (v, base) => {
    if (!v || v === 'none') return;
    const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g;
    let m;
    while ((m = re.exec(v))) add(m[1] || m[2] || m[3], base);
  };

  document.querySelectorAll('img').forEach((i) => {
    add(i.currentSrc);
    if (i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)) out.broken.push(i.currentSrc || i.src);
  });
  document.querySelectorAll('video,audio').forEach((v) => { add(v.currentSrc); add(v.getAttribute('poster')); });
  document.querySelectorAll('source').forEach((s) => add(s.src));

  const walkSheet = (sheet) => {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { out.cssErrors.push(sheet.href || '(inline)'); return; }
    const base = sheet.href || document.baseURI;
    for (const r of rules) {
      if (r.type === 3) { // @import
        add(r.href, base);
        if (r.styleSheet) walkSheet(r.styleSheet);
      } else {
        addCss(r.cssText, base);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) walkSheet(sheet);

  const props = ['backgroundImage', 'listStyleImage', 'borderImageSource', 'maskImage', 'webkitMaskImage'];
  const els = document.querySelectorAll('*');
  const limit = Math.min(els.length, 30000);
  for (let i = 0; i < limit; i++) {
    const el = els[i];
    const cs = getComputedStyle(el);
    for (const p of props) { const v = cs[p]; if (v && v !== 'none' && v.indexOf('url(') !== -1) addCss(v); }
    if (i < 15000) {
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        for (const p of props) { const v = ps[p]; if (v && v !== 'none' && v.indexOf('url(') !== -1) addCss(v); }
        const c = ps.content;
        if (c && c.indexOf('url(') !== -1) addCss(c);
      }
    }
  }

  out.extra = Array.from(extra);
  out.blobs = Array.from(blobs);
  out.html = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  return out;
}

// Mã chạy trước mọi script của trang: giả lập tab đang hiển thị để lazy-load hoạt động
const VISIBLE_SHIM = `(() => { try {
  Object.defineProperty(Document.prototype, 'visibilityState', { get() { return 'visible'; }, configurable: true });
  Object.defineProperty(Document.prototype, 'hidden', { get() { return false; }, configurable: true });
} catch (e) {} })();`;

const RELEVANT_TYPES = new Set(['Stylesheet', 'Image', 'Font']);

export class CaptureSession {
  constructor(device, isCancelled) {
    this.device = device;
    this.isCancelled = isCancelled || (() => false);
    this.tabId = null;
    this.attached = false;
    this.detached = false;
    this.waiters = [];
    this.resetPage();
  }

  resetPage() {
    this.inflight = new Set();
    this.lastActivity = Date.now();
    this.reqMeta = new Map();   // requestId -> {url, type, mime, status}
    this.bodies = new Map();    // assetKey -> {ok, bytes, mime, status}
    this.pending = [];          // promises lấy body
    this.blockedSeen = new Set();
    this.docStatus = null;
  }

  // ----- Vòng đời -----
  async open() {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    this.tabId = tab.id;
    sessions.set(this.tabId, this);
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
      this.attached = true;
    } catch (e) {
      console.error('[HTTrack] attach lỗi:', e);
      throw new Error('Không thể gắn debugger vào tab. Hãy đóng DevTools của tab này rồi thử lại.');
    }
    await this.send('Page.enable');
    await this.send('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 50 * 1024 * 1024 });
    await this.send('Runtime.enable');
    const d = this.device;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: d.metrics.width, height: d.metrics.height, deviceScaleFactor: d.metrics.deviceScaleFactor,
      mobile: d.metrics.mobile, screenWidth: d.metrics.width, screenHeight: d.metrics.height
    });
    if (d.touch) {
      await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    if (d.userAgent) {
      await this.send('Emulation.setUserAgentOverride', { userAgent: d.userAgent, platform: 'iPhone' });
    }
    try { await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* không bắt buộc */ }
    try { await this.send('Page.addScriptToEvaluateOnNewDocument', { source: VISIBLE_SHIM }); } catch { /* không bắt buộc */ }
    console.log('[HTTrack] đã mở phiên chụp', d.label, 'tab', this.tabId);
  }

  async close() {
    const tabId = this.tabId;
    if (tabId == null) return;
    if (this.attached) {
      try { await chrome.debugger.detach({ tabId }); } catch (e) { /* đã gỡ */ }
      this.attached = false;
    }
    try { await chrome.tabs.remove(tabId); } catch (e) { /* tab đã đóng */ }
    sessions.delete(tabId);
    this.tabId = null;
    console.log('[HTTrack] đã đóng phiên chụp', this.device.label);
  }

  // ----- CDP -----
  async send(method, params = {}, timeoutMs = 30000) {
    if (this.detached) throw new Error('Debugger đã bị ngắt kết nối' + (this.detachReason ? ` (${this.detachReason})` : ''));
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Quá thời gian chờ ${method}`)), timeoutMs); });
    try {
      return await Promise.race([chrome.debugger.sendCommand({ tabId: this.tabId }, method, params), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Chạy một hàm tự đứng được trong trang
  async evaluate(fn, args = [], timeoutMs = 30000) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Lỗi chạy script trong trang');
    }
    return r.result.value;
  }

  // ----- Sự kiện -----
  onEvent(method, p) {
    this.lastActivity = Date.now();
    switch (method) {
      case 'Page.loadEventFired':
        this.waiters = this.waiters.filter((w) => { if (w.method === method) { w.resolve(true); return false; } return true; });
        break;
      case 'Page.javascriptDialogOpening':
        this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
        break;
      case 'Network.requestWillBeSent':
        this.inflight.add(p.requestId);
        break;
      case 'Network.responseReceived': {
        const r = p.response;
        this.reqMeta.set(p.requestId, { url: r.url, type: p.type, mime: cleanMime(r.mimeType), status: r.status });
        if (p.type === 'Document' && p.requestId === p.loaderId) this.docStatus = r.status;
        if (isBlockedUrl(r.url)) this.blockedSeen.add(r.url);
        break;
      }
      case 'Network.loadingFinished':
        this.inflight.delete(p.requestId);
        this.maybeGrabBody(p.requestId, p.encodedDataLength);
        break;
      case 'Network.loadingFailed':
        this.inflight.delete(p.requestId);
        break;
      default:
    }
  }

  maybeGrabBody(requestId, size) {
    const m = this.reqMeta.get(requestId);
    if (!m || isBlockedUrl(m.url)) return;
    if (m.status !== 200) return; // bỏ 206 (media từng phần), 304, lỗi...
    const ok = RELEVANT_TYPES.has(m.type) ||
      ((m.type === 'Other' || m.type === 'XHR' || m.type === 'Fetch') && (m.mime === 'image/svg+xml' || m.mime.startsWith('image/') || m.mime.startsWith('font/') || /font/.test(m.mime)));
    if (!ok) return;
    const key = assetKey(m.url);
    if (!key || this.bodies.has(key) || (size && size > 50 * 1024 * 1024)) return;
    const task = (async () => {
      try {
        const r = await this.send('Network.getResponseBody', { requestId }, 20000);
        const bytes = r.base64Encoded ? b64ToBytes(r.body) : new TextEncoder().encode(r.body);
        this.bodies.set(key, { ok: true, bytes, mime: m.mime, status: m.status });
      } catch (e) { /* sẽ fallback sang fetch */ }
    })();
    this.pending.push(task);
  }

  waitEvent(method, timeoutMs) {
    return new Promise((resolve) => {
      const w = { method, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i !== -1) { this.waiters.splice(i, 1); resolve(false); }
      }, timeoutMs);
    });
  }

  async settleBodies() {
    await Promise.allSettled(this.pending);
    this.pending = [];
  }

  // ----- Các bước chụp -----
  async navigate(url) {
    this.resetPage();
    const loaded = this.waitEvent('Page.loadEventFired', 30000); // đăng ký TRƯỚC khi navigate
    const res = await this.send('Page.navigate', { url });
    if (res.errorText) throw new Error(res.errorText);
    const ok = await loaded;
    if (!ok) console.warn('[HTTrack] hết thời gian chờ load:', url);
    return ok;
  }

  // Chờ thêm tối đa 3 giây hoặc đến khi không còn request nào trong 1 giây
  async waitNetworkIdle() {
    const start = Date.now();
    this.lastActivity = Date.now();
    while (Date.now() - start < 3000) {
      if (this.inflight.size === 0 && Date.now() - this.lastActivity >= 1000) break;
      await sleep(100);
    }
  }

  // Cuộn từ trên xuống theo bước 500px (mỗi bước 200ms), rồi về đầu trang
  async scrollThrough() {
    const t0 = Date.now();
    let y = 0;
    let height = await this.evaluate(pageScrollTo, [0]);
    for (let step = 0; y < height && step < 200 && Date.now() - t0 < 60000; step++) {
      if (this.isCancelled()) break;
      y += 500;
      height = await this.evaluate(pageScrollTo, [y]);
      await sleep(200);
    }
    await this.evaluate(pageScrollTo, [0]);
    await sleep(1000);
  }

  // Kích hoạt lazy-load trong vùng cuộn bên trong và carousel: cuộn từng vùng, rồi đưa từng ảnh lazy vào khung nhìn
  async revealLazy() {
    const t0 = Date.now();
    const timeLeft = () => Date.now() - t0 < 45000 && !this.isCancelled();
    for (let step = 1; step <= 80 && timeLeft(); step++) {
      const r = await this.evaluate(pageInnerScrollStep, [step]);
      if (!r.count) break;
      await sleep(250);
      if (!r.more) { await sleep(500); break; }
    }
    for (let pass = 0; pass < 2; pass++) { // danh sách co lại khi ảnh đã tải nên quét hai lượt
      const total = Math.min(await this.evaluate(pageRevealLazy, [0]), 400);
      for (let i = 1; i < total && timeLeft(); i++) {
        await this.evaluate(pageRevealLazy, [i]);
        await sleep(120);
      }
    }
    await this.evaluate(pageResetScroll);
    await sleep(500);
  }

  async waitImages() {
    return this.evaluate(pageWaitImages, [10000], 45000);
  }

  async collect() {
    return this.evaluate(pageCollect, [], 60000);
  }
}
