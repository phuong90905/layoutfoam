# Layout Xe V16 Preview — Vercel + Neon PostgreSQL

Đây là **bản thử nghiệm**, sử dụng giao diện **Modern Blue V15** với API thay thế Google Apps Script. Chưa chuyển website Production.

## Trạng thái dữ liệu

Đã nhập dữ liệu trên Neon project `layout`, branch `dev-v16`, database `neondb`: 70 vị trí, 59 có xe, 11 trống. Trước lúc chuyển Production phải nhập lại dữ liệu cập nhật mới nhất.

## Bước 1. Chuẩn bị Neon dev-v16

1. Neon Console -> project `layout` -> chọn **branch `dev-v16`**, database `neondb`.
2. SQL Editor: chạy file **`sql/04_mark_dev_v16.sql`** (chỉ chạy trên `dev-v16`). File tạo bảng `admin_login_attempts` và đặt cờ an toàn `V16_DB_TAG=dev-v16`.
3. Chạy **`sql/05_check_v16.sql`** để xem dữ liệu nhập, cờ tag. Không chạy lại file import dữ liệu.
4. Neon -> Connect -> Branch `dev-v16` -> Database `neondb` -> bật **Pooled connection** -> sao chép URL PostgreSQL (chứa mật khẩu). **Không gửi chuỗi URL trong chat và không đưa lên GitHub**.

## Bước 2. Cấu hình Vercel Preview

Trong dự án Vercel `layoutfoam` -> Settings -> Environment Variables, thêm bốn biến **chỉ cho Preview** (nếu được, giới hạn thêm vào Git branch `v16-neon-preview`):

| Key | Value |
|---|---|
| `V16_DATABASE_URL` | URL `postgresql://` của **Neon `dev-v16`**, ưu tiên URL pooled (`-pooler` trong hostname) |
| `V16_EXPECTED_DB_TAG` | `dev-v16` |
| `V16_ADMIN_PIN` | PIN quản trị do bạn đặt (có thể giống PIN hiện tại); nhập dạng secret, ít nhất 6 số được khuyến nghị |
| `V16_SESSION_SECRET` | Một chuỗi ngẫu nhiên khó đoán dài ít nhất 32 ký tự, không dùng lại `GAS_API_SECRET` |

Giữ nguyên `GAS_WEB_APP_URL` và `GAS_API_SECRET` trong môi trường **Production** vì chúng phục vụ phiên bản cũ.

**Lưu ý:** Các biến Neon mà Marketplace tạo tự động có thể trỏ sang branch khác; V16 sử dụng **chính xác `V16_DATABASE_URL`** để tránh nhầm branch. Mỗi lần đổi environment variable, cần deploy mới.

## Bước 3. Deploy thử mà không ảnh hưởng người đang dùng

1. Mở repository GitHub của `layoutfoam`; tạo branch mới từ `main` tên **`v16-neon-preview`** (không cập nhật `main`).
2. Trong branch `v16-neon-preview`, upload đúng cấu trúc file ZIP: `index.html`, `sw.js`, `manifest.webmanifest`, `vercel.json`, `package.json`, `api/gas.js`, `api/v16-status.js`, `lib/neon.js`, `lib/gas-legacy.js`, `icons/`.
3. Commit vào branch `v16-neon-preview`. Vercel sẽ tự tạo bản **Preview** với URL riêng; không ảnh hưởng `layoutfoam.vercel.app`.
4. Mở `https://<preview-url>/api/v16-status`. Dự kiến trả JSON có `ok:true`, `source:"neon-postgresql"`, `counts.total:70`, `counts.filled:59`, `counts.empty:11`, `counts.notes:66`.
5. Mở URL Preview. Kiểm tra cả ba Layout, ghi chú, PO, PWA, bản đồ nhiệt và xuất 4 PNG. Sau đó mở khóa bằng `V16_ADMIN_PIN`, thử thao tác **trên database dev-v16**.

## Điểm khác biệt với GAS

- V15 giao tiếp với `/api/gas` như cũ; endpoint đó giờ xử lý bằng **PostgreSQL** trên Preview.
- Dữ liệu khởi tạo có thể tải trong **1 truy vấn SQL**, thay vì qua GAS.
- Các thao tác ghi được bọc trong PostgreSQL transaction + advisory lock; không ghi đè xe ở ô đích khi **Di chuyển**.
- PIN được cấu hình phía server, token được hash SHA-256 có khóa bí mật trước khi lưu trong bảng sessions. Có hạn chế thử sai PIN theo địa chỉ IP (5 lần/15 phút).
- Thông báo chung `SITE_NOTICE_TITLE`/`SITE_NOTICE_CONTENT` chưa nằm trong Excel: Preview ban đầu hiển thị trống. Admin có thể sao chép thông báo từ bản cũ vào phần cài đặt để lưu vào Neon.
- Không sử dụng Google Sheets khi chạy Preview, không cần sửa `Code.gs`.
- API có nhật ký `activity_logs` phục vụ truy vết.

## Bảo vệ Production

`api/gas.js` **chỉ gọi Neon trong môi trường Preview/Development**. Khi chạy trên `VERCEL_ENV=production`, nếu không đặt `V16_ENABLE_PRODUCTION=1` thì API vẫn tiếp tục chuyển tiếp sang Google Apps Script như phiên bản cũ.

**Không bật `V16_ENABLE_PRODUCTION` hoặc nhập URL Neon Preview vào Production lúc này.** Bản thử nghiệm chưa được kiểm thử trực tiếp với database của bạn. Khi chuyển chính thức cần migration riêng, chụp snapshot mới và kiểm thử lại quyền truy cập.

## Giới hạn/kiểm thử

- File Excel là snapshot; dữ liệu trong Neon **không đồng bộ tự động** với Sheet đang được nhân viên cập nhật.
- Chưa chuyển PIN từ Script Properties (vì không có trong Excel). Người quản trị đặt PIN qua Vercel Preview.
- Một phần cơ chế thử nghiệm cần kiểm thử trực tiếp với Vercel/Neon; mới kiểm tra cú pháp và hợp đồng API phía mã nguồn.
- Nếu cần người khác dùng Preview, hãy kiểm tra giới hạn và bảo vệ Preview Deployment trong Vercel để tránh truy cập ngoài ý muốn.

### Tài liệu
- [Vercel Preview environments](https://vercel.com/docs/deployments/environments)
- [Neon PostgreSQL connection](https://neon.com/docs/get-started/connect-neon)
