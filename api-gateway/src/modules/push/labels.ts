/**
 * Vietnamese titles of device alerts, the same words the app shows
 * (smarthome_app/lib/features/notifications/notification_labels.dart →
 * eventTitle). A test checks every warning/critical event of the catalog
 * has one.
 */
export function eventTitle(eventName: string, data: Record<string, unknown> = {}): string {
    switch (eventName) {
        case 'smoke_threshold_crossed': return 'Khói vượt ngưỡng';
        case 'gas_threshold_crossed': return 'Khí gas vượt ngưỡng';
        case 'flame_detected': return 'Phát hiện lửa';
        case 'incident_started':
            switch (String(data.cause)) {
                case 'gas': return 'Báo động: rò rỉ khí gas';
                case 'smoke': return 'Báo động: phát hiện khói';
                case 'flame': return 'Báo động: phát hiện lửa';
                case 'sensor_fault': return 'Báo động: cảm biến gặp lỗi';
                default: return 'Báo động an toàn';
            }
        case 'siren_muted': return 'Còi báo động đã tạm tắt';
        case 'pin_access_denied': return 'Nhập sai mã PIN';
        case 'pin_locked_out': return 'Bàn phím tạm khóa do nhập sai nhiều lần';
        case 'door_position_fault': return 'Không xác định được vị trí cửa';
        case 'storage_fault': return 'Camera gặp lỗi bộ nhớ';
        case 'rain_started': return 'Trời bắt đầu mưa';
        case 'water_availability_changed':
            switch (String(data.to)) {
                case 'empty': return 'Bể nước đã cạn';
                case 'low': return 'Bể nước sắp hết';
                default: return 'Mực nước bể thay đổi';
            }
        case 'watering_rejected': return 'Không thể tưới';
        case 'automatic_watering_suppressed': return 'Tạm hoãn tưới tự động';
        default: return eventName.replace(/_/g, ' ');
    }
}

/** Events with their own title above (the rest fall back to the raw name). */
export const TITLED_EVENTS = [
    'smoke_threshold_crossed', 'gas_threshold_crossed', 'flame_detected', 'incident_started', 'siren_muted',
    'pin_access_denied', 'pin_locked_out', 'door_position_fault', 'storage_fault', 'rain_started',
    'water_availability_changed', 'watering_rejected', 'automatic_watering_suppressed',
];

/** 22/12/2026 in Vietnam time. */
export function vietnamDate(value: string | Date): string {
    return new Intl.DateTimeFormat('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(new Date(value));
}

/** 49.000đ */
export function vnd(value: number): string {
    return `${Math.round(value).toLocaleString('vi-VN')}đ`;
}
