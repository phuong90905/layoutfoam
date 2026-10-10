# Layout Xe V11 — PWA trên Vercel

Giữ nguyên API `api/gas.js`, Apps Script `apps-script/Code.gs` và mọi chức năng V10.
Thêm `manifest.webmanifest`, `sw.js`, icon 192/512, meta PWA và đăng ký service worker.

## Cập nhật GitHub
1. Sao lưu repository hoặc tạo branch trước khi cập nhật.
2. Tải nội dung bản V11 lên cùng repository, giữ đúng thư mục `api/`, `icons/`.
3. Bắt buộc cập nhật `index.html`, `vercel.json` và thêm `manifest.webmanifest`, `sw.js`, `icons/icon-192.png`, `icons/icon-512.png`.
4. Nếu đã có `api/gas.js` đang hoạt động, có thể giữ nguyên bản đó; không cần thay `Code.gs` hoặc cấu hình biến môi trường.
5. Commit → Vercel tự deploy. Truy cập website HTTPS trên Chrome Android, menu ⋮ → Cài đặt ứng dụng / Thêm vào màn hình chính.

## Giới hạn offline
Service Worker cache vỏ giao diện và biểu tượng, KHÔNG cache `/api/gas`, dữ liệu Layout, PIN hay ghi chú. Khi mất mạng, giao diện có thể mở nhưng dữ liệu trực tuyến không tải/chỉnh sửa được. Cần mạng để sử dụng đầy đủ.

## Kiểm tra
- `https://<domain>/manifest.webmanifest` trả JSON
- `https://<domain>/sw.js` trả JavaScript (không phải HTML)
- Trên Chrome Android: menu ⋮ → Cài đặt ứng dụng / Thêm vào màn hình chính
- Test PIN, sửa xe, PO, thông báo, xuất 4 ảnh PNG sau deploy.
