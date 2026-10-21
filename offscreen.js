/*
 * offscreen.js — Chạy trong offscreen document (lý do BLOBS).
 * Nhận từng file từ service worker, đưa vào JSZip, cuối cùng tạo Blob URL của file ZIP.
 */
import { ZipSink } from './zip.js';

const sink = new ZipSink(self.JSZip);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    try {
      switch (msg.type) {
        case 'zip-init': sink.reset(); sendResponse({ ok: true }); break;
        case 'zip-add': sink.add(msg); sendResponse({ ok: true }); break;
        case 'zip-finalize': sendResponse({ ok: true, ...(await sink.finalize()) }); break;
        case 'zip-dispose': sink.reset(); sendResponse({ ok: true }); break;
        default: sendResponse({ ok: false, error: 'Lệnh không hợp lệ: ' + msg.type });
      }
    } catch (e) {
      console.error('[HTTrack] offscreen lỗi:', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});
