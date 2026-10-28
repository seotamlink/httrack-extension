=== HTTrack Static Home ===
Contributors: seotamlink
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.2
License: GPLv2 or later

Upload file ZIP tạo bởi HTTrack Extension VN, plugin tạo một Trang (Page) WordPress thật cho bản đã lưu.
Trang có trong sitemap, dùng được Yoast/Rank Math, đặt làm trang chủ được, và không nạp CSS của theme.

== Cách dùng ==
1. Plugins > Add New > Upload Plugin, chọn httrack-static-home.zip, Activate.
2. Tools (Công cụ) > Trang tĩnh > chọn file ZIP của extension > Upload và tạo trang.
   Tick "Đặt trang này làm trang chủ" nếu muốn dùng làm trang chủ.
3. Sửa tiêu đề, slug, SEO như trang bình thường ở Pages > Edit. Hộp "Trang tĩnh (HTTrack)" có ô mã chèn vào <head> và trước </body>.
4. Hộp "Trang tĩnh (HTTrack)" còn có mục "Thêm rel cho link / nút": chọn nofollow, sponsored, ugc... và phạm vi (link ra ngoài, nút dạng link, hoặc mọi link). Plugin ghi thẳng vào HTML nên Google đọc được. Thẻ có data-htsh-ignore được bỏ qua.
5. Thêm ?htsh_off=1 để quản trị viên xem trang theo theme WordPress.

== Lưu ý ==
Phiên bản 2.0 không còn cài đặt trang chủ kiểu cũ (1.x). Hãy upload lại ZIP để tạo trang.
