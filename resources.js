/*
 * resources.js — Tải tài nguyên (ảnh, CSS, font, media) và lưu vào ZIP.
 * - Nguồn 1: body đã bắt bằng CDP (Network.getResponseBody), truyền vào qua `bodies`
 * - Nguồn 2: fetch(url, { credentials: "include" }) từ service worker, retry tối đa 2 lần
 * - Mỗi URL chỉ tải một lần trong một lượt thiết bị (AssetStore.promises)
 * - CSS được tải đệ quy các url()/@import (tối đa 5 cấp) rồi mới viết lại và lưu
 */
import { isBlockedUrl } from './crawler.js';
import { assetLocalPath, cleanMime, extFromMime, getExt, mimeFromExt } from './naming.js';
import { extractCssRefs, resolveRef, rewriteCssText } from './rewrite.js';

export const MAX_RESOURCE_BYTES = 80 * 1024 * 1024; // 80MB / tài nguyên
export const MAX_DOC_BYTES = 30 * 1024 * 1024;      // 30MB / file tải kèm theo link (pdf, zip...)
const MAX_IMPORT_DEPTH = 5;
const POOL_SIZE = 6;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Khóa tài nguyên: URL tuyệt đối, bỏ fragment, giữ query
export function assetKey(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    x.hash = '';
    return x.href;
  } catch { return null; }
}

// Tải bằng fetch, thử lại tối đa `retries` lần khi lỗi mạng hoặc HTTP 5xx
export async function fetchBytes(url, { maxBytes = MAX_RESOURCE_BYTES, retries = 2, timeoutMs = 30000 } = {}) {
  let last = { ok: false, reason: 'lỗi không xác định' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { credentials: 'include', signal: ctl.signal, redirect: 'follow' });
      if (res.status >= 500) { last = { ok: false, status: res.status, reason: 'HTTP ' + res.status }; continue; }
      if (!res.ok) return { ok: false, status: res.status, reason: 'HTTP ' + res.status };
      const len = Number(res.headers.get('content-length')) || 0;
      if (len > maxBytes) return { ok: false, status: res.status, reason: `quá lớn (${len} byte)` };
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) return { ok: false, status: res.status, reason: `quá lớn (${bytes.length} byte)` };
      return { ok: true, status: res.status, bytes, mime: cleanMime(res.headers.get('content-type')), finalUrl: res.url };
    } catch (e) {
      last = { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'lỗi mạng: ' + e.message };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

class Pool {
  constructor(n) { this.n = n; this.active = 0; this.queue = []; }
  run(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.active++;
        fn().then(resolve, reject).finally(() => {
          this.active--;
          const next = this.queue.shift();
          if (next) next();
        });
      };
      if (this.active < this.n) go(); else this.queue.push(go);
    });
  }
}

const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'text/plain', 'application/x-unknown']);
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript)|image\/svg)/;

export class AssetStore {
  /*
   * opts: { rootHost, usedPaths(Map), zip(ZipClient), prefix ('<domain>/<device>/'),
   *         report(Report), device, onProgress(done,total), totalBudget(bytes), onLimit() }
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.pool = new Pool(POOL_SIZE);
    this.promises = new Map(); // key -> Promise<entry|null>
    this.entries = new Map();  // key -> entry
    this.done = 0;
    this.total = 0;
    this.bytes = 0;
    this.okCount = 0;
    this.failCount = 0;
  }

  localFor(key) {
    const e = this.entries.get(key);
    return e && e.ok ? e.local : null;
  }

  ensureMany(urls, opts) {
    return Promise.all([...urls].map((u) => this.ensure(u, opts)));
  }

  /* opts: { bodies: Map<key, {ok,bytes,mime,status}>, chain: [], importDepth, maxBytes } */
  ensure(rawUrl, opts = {}) {
    const key = assetKey(rawUrl);
    if (!key) return Promise.resolve(null);
    if (opts.chain && opts.chain.includes(key)) return Promise.resolve(null); // vòng @import
    if (this.promises.has(key)) return this.promises.get(key);
    this.total++;
    this.onProgress?.(this.done, this.total);
    const p = this._load(key, opts)
      .catch((e) => {
        this._fail(key, 'lỗi xử lý: ' + e.message);
        return null;
      })
      .finally(() => {
        this.done++;
        this.onProgress?.(this.done, this.total);
      });
    this.promises.set(key, p);
    return p;
  }

  _fail(key, reason, status) {
    this.entries.set(key, { ok: false, reason, status });
    this.failCount++;
    this.report.resFail.push({ device: this.device, url: key, reason: status ? `HTTP ${status}` : reason });
    console.warn('[HTTrack] tài nguyên lỗi:', key, reason);
  }

  async _load(key, opts) {
    if (/^blob:/i.test(key)) return null;
    if (isBlockedUrl(key)) {
      this.report.resSkipped.push({ device: this.device, url: key, reason: 'domain quảng cáo/analytics' });
      return null;
    }
    let got = opts.bodies?.get(key);
    if (!got || !got.ok) {
      got = await this.pool.run(() => fetchBytes(key, { maxBytes: opts.maxBytes || MAX_RESOURCE_BYTES }));
    }
    if (!got.ok) { this._fail(key, got.reason || 'không rõ', got.status); return null; }

    const u = new URL(key);
    const ext = getExt(u.pathname);
    let mime = cleanMime(got.mime);
    if (GENERIC_MIME.has(mime)) mime = mimeFromExt(ext) || mime;
    const isCss = mime === 'text/css' || ext === 'css';
    let bytes = got.bytes;
    const local = assetLocalPath(key, this.rootHost, mime, this.usedPaths);

    if (isCss) {
      let text = new TextDecoder('utf-8').decode(bytes);
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const depth = opts.importDepth || 0;
      const chain = [...(opts.chain || []), key];
      const children = new Set();
      for (const { ref, isImport } of extractCssRefs(text)) {
        const r = resolveRef(ref, key);
        if (!r || (isImport && depth >= MAX_IMPORT_DEPTH)) continue;
        children.add(JSON.stringify([r.key, isImport]));
      }
      await Promise.all([...children].map((c) => {
        const [k, isImport] = JSON.parse(c);
        return this.ensure(k, { bodies: opts.bodies, chain, importDepth: isImport ? depth + 1 : depth });
      }));
      const rewritten = rewriteCssText(text, {
        baseUrl: key, fromLocal: local, resolveAsset: (k) => this.localFor(k)
      });
      bytes = new TextEncoder().encode(rewritten);
    }

    this.bytes += bytes.length;
    if (this.totalBudget && this.bytes > this.totalBudget) this.onLimit?.();
    const compress = TEXT_MIME.test(mime) || isCss;
    await this.zip.addFile(this.prefix + local, bytes, { compress });
    const entry = { ok: true, local, mime, size: bytes.length };
    this.entries.set(key, entry);
    this.okCount++;
    this.report.resOk.push({ device: this.device, url: key, local: this.prefix + local });
    return entry;
  }
}

export { extFromMime };
