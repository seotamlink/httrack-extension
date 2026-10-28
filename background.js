
import { CaptureSession, DEVICES, mobileDevice } from './capture.js';
import { CrawlQueue, classifyLink, hostAllowed, isBlockedUrl, isDifferentLayout, normalizeUrl, parseRobots, runCrawlerTests } from './crawler.js';
import { pageLocalPath, runNamingTests } from './naming.js';
import { AssetStore, MAX_DOC_BYTES, assetKey, fetchBytes, sleep } from './resources.js';
import { processHtml, runRewriteTests } from './rewrite.js';
import { Report, ZipClient, buildLauncher } from './zip.js';

const STATE_KEY = 'httrack_state';
const SIZE_LIMIT = 1024 * 1024 * 1024; // 1GB

let runActive = false;
let cancelled = false;
let state = { running: false, phase: 'idle', message: '', percent: 0, error: null, result: null, updatedAt: 0 };
let resumeWaiter = null; // resolve khi người dùng bấm "Tiếp tục quét" (hoặc hủy)
let writeTimer = null;
let lastWrite = 0;

self.httrackTests = () => [...runNamingTests(), ...runCrawlerTests(), ...runRewriteTests()];

// ===== Trạng thái =====
async function flushState() {
  writeTimer = null;
  lastWrite = Date.now();
  state.updatedAt = lastWrite;
  try { await chrome.storage.session.set({ [STATE_KEY]: state }); } catch (e) { console.warn('[HTTrack] lưu state lỗi', e); }
}
function setState(patch, immediate = false) {
  Object.assign(state, patch);
  if (immediate || Date.now() - lastWrite > 250) { flushState(); return; }
  if (!writeTimer) writeTimer = setTimeout(flushState, 250);
}

// Nếu service worker bị khởi động lại giữa chừng thì tiến trình cũ đã mất
(async () => {
  try {
    const saved = (await chrome.storage.session.get(STATE_KEY))[STATE_KEY];
    if (saved && saved.running && !runActive) {
      state = { ...saved, running: false, phase: 'error', error: 'Tiến trình bị gián đoạn (service worker khởi động lại). Hãy chạy lại.' };
      await flushState();
    } else if (saved) {
      state = saved;
    }
  } catch (e) { console.warn('[HTTrack] đọc state lỗi', e); }
})();

// ===== Nhận lệnh từ popup =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  if (msg.type === 'get-state') { sendResponse({ ok: true, state }); return false; }
  if (msg.type === 'cancel') {
    if (runActive) { cancelled = true; resumeWaiter?.(); setState({ message: 'Đang hủy, sẽ lưu phần đã hoàn thành...' }, true); }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'resume') { resumeWaiter?.(); sendResponse({ ok: true }); return false; }
  if (msg.type === 'start') {
    if (runActive) { sendResponse({ ok: false, error: 'Đang có một tiến trình chạy. Hãy chờ hoặc bấm Hủy.' }); return false; }
    let cfg;
    try { cfg = sanitizeConfig(msg); } catch (e) { sendResponse({ ok: false, error: e.message }); return false; }
    sendResponse({ ok: true });
    startRun(cfg);
    return false;
  }
  return false;
});

function clamp(v, min, max, def) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function sanitizeConfig(msg) {
  const c = msg.config || {};
  let root;
  try { root = new URL(msg.url); } catch { throw new Error('URL của tab hiện tại không hợp lệ.'); }
  if (root.protocol !== 'http:' && root.protocol !== 'https:') throw new Error('Chỉ hỗ trợ trang http hoặc https.');
  // Luôn xuất cả hai bản: PC (responsive) và mobile
  const m = mobileDevice(clamp(c.mobileWidth, 280, 600, 393));
  m.auto = false;
  const devices = [DEVICES.desktop, m];
  const mirror = c.mode === 'mirror';
  return {
    rootUrl: normalizeUrl(root.href),
    mode: mirror ? 'mirror' : 'single',
    maxDepth: mirror ? clamp(c.maxDepth, 0, 10, 2) : 0,
    maxPages: mirror ? clamp(c.maxPages, 1, 5000, 100) : 1,
    delay: clamp(c.delay, 0, 10000, 800),
    includeSub: mirror && !!c.includeSub,
    output: c.output === 'files' ? 'files' : 'bundle',
    inlineSmall: c.inlineSmall !== false,
    manual: !!c.manual,
    robots: mirror && c.robots !== false,
    devices
  };
}

// ===== Chạy =====
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function startRun(cfg) {
  runActive = true;
  cancelled = false;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  setState({ running: true, phase: 'capturing', message: 'Đang khởi động...', percent: 0, error: null, result: null }, true);
  try {
    await executeRun(cfg);
  } catch (e) {
    console.error('[HTTrack] lỗi nghiêm trọng:', e);
    setState({ running: false, phase: 'error', error: e.message || String(e), message: '' }, true);
  } finally {
    clearInterval(keepAlive);
    runActive = false;
    if (state.running) setState({ running: false }, true);
  }
}

async function executeRun(cfg) {
  const startedAt = new Date();
  const rootHost = new URL(cfg.rootUrl).host.toLowerCase();
  const domain = rootHost.replace(/:/g, '_');
  const zipName = `${domain}_${stamp(startedAt)}.zip`;
  const report = new Report({
    rootUrl: cfg.rootUrl, startedAt, devices: cfg.devices.map((d) => d.label), config: cfg
  });
  const zip = new ZipClient();
  await zip.init();

  const ctx = {
    cfg, report, zip, domain, rootHost,
    scope: { rootHost, includeSub: cfg.includeSub },
    robots: null, limitHit: false, totalOk: 0, totalFail: 0, uniquePages: new Set(), pageList: null, fatal: null,
    signals: {}, rootLocals: {}, usedPaths: new Map(), store: null, preSessions: {}
  };

  try {
    if (cfg.robots) {
      const origin = new URL(cfg.rootUrl).origin;
      const r = await fetchBytes(origin + '/robots.txt', { retries: 0, timeoutMs: 10000 });
      if (r.ok) {
        ctx.robots = parseRobots(new TextDecoder().decode(r.bytes));
        report.note('Đã đọc robots.txt, áp dụng quy tắc cho User-agent phù hợp.');
      } else {
        report.note(`Không đọc được robots.txt (${r.reason}) - coi như không có giới hạn.`);
      }
    }

    if (cfg.manual) {
      await openForManual(ctx);
      if (cancelled) {
        setState({ running: false, phase: 'cancelled', message: 'Đã hủy.', percent: 0 }, true);
        return;
      }
    }

    for (let i = 0; i < cfg.devices.length && !cancelled && !ctx.limitHit; i++) {
      try {
        if (cfg.devices[i].auto && !cfg.manual && !(await needMobilePass(ctx, cfg.devices[i]))) continue;
        await runDevicePass(ctx, cfg.devices[i], i);
      } catch (e) {
        console.error('[HTTrack] lỗi lượt', cfg.devices[i].label, e);
        report.note(`Lỗi ở lượt ${cfg.devices[i].label}: ${e.message}`);
        ctx.fatal = ctx.fatal || e;
      }
    }

    if (zip.fileCount === 0) throw ctx.fatal || new Error('Không lưu được trang nào. Xem lại URL hoặc thử lại.');

    if (ctx.rootLocals.responsive && ctx.rootLocals.mobile) {
      await zip.addFile(`${domain}/index.html`, buildLauncher({
        rootUrl: cfg.rootUrl, responsive: ctx.rootLocals.responsive, mobile: ctx.rootLocals.mobile
      }), { compress: true });
    }
    report.meta.cancelled = cancelled;
    report.meta.limitHit = ctx.limitHit;
    report.meta.error = ctx.fatal ? ctx.fatal.message : null;
    await packageZip(ctx, zipName);

    const pages = ctx.uniquePages.size;
    let message = `Hoàn tất: ${pages} trang, ${ctx.totalOk} tài nguyên thành công, ${ctx.totalFail} thất bại (xem report.txt)`;
    if (cancelled) message = 'Đã hủy, lưu phần đã hoàn thành. ' + message;
    if (ctx.limitHit) message = 'Vượt giới hạn 1GB nên đã dừng sớm. ' + message;
    setState({
      running: false, phase: cancelled ? 'cancelled' : 'done', message, percent: 100, error: ctx.fatal ? ctx.fatal.message : null,
      result: { pages, resOk: ctx.totalOk, resFail: ctx.totalFail, zipName }
    }, true);
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon128.png', title: 'HTTrack Extension VN',
      message: `Đã lưu ${pages} trang, ${ctx.totalOk} tài nguyên (${ctx.totalFail} lỗi).`
    });
  } finally {
    for (const s of Object.values(ctx.preSessions)) await s.close();
    await zip.dispose();
  }
}

// Chế độ thủ công: mở sẵn từng bản trong một tab thấy được, chờ người dùng tắt popup / F5 rồi mới quét
async function openForManual(ctx) {
  const { cfg } = ctx;
  setState({ phase: 'capturing', message: 'Đang mở các bản để bạn xử lý popup...', percent: 2 }, true);
  for (let i = 0; i < cfg.devices.length && !cancelled; i++) {
    const device = cfg.devices[i];
    const session = new CaptureSession(device, () => cancelled);
    ctx.preSessions[device.key] = session;
    await session.open(i === 0);
    await session.navigate(cfg.rootUrl);
  }
  if (cancelled) return;
  const names = cfg.devices.map((d) => d.label).join(' và ');
  setState({
    phase: 'waiting', percent: 5,
    message: `Đã mở tab ${names}. Hãy tắt popup (hoặc F5) ở từng tab rồi mở lại popup này và bấm "Tiếp tục quét".`
  }, true);
  chrome.action.setBadgeText({ text: '!' });
  await new Promise((resolve) => { resumeWaiter = resolve; });
  resumeWaiter = null;
  chrome.action.setBadgeText({ text: '' });
  if (!cancelled) setState({ phase: 'capturing', message: 'Đang quét...', percent: 6 }, true);
}

async function packageZip(ctx, zipName) {
  const { zip, report, domain } = ctx;
  setState({ phase: 'packaging', message: 'Đang đóng gói ZIP...', percent: 96 }, true);
  report.meta.finishedAt = new Date();
  await zip.addFile(`${domain}/report.txt`, report.text(), { compress: true });
  await zip.addFile(`${domain}/manifest.json`, report.manifest(), { compress: true });
  const { url } = await zip.finalize();
  const id = await chrome.downloads.download({ url, filename: zipName, saveAs: false });
  await waitDownload(id);
}

function waitDownload(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Tải file ZIP quá lâu.')); }, 15 * 60 * 1000);
    const onChange = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') { cleanup(); resolve(); }
      else if (d.state.current === 'interrupted') { cleanup(); reject(new Error('Tải file ZIP bị gián đoạn.')); }
    };
    const cleanup = () => { clearTimeout(timer); chrome.downloads.onChanged.removeListener(onChange); };
    chrome.downloads.onChanged.addListener(onChange);
    chrome.downloads.search({ id }).then((r) => {
      if (r[0]?.state === 'complete') { cleanup(); resolve(); }
    }).catch(() => {});
  });
}

// Nghỉ nhưng thoát sớm nếu bị hủy
async function politeSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cancelled) await sleep(Math.min(100, end - Date.now()));
}

// Chế độ tự động: chụp thử trang gốc ở khổ mobile, so với bản responsive để quyết định có cần bản mobile riêng
async function needMobilePass(ctx, device) {
  const { cfg, report } = ctx;
  const base = ctx.signals.responsive;
  if (!base) return true;
  setState({ phase: 'capturing', message: 'Đang kiểm tra giao diện mobile của trang...' }, true);
  const session = new CaptureSession(device, () => cancelled);
  try {
    await session.open();
    await session.navigate(cfg.rootUrl);
    await session.waitNetworkIdle();
    const info = await session.collect();
    const ex = processHtml(info.html, 'extract', { baseUrl: info.baseUrl || info.finalUrl });
    const r = isDifferentLayout(base, { cssUrls: [...ex.refs.stylesheets], htmlLen: info.html.length });
    report.note(r.different
      ? `Tự động: trang trả giao diện riêng cho mobile (${r.reason}) - đã lưu thêm bản mobile.`
      : `Tự động: bản responsive đã đủ cho mobile (${r.reason}) - bỏ qua bản mobile riêng.`);
    return r.different;
  } catch (e) {
    report.note('Tự động: không kiểm tra được giao diện mobile (' + e.message + ') - vẫn lưu bản mobile.');
    return true;
  } finally {
    await session.close();
  }
}

// ===== Một lượt thiết bị =====
async function runDevicePass(ctx, device, deviceIndex) {
  const { cfg, report, zip, domain, rootHost, scope } = ctx;
  const label = device.label;
  const prefix = `${domain}/`; // tài nguyên dùng chung ở gốc; mỗi thiết bị có thư mục trang riêng
  const usedPaths = ctx.usedPaths;
  const discover = ctx.pageList === null; // lượt đầu tự khám phá; các lượt sau dùng lại danh sách trang
  const queue = discover
    ? new CrawlQueue({ maxDepth: cfg.maxDepth, maxPages: cfg.maxPages })
    : new CrawlQueue({ maxDepth: 99, maxPages: 1e9 });
  if (discover) queue.tryAdd(cfg.rootUrl, 0);
  else ctx.pageList.forEach((p) => queue.tryAdd(p.url, p.depth));

  // Một kho tài nguyên chung cho mọi thiết bị: cùng URL chỉ tải và lưu một lần
  if (!ctx.store) {
    ctx.store = new AssetStore({
      rootHost, usedPaths, zip, prefix, report, device: label,
      totalBudget: SIZE_LIMIT,
      bundle: cfg.output === 'bundle',
      inlineMax: cfg.inlineSmall ? 6 * 1024 : 0,
      onLimit: () => { ctx.limitHit = true; },
      onProgress: (done, total) => {
        if (state.phase === 'capturing') setState({ message: `Đang tải tài nguyên ${done}/${total}` });
      }
    });
  }
  const store = ctx.store;
  store.device = label;

  const pages = new Map();       // URL chuẩn hóa -> bản ghi trang
  const records = [];            // danh sách bản ghi duy nhất
  const blockedReported = new Set();
  const pre = ctx.preSessions[device.key] || null; // tab đã mở sẵn ở chế độ thủ công
  const session = pre || new CaptureSession(device, () => cancelled);
  session.preloaded = !!pre;
  const pct = (frac) => Math.min(95, Math.round(((deviceIndex + frac) / cfg.devices.length) * 95));

  try {
    if (!pre) await session.open();
    delete ctx.preSessions[device.key];

    let item;
    while (!cancelled && !ctx.limitHit && (item = queue.next())) {
      const idx = queue.index;
      setState({
        phase: 'capturing',
        message: `Đang chụp bản ${label}: trang ${idx}/${queue.total} (depth ${item.depth})`,
        percent: pct((idx - 1) / Math.max(queue.total, 1))
      });
      try {
        const rec = await processPage(item);
        if (rec) {
          records.push(rec);
          pages.set(rec.norm, rec);
          if (rec.finalNorm) pages.set(rec.finalNorm, rec);
        }
      } catch (e) {
        console.error('[HTTrack] lỗi trang', item.url, e);
        report.skipPage(label, item.url, 'lỗi: ' + e.message);
        if (session.detached) throw new Error('Debugger bị ngắt kết nối giữa chừng.');
      }
      if (!cancelled && queue.index < queue.total) await politeSleep(cfg.delay);
    }

    // Lượt cuối: viết lại link <a> nội bộ rồi ghi HTML vào ZIP
    setState({ message: `Đang hoàn thiện bản ${label}...`, percent: pct(0.95) });
    const resolveLink = (norm, key) => {
      const l = pages.get(norm)?.local || store.localFor(key);
      return l && l.startsWith('data:') ? null : l; // ảnh đã gộp không dùng làm đích link
    };
    for (const p of records) {
      const r = processHtml(p.html, 'links', {
        baseUrl: p.baseUrl, fromLocal: p.local, resolveLink,
        isInternal: (u) => hostAllowed(u, rootHost, cfg.includeSub)
      });
      for (const target of new Set(r.unresolved)) report.unresolved.push({ device: label, page: p.url, target });
      await zip.addFile(prefix + p.local, r.html, { compress: true });
      report.pagesSaved.push({ device: label, url: p.url, file: prefix + p.local, depth: p.depth });
      if (p.url.includes('?')) report.queryMap.push({ device: label, url: p.url, file: prefix + p.local });
      p.html = null;
      ctx.uniquePages.add(p.norm);
    }
    queue.warnings.forEach((w) => report.note(w));
    if (discover) ctx.pageList = records.map((p) => ({ url: p.url, depth: p.depth }));
    const rootRec = records.find((p) => p.norm === normalizeUrl(cfg.rootUrl));
    if (rootRec) {
      ctx.rootLocals[device.key] = rootRec.local;
      ctx.signals[device.key] = { cssUrls: rootRec.cssUrls, htmlLen: rootRec.htmlLen };
    }
  } finally {
    await session.close();
    ctx.totalOk = store.okCount;
    ctx.totalFail = store.failCount;
  }

  // ----- Xử lý một trang -----
  async function processPage(item) {
    // Trang gốc ở chế độ thủ công: giữ nguyên trang người dùng đã dọn popup, không tải lại
    if (session.preloaded && item.url === cfg.rootUrl) session.preloaded = false;
    else await session.navigate(item.url);
    if (cancelled) return null;
    if (session.docStatus && session.docStatus >= 400) {
      report.skipPage(label, item.url, `lỗi HTTP ${session.docStatus}`);
      return null;
    }
    await session.waitNetworkIdle();
    await session.scrollThrough();
    await session.revealLazy();
    await session.waitNetworkIdle();
    if (cancelled) return null;
    const broken = await session.waitImages();
    broken.forEach((u) => report.resFail.push({ device: label, url: u, reason: 'ảnh không tải được/quá 10 giây' }));

    const info = await session.collect();
    await session.settleBodies();
    if (!info.finalUrl || /^(chrome-error|about|chrome):/i.test(info.finalUrl)) {
      report.skipPage(label, item.url, 'không mở được trang');
      return null;
    }
    const norm = normalizeUrl(item.url);
    const finalNorm = normalizeUrl(info.finalUrl);
    if (finalNorm) queue.markSeen(finalNorm);
    const baseUrl = info.baseUrl || info.finalUrl;

    session.blockedSeen.forEach((u) => {
      if (!blockedReported.has(u)) { blockedReported.add(u); report.resSkipped.push({ device: label, url: u, reason: 'domain quảng cáo/analytics' }); }
    });
    info.blobs.forEach((u) => report.resSkipped.push({ device: label, url: u, reason: 'blob: URL' }));
    if (info.rotateRemoved) report.note(`[${label}] ${item.url}: đã xóa ${info.rotateRemoved} lớp nhắc xoay màn hình`);
    info.cssErrors.forEach((u) => report.note(`[${label}] không đọc được CSSOM của stylesheet cross-origin: ${u} (vẫn tải file CSS trực tiếp)`));

    // Thu thập tài nguyên: DOM/CSSOM + Network
    const extract = processHtml(info.html, 'extract', { baseUrl, compact: cfg.output === 'bundle' });
    const urls = new Set([...extract.refs.resources, ...info.extra, ...session.bodies.keys()]);
    urls.delete(assetKey(info.finalUrl));
    await store.ensureMany(urls, { bodies: session.bodies });

    // Link: khám phá trang mới và tải file đính kèm (chế độ mirror)
    if (cfg.mode === 'mirror') {
      const docs = new Set();
      for (const href of extract.refs.links) {
        const c = classifyLink(href, baseUrl, scope);
        if (c.action === 'self') continue;
        if (c.action === 'skip') { report.skipPage(label, c.url || href, c.reason); continue; }
        if (c.action === 'resource') { docs.add(assetKey(c.url)); continue; }
        if (!discover) continue;
        if (item.depth >= cfg.maxDepth) { report.skipPage(label, c.url, 'vượt maxDepth'); continue; }
        if (ctx.robots) {
          const u = new URL(c.url);
          if (!ctx.robots(u.pathname + u.search)) { report.skipPage(label, c.url, 'bị robots.txt chặn'); continue; }
        }
        const r = queue.tryAdd(c.url, item.depth + 1);
        if (!r.added && !r.silent) report.skipPage(label, c.url, r.reason);
      }
      await store.ensureMany(docs, { maxBytes: MAX_DOC_BYTES });
    }

    const local = pageLocalPath(item.url, rootHost, usedPaths, device.key);
    // Gói gọn: mọi stylesheet gộp thành một file CSS cạnh file HTML của trang
    let bundle = null;
    if (cfg.output === 'bundle') {
      let cssLocal = local.replace(/\.[^./]+$/, '') + '.css';
      if (usedPaths.has(cssLocal.toLowerCase())) cssLocal = cssLocal.replace(/\.css$/, '_style.css');
      usedPaths.set(cssLocal.toLowerCase(), 'css:' + item.url);
      bundle = { parts: [], cssLocal, cssTextFor: (k) => store.cssTextFor(k) };
    }
    const res = processHtml(info.html, 'resources', {
      baseUrl, fromLocal: local, resolveAsset: (k) => store.localFor(k), isBlocked: isBlockedUrl,
      compact: cfg.output === 'bundle', bundle
    });
    if (bundle && bundle.parts.length) {
      const up = '../'.repeat(bundle.cssLocal.split('/').length - 1); // từ file CSS về thư mục gốc chứa images/
      await zip.addFile(prefix + bundle.cssLocal, bundle.parts.join('\n').replace(/\u0001/g, up), { compress: true });
    }
    if (res.refs.scripts) report.scripts.push({ device: label, url: item.url, count: res.refs.scripts });
    res.refs.iframesRemoved.forEach((u) => report.resSkipped.push({ device: label, url: u, reason: 'iframe quảng cáo/analytics đã xóa' }));
    if (res.refs.baseRemoved) report.note(`[${label}] ${item.url}: đã xóa ${res.refs.baseRemoved} thẻ <base>`);
    return {
      url: item.url, norm, finalNorm, depth: item.depth, local, html: res.html, baseUrl,
      cssUrls: [...extract.refs.stylesheets], htmlLen: info.html.length
    };
  }
}
