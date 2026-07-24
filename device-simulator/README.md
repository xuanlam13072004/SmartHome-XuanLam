# Device Simulator

Đây là hệ thống giả lập User và Thiết bị IoT (MQTT) cho SmartHome-XuanLam.
Hệ thống giúp tạo ra hàng nghìn thiết bị ảo và người dùng ảo hoạt động hoàn toàn giống như thật, bao gồm cả quá trình Provisioning, Claiming, kết nối MQTT, gửi Telemetry, và nhận Command.

## Cấu trúc thư mục

- `backend/`: Node.js + Fastify server để quản lý generation logic và giữ kết nối MQTT.
- `frontend/`: React + Vite dashboard để giám sát, điều khiển và quản lý Simulation Runs.

## Yêu cầu
- Node.js 20+
- PostgreSQL
- MongoDB
- MQTT Broker (Mosquitto)

## Chạy dự án (Phát triển)

**Backend:**
```bash
cd backend
npm install
npm run dev
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```
