# HTTrack Extension VN

Tiện ích Chrome (Manifest V3, JavaScript thuần) lưu một trang hoặc cả website thành file ZIP để xem offline.

## Tính năng
- Chế độ **Chỉ trang hiện tại** hoặc **Mirror website** (BFS theo độ sâu, số trang, độ trễ, robots.txt, subdomain).
- Một bản **Responsive** tự co giãn; bản **Mobile riêng** (bề rộng tùy chọn) ở chế độ Tự động / Luôn lưu / Tắt.
- Tải ảnh, CSS, font; viết lại đường dẫn tương đối; link giữa các trang đã lưu hoạt động offline.
- Bỏ toàn bộ script nên trang offline không có tương tác.
- Tạo `report.txt` và `manifest.json` trong ZIP.

## Cài đặt
1. Mở `chrome://extensions`, bật **Developer mode**.
2. Chọn **Load unpacked** và trỏ tới thư mục này.
3. Mở trang cần lưu, bấm biểu tượng tiện ích, chọn chế độ rồi **Bắt đầu lưu**.

Giải nén ZIP rồi mở bằng VS Code Live Server (không nên bấm đúp file HTML).

## Kiểm thử
Trong console của service worker, gõ `httrackTests()` để chạy các test của `naming.js`, `crawler.js`, `rewrite.js`.

## Giới hạn
Canvas/WebGL động, video streaming (HLS/DASH), nội dung chỉ hiện sau thao tác (tab, accordion), trang yêu cầu đăng nhập hoặc có Cloudflare challenge, danh sách ảo, và mất tương tác do bỏ script.

Thư viện: [JSZip](https://stuk.github.io/jszip/) 3.10.1 (`lib/jszip.min.js`).

Thiết kế bởi @seotamlink
