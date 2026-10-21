/*
 * popup.js — Giao diện popup: đọc tab hiện tại, gửi lệnh start/cancel cho service worker
 * và hiển thị tiến độ thời gian thực từ chrome.storage.session. Không có inline script.
 */
const STATE_KEY = 'httrack_state';
const CFG_KEY = 'httrack_cfg';
const $ = (id) => document.getElementById(id);

let currentTab = null;
let running = false;

const inputs = ['maxDepth', 'maxPages', 'delay', 'includeSub', 'robots', 'devDesktop', 'mobileMode', 'mobileWidth'];

function getMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function readConfig() {
  return {
    mode: getMode(),
    maxDepth: Number($('maxDepth').value),
    maxPages: Number($('maxPages').value),
    delay: Number($('delay').value),
    includeSub: $('includeSub').checked,
    robots: $('robots').checked,
    desktop: $('devDesktop').checked,
    mobileMode: $('mobileMode').value,
    mobileWidth: Number($('mobileWidth').value)
  };
}

function applyConfig(c) {
  if (!c) return;
  document.querySelector(`input[name="mode"][value="${c.mode === 'mirror' ? 'mirror' : 'single'}"]`).checked = true;
  if (c.maxDepth != null) $('maxDepth').value = c.maxDepth;
  if (c.maxPages != null) $('maxPages').value = c.maxPages;
  if (c.delay != null) $('delay').value = c.delay;
  $('includeSub').checked = !!c.includeSub;
  $('robots').checked = c.robots !== false;
  $('devDesktop').checked = c.desktop !== false;
  $('mobileMode').value = c.mobileMode || (c.mobile === true ? 'on' : 'auto');
  if (c.mobileWidth != null) $('mobileWidth').value = c.mobileWidth;
}

function updateModeUi() {
  $('mirrorBox').hidden = getMode() !== 'mirror';
  $('mobileWidthRow').hidden = $('mobileMode').value === 'off';
}

function showError(text) {
  $('error').hidden = !text;
  $('error').textContent = text || '';
}

function setLocked(locked) {
  document.querySelectorAll('input, select').forEach((el) => { el.disabled = locked; });
}

function render(state) {
  running = !!(state && state.running);
  setLocked(running);
  const btn = $('mainBtn');
  btn.textContent = running ? 'Hủy' : 'Bắt đầu lưu';
  btn.classList.toggle('cancel', running);
  btn.disabled = !running && !currentTab;
  const hasProgress = running || (state && (state.phase === 'done' || state.phase === 'cancelled'));
  $('progressWrap').hidden = !hasProgress;
  $('progressBar').style.width = (state ? state.percent || 0 : 0) + '%';
  $('status').textContent = state ? state.message || '' : '';
  showError(state && state.error ? state.error : '');
}

async function loadState() {
  const data = await chrome.storage.session.get(STATE_KEY);
  render(data[STATE_KEY]);
}

async function start() {
  showError('');
  const cfg = readConfig();
  if (!cfg.desktop && cfg.mobileMode === 'off') { showError('Hãy bật bản Responsive hoặc bản mobile.'); return; }
  if (!currentTab || !/^https?:/i.test(currentTab.url || '')) { showError('Chỉ lưu được trang http hoặc https.'); return; }
  try { await chrome.storage.local.set({ [CFG_KEY]: cfg }); } catch (e) { /* không quan trọng */ }
  $('mainBtn').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'start', url: currentTab.url, tabId: currentTab.id, config: cfg });
  if (!res || !res.ok) {
    showError((res && res.error) || 'Không gửi được lệnh tới service worker.');
    $('mainBtn').disabled = false;
  }
}

async function cancel() {
  $('mainBtn').disabled = true;
  await chrome.runtime.sendMessage({ type: 'cancel' });
  $('status').textContent = 'Đang hủy, sẽ lưu phần đã hoàn thành...';
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  $('tabUrl').textContent = truncate((tab && tab.url) || '(không có tab)', 60);
  $('tabUrl').title = (tab && tab.url) || '';

  const saved = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY];
  applyConfig(saved);
  updateModeUi();

  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', updateModeUi));
  $('mobileMode').addEventListener('change', updateModeUi);
  // Không cho tắt cả hai: bỏ Responsive thì bản mobile không được là "Tắt"
  $('devDesktop').addEventListener('change', () => {
    if (!$('devDesktop').checked && $('mobileMode').value === 'off') $('mobileMode').value = 'on';
    updateModeUi();
  });
  $('mainBtn').addEventListener('click', () => (running ? cancel() : start()));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[STATE_KEY]) render(changes[STATE_KEY].newValue);
  });
  await loadState();
}

init().catch((e) => showError('Lỗi khởi tạo popup: ' + e.message));
