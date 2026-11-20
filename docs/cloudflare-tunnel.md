# Truy cập từ ngoài nhà: Cloudflare Tunnel

Cập nhật 2026-11-20. Tunnel chạy trong docker-compose (dịch vụ `cloudflared`),
nên `docker compose up -d` bật cả backend lẫn đường hầm.

| Dịch vụ | Đi ra ngoài bằng | Địa chỉ |
|---|---|---|
| API Gateway | Tên miền công khai | `https://api-datn.lamnguyenxuan.id.vn` |
| real-time-service (WebSocket) | Tên miền công khai | `wss://ws-datn.lamnguyenxuan.id.vn/ws` |
| Máy chủ video (HLS) | **Đường riêng** của tunnel, chỉ máy có Cloudflare One Agent (WARP) | `http://10.250.0.2:8090` |

Vì sao video đi đường riêng: ở gói Free, video qua tên miền công khai của tunnel
chịu giới hạn điều khoản của Cloudflare; đường riêng (private network route) thì
không ([Cloudflare: Delivering videos](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)).
Chi tiết thiết kế: `docs/architecture/camera-contract.md` mục 11.1.

## Các file

- `cloudflared/config.yml`: ID tunnel, hai tên miền công khai (trỏ tới tên dịch vụ
  trong Docker) và `warp-routing` cho đường riêng. Không chứa bí mật.
- File bí mật của tunnel (`C:\Users\<bạn>\.cloudflared\<tunnel-id>.json`, tạo bởi
  `cloudflared tunnel create`) **không** chép vào dự án: `.env` gốc có
  `CLOUDFLARED_CREDENTIALS_FILE=C:/Users/<bạn>/.cloudflared/<tunnel-id>.json`,
  docker-compose gắn file đó chỉ-đọc vào container.
- Mạng Docker `media_net` (10.250.0.0/29) cho máy chủ video địa chỉ cố định
  10.250.0.2; `cloudflared` nằm ở cả `smarthome_net` và `media_net`.
- Cổng 3000/3001/8090 chỉ mở cho chính máy tính (`PUBLISH_HOST`, mặc định
  127.0.0.1); Gateway lấy IP thật của người dùng từ X-Forwarded-For (`TRUST_PROXY`).

## Làm một lần trên Cloudflare

1. **Tổ chức Zero Trust.** Trang Cloudflare → Zero Trust → đặt *team name* và chọn
   gói **Free** (0 USD, tối đa 50 người). Cloudflare vẫn bắt nhập thẻ hoặc PayPal ở
   bước này nhưng gói Free không thu tiền
   ([hướng dẫn](https://developers.cloudflare.com/learning-paths/dns-filtering/account/create-zero-trust-org/)).
2. **Ai được kết nối.** Zero Trust → Settings → WARP Client → *Device enrollment
   permissions* → thêm quy tắc cho phép email của bạn (đăng nhập bằng mã gửi qua email).
3. **Đường riêng tới máy chủ video.** Trong `C:\Cloudflare Tunnel` chạy:
   `cloudflared.exe tunnel route ip add 10.250.0.2/32 caa664b2-91a5-4034-a3ed-3e5694448d9d`
   (hoặc trên trang: Networks → Routes → Create route → Tunnel CIDR).
4. **Split Tunnels.** WARP mặc định bỏ qua mọi địa chỉ 10.x. Zero Trust → Settings
   → WARP Client → Device settings → profile Default → Split Tunnels (chế độ
   Exclude) → Manage: xóa dòng `10.0.0.0/8`, thêm lại `10.0.0.0/9`,
   `10.128.0.0/10`, `10.192.0.0/11`. Như vậy chỉ dải 10.224.0.0–10.255.255.255
   (có 10.250.0.2) đi qua WARP. Thay đổi mất tối đa khoảng 10 phút để tới máy.
5. **Bỏ tên miền video công khai.** DNS của `lamnguyenxuan.id.vn`: xóa bản ghi
   `media-datn`.

## Trên máy tính

1. Tắt cloudflared đang chạy bằng tay trên Windows (cửa sổ cmd, Ctrl+C). Không chạy
   hai nơi cùng lúc: Cloudflare sẽ chia request cho cả hai với cấu hình khác nhau.
2. Thêm vào `.env` gốc:
   `CLOUDFLARED_CREDENTIALS_FILE=C:/Users/Acer/.cloudflared/caa664b2-91a5-4034-a3ed-3e5694448d9d.json`
3. `docker compose up -d`, rồi `docker logs cloudflared`: phải có 4 dòng
   `Registered tunnel connection`.

## Trên điện thoại demo

1. Cài **Cloudflare One Agent** (Google Play), nhập *team name*, đăng nhập bằng
   email (mã gửi về mail), chọn *Install VPN Profile*, bật kết nối.
2. Thử: bật agent, mở trình duyệt vào `http://10.250.0.2:8090/health`.
3. Chạy app: `flutter run --dart-define-from-file=config/cloudflare.json`.
   Tắt agent thì mọi thứ vẫn chạy trừ video camera.

## Kiểm tra nhanh khi có lỗi

- `https://api-datn.lamnguyenxuan.id.vn/health` không mở được: xem
  `docker logs cloudflared` và `docker ps` (api-gateway có chạy không).
- Video không chạy nhưng API chạy: agent đã bật chưa, bước 3–4 phần Cloudflare,
  `http://10.250.0.2:8090/health` trên điện thoại.
- Máy ảo Android (không cần tunnel): `flutter run`, video đi `10.0.2.2:8090`.
