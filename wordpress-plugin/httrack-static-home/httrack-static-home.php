<?php
/**
 * Plugin Name: HTTrack Static Home
 * Description: Upload file ZIP tạo bởi HTTrack Extension VN, tạo thành một Trang (Page) WordPress thật: có trong sitemap, dùng được Yoast/Rank Math, đặt làm trang chủ được, không bị CSS của theme chen vào.
 * Version: 2.0.0
 * Author: @seotamlink
 * License: GPL-2.0-or-later
 * Text Domain: httrack-static-home
 */

if (!defined('ABSPATH')) {
	exit;
}

class HTTrack_Static_Home {
	const DIR       = 'ban-luu';
	const M_FLAG    = '_htsh_page';
	const M_VARS    = '_htsh_variants';
	const M_MODE    = '_htsh_mode';
	const M_HEAD    = '_htsh_head';
	const M_BODY    = '_htsh_body';
	const M_LINK    = '_htsh_link';
	const M_LINKNEW = '_htsh_link_new';
	const M_LINKSCP = '_htsh_link_scope';
	const M_LINKSEL = '_htsh_link_sel';
	const PLACEHOLD = '<!-- Trang tĩnh do plugin HTTrack Static Home phục vụ. Nội dung nằm trong bản lưu, không sửa ở đây. -->';

	public static function init() {
		add_action('admin_menu', array(__CLASS__, 'menu'));
		add_action('admin_post_htsh_upload', array(__CLASS__, 'handle_upload'));
		add_action('admin_post_htsh_home', array(__CLASS__, 'handle_home'));
		add_action('admin_post_htsh_clear', array(__CLASS__, 'handle_clear'));
		add_action('add_meta_boxes', array(__CLASS__, 'add_box'));
		add_action('save_post_page', array(__CLASS__, 'save_box'), 10, 2);
		add_action('before_delete_post', array(__CLASS__, 'on_delete_post'));
		add_action('admin_notices', array(__CLASS__, 'editor_notice'));
		add_action('template_redirect', array(__CLASS__, 'maybe_serve'), 0);
	}

	/* ---------- Tiện ích ---------- */

	private static function dir_for($id) {
		$u = wp_upload_dir();
		return trailingslashit($u['basedir']) . self::DIR . '/' . (int) $id;
	}

	private static function url_for($id) {
		$u = wp_upload_dir();
		return trailingslashit($u['baseurl']) . self::DIR . '/' . (int) $id;
	}

	private static function is_static_page($id) {
		return $id && get_post_meta($id, self::M_FLAG, true) === '1';
	}

	private static function variants($id) {
		$v = get_post_meta($id, self::M_VARS, true);
		return is_array($v) ? wp_parse_args($v, array('wide' => null, 'narrow' => null)) : array('wide' => null, 'narrow' => null);
	}

	private static function back($type, $msg) {
		$url = add_query_arg(array(
			'page'      => 'httrack-static-home',
			'htsh_type' => $type,
			'htsh_msg'  => rawurlencode($msg),
		), admin_url('tools.php'));
		wp_safe_redirect($url);
		exit;
	}

	private static function rrmdir($dir) {
		if (!is_dir($dir)) {
			return;
		}
		$it = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
			RecursiveIteratorIterator::CHILD_FIRST
		);
		foreach ($it as $f) {
			$f->isDir() && !$f->isLink() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
		}
		@rmdir($dir);
	}

	// Xóa file có thể chạy được trên server (PHP...) để ZIP không thể cài mã độc
	private static function strip_executables($dir) {
		$bad = '/\.(php\d?|phtml|phar|phps|pht|cgi|pl|py|sh)$|^\.htaccess$|^\.user\.ini$/i';
		$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
		foreach ($it as $f) {
			if ($f->isFile() && preg_match($bad, $f->getFilename())) {
				@unlink($f->getPathname());
			}
		}
	}

	// Tìm hai bản: wide (responsive/desktop) và narrow (mobile/iphone)
	private static function detect($dir) {
		$v = array('wide' => null, 'narrow' => null);
		foreach (array('responsive', 'desktop') as $n) {
			if (is_file("$dir/$n/index.html")) {
				$v['wide'] = $n;
				break;
			}
		}
		foreach (array('mobile', 'iphone') as $n) {
			if (is_file("$dir/$n/index.html")) {
				$v['narrow'] = $n;
				break;
			}
		}
		return $v;
	}

	private static function find_root($stage) {
		$cands = array($stage);
		foreach ((array) glob($stage . '/*', GLOB_ONLYDIR) as $d) {
			if (basename($d) !== '__MACOSX') {
				$cands[] = $d;
			}
		}
		foreach ($cands as $c) {
			$v = self::detect($c);
			if ($v['wide'] || $v['narrow']) {
				return array($c, $v);
			}
		}
		return null;
	}

	// Lấy <title> trong bản lưu để làm tiêu đề trang mặc định
	private static function saved_title($root, $variants) {
		$pick = $variants['wide'] ? $variants['wide'] : $variants['narrow'];
		$html = @file_get_contents("$root/$pick/index.html", false, null, 0, 200000);
		if ($html && preg_match('/<title\b[^>]*>(.*?)<\/title>/is', $html, $m)) {
			$t = trim(wp_strip_all_tags(html_entity_decode($m[1], ENT_QUOTES, 'UTF-8')));
			if ($t !== '') {
				return $t;
			}
		}
		return '';
	}

	/* ---------- Trang quản trị ---------- */

	public static function menu() {
		add_management_page('Trang tĩnh', 'Trang tĩnh', 'manage_options', 'httrack-static-home', array(__CLASS__, 'page'));
	}

	private static function static_pages() {
		return get_posts(array(
			'post_type'      => 'page',
			'post_status'    => 'any',
			'meta_key'       => self::M_FLAG,
			'meta_value'     => '1',
			'posts_per_page' => 100,
			'orderby'        => 'date',
			'order'          => 'DESC',
		));
	}

	public static function page() {
		if (!current_user_can('manage_options')) {
			return;
		}
		$pages = self::static_pages();
		$front = (get_option('show_on_front') === 'page') ? (int) get_option('page_on_front') : 0;

		echo '<div class="wrap"><h1>Trang tĩnh (HTTrack Extension VN)</h1>';
		if (!empty($_GET['htsh_msg'])) {
			$cls = (isset($_GET['htsh_type']) && $_GET['htsh_type'] === 'ok') ? 'notice-success' : 'notice-error';
			echo '<div class="notice ' . esc_attr($cls) . '"><p>' . esc_html(rawurldecode(wp_unslash($_GET['htsh_msg']))) . '</p></div>';
		}

		echo '<h2>1. Upload file ZIP</h2>';
		echo '<p>Chọn file ZIP do extension tạo ra. Plugin tạo một <strong>Trang (Page)</strong> WordPress thật cho bản lưu. Dung lượng tối đa máy chủ cho phép: <strong>' . esc_html(size_format(wp_max_upload_size())) . '</strong>.</p>';
		echo '<form method="post" enctype="multipart/form-data" action="' . esc_url(admin_url('admin-post.php')) . '">';
		wp_nonce_field('htsh_upload');
		echo '<input type="hidden" name="action" value="htsh_upload">';
		echo '<table class="form-table" role="presentation">';
		echo '<tr><th>File ZIP</th><td><input type="file" name="bundle" accept=".zip" required></td></tr>';
		echo '<tr><th><label for="htsh_target">Đưa vào</label></th><td><select id="htsh_target" name="target"><option value="0">Tạo trang mới</option>';
		foreach ($pages as $p) {
			echo '<option value="' . (int) $p->ID . '">Thay bản lưu của: ' . esc_html(get_the_title($p) ?: '(không tiêu đề)') . ' (#' . (int) $p->ID . ')</option>';
		}
		echo '</select></td></tr>';
		echo '<tr><th><label for="htsh_title">Tiêu đề trang</label></th><td><input type="text" id="htsh_title" name="title" class="regular-text" placeholder="Để trống: lấy &lt;title&gt; trong bản lưu"> <span class="description">Chỉ dùng khi tạo trang mới.</span></td></tr>';
		echo '<tr><th><label for="htsh_slug">Slug (đường dẫn)</label></th><td><input type="text" id="htsh_slug" name="slug" class="regular-text" placeholder="vd: khuyen-mai"> <span class="description">Chỉ dùng khi tạo trang mới.</span></td></tr>';
		echo '<tr><th>Trang chủ</th><td><label><input type="checkbox" name="make_home" value="1"> Đặt trang này làm trang chủ của website</label></td></tr>';
		echo '</table>';
		submit_button('Upload và tạo trang', 'primary', 'submit', false);
		echo '</form>';

		echo '<h2>2. Các trang tĩnh đã tạo</h2>';
		if (!$pages) {
			echo '<p>Chưa có trang nào.</p>';
		} else {
			echo '<table class="widefat striped"><thead><tr><th>Trang</th><th>Trạng thái</th><th>Bản lưu</th><th>Thao tác</th></tr></thead><tbody>';
			foreach ($pages as $p) {
				$v = self::variants($p->ID);
				$has = $v['wide'] || $v['narrow'];
				echo '<tr><td><strong><a href="' . esc_url(get_edit_post_link($p->ID)) . '">' . esc_html(get_the_title($p) ?: '(không tiêu đề)') . '</a></strong>';
				if ((int) $p->ID === $front) {
					echo ' — <em>Trang chủ</em>';
				}
				echo '<br><a href="' . esc_url(get_permalink($p)) . '" target="_blank">' . esc_html(get_permalink($p)) . '</a></td>';
				echo '<td>' . esc_html(get_post_status_object($p->post_status) ? get_post_status_object($p->post_status)->label : $p->post_status) . '</td>';
				echo '<td>responsive: ' . esc_html($v['wide'] ?: 'không') . '<br>mobile: ' . esc_html($v['narrow'] ?: 'không') . '</td><td>';
				echo '<a class="button" href="' . esc_url(get_edit_post_link($p->ID)) . '">Sửa trang (SEO, slug, mã)</a> ';
				if ((int) $p->ID !== $front) {
					echo '<form style="display:inline" method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
					wp_nonce_field('htsh_home');
					echo '<input type="hidden" name="action" value="htsh_home"><input type="hidden" name="id" value="' . (int) $p->ID . '">';
					submit_button('Đặt làm trang chủ', 'secondary', 'submit', false);
					echo '</form> ';
				}
				if ($has) {
					echo '<form style="display:inline" method="post" action="' . esc_url(admin_url('admin-post.php')) . '" onsubmit="return confirm(\'Xóa file bản lưu của trang này? Trang WordPress vẫn còn.\');">';
					wp_nonce_field('htsh_clear');
					echo '<input type="hidden" name="action" value="htsh_clear"><input type="hidden" name="id" value="' . (int) $p->ID . '">';
					submit_button('Xóa bản lưu', 'delete', 'submit', false);
					echo '</form>';
				}
				echo '</td></tr>';
			}
			echo '</tbody></table>';
		}

		echo '<p class="description" style="margin-top:14px">Quản trị viên thêm <code>?htsh_off=1</code> vào địa chỉ trang để xem trang theo theme WordPress (không phải bản lưu). Nếu dùng plugin cache, hãy xóa cache sau khi upload.</p>';
		echo '</div>';
	}

	/* ---------- Hộp bên trong màn hình sửa trang ---------- */

	public static function add_box() {
		add_meta_box('htsh_box', 'Trang tĩnh (HTTrack)', array(__CLASS__, 'box'), 'page', 'normal', 'high');
	}

	public static function editor_notice() {
		$s = function_exists('get_current_screen') ? get_current_screen() : null;
		if (!$s || $s->base !== 'post' || $s->post_type !== 'page') {
			return;
		}
		$id = isset($_GET['post']) ? (int) $_GET['post'] : 0;
		if (self::is_static_page($id)) {
			echo '<div class="notice notice-info"><p>Trang này hiển thị <strong>bản lưu từ HTTrack</strong>, nội dung trình soạn thảo không được dùng. Tiêu đề, slug, ngày đăng, hộp SEO (Yoast, Rank Math...) vẫn hoạt động như trang bình thường.</p></div>';
		}
	}

	public static function box($post) {
		if (!self::is_static_page($post->ID)) {
			echo '<p>Trang này không phải trang tĩnh. Hãy tạo ở <a href="' . esc_url(admin_url('tools.php?page=httrack-static-home')) . '">Công cụ → Trang tĩnh</a>.</p>';
			return;
		}
		$v    = self::variants($post->ID);
		$mode = get_post_meta($post->ID, self::M_MODE, true) ?: 'auto';
		$can  = current_user_can('unfiltered_html');
		wp_nonce_field('htsh_meta', 'htsh_meta_nonce');
		echo '<p>Bản lưu: responsive <strong>' . esc_html($v['wide'] ?: 'không có') . '</strong>, mobile <strong>' . esc_html($v['narrow'] ?: 'không có') . '</strong>. Thay bản lưu ở <a href="' . esc_url(admin_url('tools.php?page=httrack-static-home')) . '">Công cụ → Trang tĩnh</a>.</p>';
		echo '<p><label>Bản hiển thị: <select name="htsh_mode">';
		$modes = array('auto' => 'Tự động (điện thoại xem bản mobile, máy tính xem bản responsive)', 'wide' => 'Luôn dùng bản responsive/desktop', 'narrow' => 'Luôn dùng bản mobile');
		foreach ($modes as $k => $label) {
			echo '<option value="' . esc_attr($k) . '" ' . selected($mode, $k, false) . '>' . esc_html($label) . '</option>';
		}
		echo '</select></label></p>';
		$scope = get_post_meta($post->ID, self::M_LINKSCP, true) ?: 'buttons';
		echo '<hr><p><strong>Link cho các nút</strong><br><span class="description">Khi khách bấm vào nút trong trang, chuyển tới link này. Để trống thì không áp dụng.</span></p>';
		echo '<p><label for="htsh_link">Link đích</label><br><input type="url" id="htsh_link" name="htsh_link" class="large-text" placeholder="https://..." value="' . esc_attr(get_post_meta($post->ID, self::M_LINK, true)) . '"></p>';
		echo '<p><label><input type="checkbox" name="htsh_link_new" value="1" ' . checked(get_post_meta($post->ID, self::M_LINKNEW, true), '1', false) . '> Mở trong tab mới</label></p>';
		echo '<p><label>Áp dụng cho: <select name="htsh_link_scope">';
		echo '<option value="buttons" ' . selected($scope, 'buttons', false) . '>Chỉ các nút (button, nút dạng link, nút có class btn/button)</option>';
		echo '<option value="all" ' . selected($scope, 'all', false) . '>Nút và mọi link &lt;a&gt; trong trang</option>';
		echo '</select></label></p>';
		echo '<p><label for="htsh_link_sel">Thêm phần tử khác (CSS selector, cách nhau bằng dấu phẩy)</label><br><input type="text" id="htsh_link_sel" name="htsh_link_sel" class="large-text code" placeholder=".dang-ky, #nut-nap, .banner" value="' . esc_attr(get_post_meta($post->ID, self::M_LINKSEL, true)) . '"><br><span class="description">Dùng cho nút làm bằng thẻ khác (div, img...). Phần tử nào có thuộc tính <code>data-htsh-ignore</code> (hoặc nằm trong nó) sẽ không bị chuyển link.</span></p><hr>';
		echo '<p><label for="htsh_head"><strong>Mã chèn vào &lt;head&gt;</strong> (schema, pixel, analytics...)</label><br>';
		echo '<textarea id="htsh_head" name="htsh_head" class="large-text code" rows="5" ' . disabled(!$can, true, false) . '>' . esc_textarea(get_post_meta($post->ID, self::M_HEAD, true)) . '</textarea></p>';
		echo '<p><label for="htsh_body"><strong>Mã chèn trước &lt;/body&gt;</strong> (popup, form, link nổi...)</label><br>';
		echo '<textarea id="htsh_body" name="htsh_body" class="large-text code" rows="7" ' . disabled(!$can, true, false) . '>' . esc_textarea(get_post_meta($post->ID, self::M_BODY, true)) . '</textarea></p>';
		if (!$can) {
			echo '<p class="description">Tài khoản của bạn không có quyền <code>unfiltered_html</code> nên không sửa được hai ô mã.</p>';
		}
	}

	public static function save_box($post_id, $post) {
		if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
			return;
		}
		if (!isset($_POST['htsh_meta_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['htsh_meta_nonce'])), 'htsh_meta')) {
			return;
		}
		if (!current_user_can('edit_post', $post_id) || !self::is_static_page($post_id)) {
			return;
		}
		$mode = isset($_POST['htsh_mode']) ? sanitize_key(wp_unslash($_POST['htsh_mode'])) : 'auto';
		update_post_meta($post_id, self::M_MODE, in_array($mode, array('auto', 'wide', 'narrow'), true) ? $mode : 'auto');
		$link  = isset($_POST['htsh_link']) ? esc_url_raw(trim(wp_unslash($_POST['htsh_link']))) : '';
		$scope = isset($_POST['htsh_link_scope']) ? sanitize_key(wp_unslash($_POST['htsh_link_scope'])) : 'buttons';
		update_post_meta($post_id, self::M_LINK, $link);
		update_post_meta($post_id, self::M_LINKNEW, !empty($_POST['htsh_link_new']) ? '1' : '');
		update_post_meta($post_id, self::M_LINKSCP, $scope === 'all' ? 'all' : 'buttons');
		update_post_meta($post_id, self::M_LINKSEL, sanitize_text_field(wp_unslash(isset($_POST['htsh_link_sel']) ? $_POST['htsh_link_sel'] : '')));
		if (current_user_can('unfiltered_html')) {
			update_post_meta($post_id, self::M_HEAD, wp_unslash(isset($_POST['htsh_head']) ? $_POST['htsh_head'] : ''));
			update_post_meta($post_id, self::M_BODY, wp_unslash(isset($_POST['htsh_body']) ? $_POST['htsh_body'] : ''));
		}
	}

	public static function on_delete_post($post_id) {
		if (self::is_static_page($post_id)) {
			self::rrmdir(self::dir_for($post_id));
		}
	}

	/* ---------- Xử lý form ---------- */

	public static function handle_upload() {
		if (!current_user_can('manage_options')) {
			wp_die('Bạn không đủ quyền.');
		}
		check_admin_referer('htsh_upload');

		$f = isset($_FILES['bundle']) ? $_FILES['bundle'] : null;
		if (!$f || $f['error'] !== UPLOAD_ERR_OK || empty($f['tmp_name'])) {
			$code = $f ? $f['error'] : '?';
			self::back('error', 'Upload thất bại (mã lỗi ' . $code . '). File có thể lớn hơn giới hạn ' . size_format(wp_max_upload_size()) . ' của máy chủ.');
		}
		if (strtolower(pathinfo($f['name'], PATHINFO_EXTENSION)) !== 'zip') {
			self::back('error', 'Chỉ nhận file .zip.');
		}
		$target = isset($_POST['target']) ? (int) $_POST['target'] : 0;
		if ($target && !self::is_static_page($target)) {
			self::back('error', 'Trang được chọn không phải trang tĩnh.');
		}

		require_once ABSPATH . 'wp-admin/includes/file.php';
		WP_Filesystem();

		$u     = wp_upload_dir();
		$stage = trailingslashit($u['basedir']) . self::DIR . '-tmp-' . wp_generate_password(6, false);
		wp_mkdir_p($stage);

		$r = unzip_file($f['tmp_name'], $stage);
		if (is_wp_error($r)) {
			self::rrmdir($stage);
			self::back('error', 'Không giải nén được: ' . $r->get_error_message());
		}
		self::strip_executables($stage);

		$found = self::find_root($stage);
		if (!$found) {
			self::rrmdir($stage);
			self::back('error', 'Không thấy thư mục responsive/ hoặc mobile/ có index.html. ZIP phải do HTTrack Extension VN tạo.');
		}
		list($root, $variants) = $found;

		$id = $target;
		if (!$id) {
			$title = isset($_POST['title']) ? sanitize_text_field(wp_unslash($_POST['title'])) : '';
			if ($title === '') {
				$title = self::saved_title($root, $variants);
			}
			if ($title === '') {
				$title = 'Trang tĩnh';
			}
			$slug = isset($_POST['slug']) ? sanitize_title(wp_unslash($_POST['slug'])) : '';
			$args = array(
				'post_type'    => 'page',
				'post_status'  => 'publish',
				'post_title'   => $title,
				'post_content' => self::PLACEHOLD,
			);
			if ($slug !== '') {
				$args['post_name'] = $slug;
			}
			$id = wp_insert_post($args, true);
			if (is_wp_error($id) || !$id) {
				self::rrmdir($stage);
				self::back('error', 'Không tạo được trang: ' . (is_wp_error($id) ? $id->get_error_message() : '?'));
			}
			update_post_meta($id, self::M_FLAG, '1');
			update_post_meta($id, self::M_MODE, 'auto');
		}

		$dest = self::dir_for($id);
		self::rrmdir($dest);
		wp_mkdir_p(dirname($dest));
		if (!@rename($root, $dest)) {
			self::rrmdir($stage);
			self::back('error', 'Không di chuyển được thư mục. Kiểm tra quyền ghi của wp-content/uploads.');
		}
		self::rrmdir($stage);
		update_post_meta($id, self::M_VARS, $variants);

		if (!empty($_POST['make_home'])) {
			update_option('show_on_front', 'page');
			update_option('page_on_front', $id);
		}
		self::back('ok', 'Đã upload. Trang: ' . get_permalink($id) . ' (nếu dùng plugin cache, hãy xóa cache).');
	}

	public static function handle_home() {
		if (!current_user_can('manage_options')) {
			wp_die('Bạn không đủ quyền.');
		}
		check_admin_referer('htsh_home');
		$id = isset($_POST['id']) ? (int) $_POST['id'] : 0;
		if (!self::is_static_page($id)) {
			self::back('error', 'Trang không hợp lệ.');
		}
		update_option('show_on_front', 'page');
		update_option('page_on_front', $id);
		self::back('ok', 'Đã đặt làm trang chủ.');
	}

	public static function handle_clear() {
		if (!current_user_can('manage_options')) {
			wp_die('Bạn không đủ quyền.');
		}
		check_admin_referer('htsh_clear');
		$id = isset($_POST['id']) ? (int) $_POST['id'] : 0;
		if (!self::is_static_page($id)) {
			self::back('error', 'Trang không hợp lệ.');
		}
		self::rrmdir(self::dir_for($id));
		update_post_meta($id, self::M_VARS, array('wide' => null, 'narrow' => null));
		self::back('ok', 'Đã xóa bản lưu. Trang sẽ hiển thị theo theme cho tới khi bạn upload lại.');
	}

	/* ---------- Dựng HTML trả về ---------- */

	/*
	 * Ghép bản lưu với phần <head> do WordPress/SEO plugin sinh ra.
	 * Dùng preg_replace_callback để chuỗi người dùng nhập (có $1, \) không bị hiểu nhầm là tham chiếu regex.
	 */
	public static function render_html($html, $base, $wp_head, $fallback_title, $head_code, $body_code, $btn = null) {
		$strip = function ($pattern) use (&$html) {
			$html = preg_replace($pattern, '', $html);
		};

		// Không để CSS lọt vào từ wp_head: tránh xung đột với CSS của bản lưu
		$wp_head = preg_replace('/<style\b[^>]*>.*?<\/style>\s*/is', '', $wp_head);
		$wp_head = preg_replace('/<link\b[^>]*\brel\s*=\s*["\']?stylesheet[^>]*>\s*/i', '', $wp_head);

		$top = '<base href="' . $base . '">';

		// Tiêu đề, mô tả, canonical, Open Graph: ưu tiên của WordPress/SEO plugin, bỏ thẻ cũ trong bản lưu
		$strip('/<title\b[^>]*>.*?<\/title>\s*/is');
		if (!preg_match('/<title\b/i', $wp_head)) {
			$top .= '<title>' . $fallback_title . '</title>';
		}
		if (preg_match('/<meta\b[^>]*\bname\s*=\s*["\']description["\']/i', $wp_head)) {
			$strip('/<meta\b[^>]*\bname\s*=\s*["\']description["\'][^>]*>\s*/i');
		}
		if (preg_match('/<link\b[^>]*\brel\s*=\s*["\']canonical["\']/i', $wp_head)) {
			$strip('/<link\b[^>]*\brel\s*=\s*["\']canonical["\'][^>]*>\s*/i');
		}
		if (preg_match('/<meta\b[^>]*\bproperty\s*=\s*["\']og:/i', $wp_head)) {
			$strip('/<meta\b[^>]*\bproperty\s*=\s*["\']og:[^>]*>\s*/i');
		}
		if (preg_match('/<meta\b[^>]*\bname\s*=\s*["\']twitter:/i', $wp_head)) {
			$strip('/<meta\b[^>]*\bname\s*=\s*["\']twitter:[^>]*>\s*/i');
		}
		$top .= $wp_head;

		$count = 0;
		$html = preg_replace_callback('/<head(\s[^>]*)?>/i', function ($m) use ($top) {
			return $m[0] . $top;
		}, $html, 1, $count);
		if (!$count) {
			$html = $top . $html;
		}

		if ($head_code !== '') {
			$n = 0;
			$html = preg_replace_callback('/<\/head>/i', function ($m) use ($head_code) {
				return $head_code . $m[0];
			}, $html, 1, $n);
			if (!$n) {
				$html .= $head_code;
			}
		}

		// Link dạng #muc phải cuộn tại chỗ, không nhảy sang thư mục bản lưu do thẻ <base>
		$tail  = '<script>document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href^=\'#\']");if(!a)return;var id=a.getAttribute("href").slice(1);if(!id)return;var el=document.getElementById(id);if(el){e.preventDefault();el.scrollIntoView();}});</script>';
		if ($btn && !empty($btn['url'])) {
			$cfg   = array(
				'url'   => $btn['url'],
				'blank' => !empty($btn['blank']),
				'sel'   => $btn['scope'] === 'all'
					? 'button,input[type=button],input[type=submit],input[type=reset],[role=button],a[href],.btn,.button'
					: 'button,input[type=button],input[type=submit],input[type=reset],[role=button],a[class*=btn],a[class*=button],.btn,.button',
				'extra' => isset($btn['extra']) ? $btn['extra'] : '',
			);
			$json  = json_encode($cfg, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_UNICODE);
			$tail .= '<script>(function(c){function m(t,s){try{return t.closest(s)}catch(x){return null}}document.addEventListener("click",function(e){var t=e.target;if(!t||!t.closest||m(t,"[data-htsh-ignore]"))return;var el=m(t,c.sel)||(c.extra?m(t,c.extra):null);if(!el)return;e.preventDefault();e.stopPropagation();if(c.blank){window.open(c.url,"_blank","noopener")}else{location.href=c.url}},true)})(' . $json . ');</script>';
		}
		$tail .= $body_code;
		$n = 0;
		$html = preg_replace_callback('/<\/body>/i', function ($m) use ($tail) {
			return $tail . $m[0];
		}, $html, 1, $n);
		if (!$n) {
			$html .= $tail;
		}
		return $html;
	}

	/* ---------- Phục vụ trang ---------- */

	public static function maybe_serve() {
		if (is_admin() || is_feed() || is_embed() || !is_singular('page')) {
			return;
		}
		$id = (int) get_queried_object_id();
		if (!self::is_static_page($id) || post_password_required($id)) {
			return;
		}
		if (isset($_GET['htsh_off']) && current_user_can('manage_options')) {
			return;
		}

		$v    = self::variants($id);
		$mode = get_post_meta($id, self::M_MODE, true) ?: 'auto';
		$pick = null;
		if ($mode === 'narrow' && $v['narrow']) {
			$pick = $v['narrow'];
		} elseif ($mode === 'auto' && $v['narrow'] && $v['wide']) {
			$pick = wp_is_mobile() ? $v['narrow'] : $v['wide'];
		}
		if (!$pick) {
			$pick = $v['wide'] ? $v['wide'] : $v['narrow'];
		}
		if (!$pick) {
			return;
		}

		$file = self::dir_for($id) . '/' . $pick . '/index.html';
		if (!is_readable($file)) {
			return;
		}
		$html = file_get_contents($file);
		$base = esc_url(trailingslashit(self::url_for($id) . '/' . rawurlencode($pick)));

		// Chỉ lấy phần SEO từ wp_head: tắt việc nạp CSS/JS của theme và plugin, ẩn admin bar
		remove_all_actions('wp_enqueue_scripts');
		remove_action('wp_head', 'wp_custom_css_cb', 101);
		add_filter('show_admin_bar', '__return_false');
		ob_start();
		wp_head();
		$wp_head = ob_get_clean();

		$html = self::render_html(
			$html,
			$base,
			$wp_head,
			esc_html(wp_get_document_title()),
			(string) get_post_meta($id, self::M_HEAD, true),
			(string) get_post_meta($id, self::M_BODY, true),
			array(
				'url'   => (string) get_post_meta($id, self::M_LINK, true),
				'blank' => get_post_meta($id, self::M_LINKNEW, true) === '1',
				'scope' => get_post_meta($id, self::M_LINKSCP, true) ?: 'buttons',
				'extra' => (string) get_post_meta($id, self::M_LINKSEL, true),
			)
		);

		status_header(200);
		header('Content-Type: text/html; charset=utf-8');
		header('Vary: User-Agent');
		echo $html; // phải xuất nguyên văn HTML đã lưu
		exit;
	}
}

HTTrack_Static_Home::init();
