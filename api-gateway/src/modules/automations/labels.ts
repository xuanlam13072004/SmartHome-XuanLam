import { eventTitle } from '../push/labels';

/**
 * Vietnamese words for automation states, events and schedules, the same as
 * the app (smarthome_app/lib/features/automations/automation_labels.dart and
 * scenes/scene_labels.dart). Used where the server writes the text: the
 * assistant's drafts and its home data.
 */

const VALUES: Record<string, string> = {
    locked: 'Đã khóa', unlocking: 'Đang mở khóa', unlocked: 'Đã mở khóa', locking: 'Đang khóa',
    closed: 'Đóng', opening: 'Đang mở', open: 'Mở', closing: 'Đang đóng', unknown: 'Không rõ', fault: 'Lỗi',
    ready: 'Sẵn sàng', calibrating: 'Đang hiệu chuẩn', warming_up: 'Đang khởi động', ok: 'Bình thường',
    normal: 'Bình thường', warning: 'Cảnh báo', alarm: 'Báo động', emergency: 'Khẩn cấp',
    sensor_fault: 'Lỗi cảm biến', active: 'Đang có sự cố', acknowledged: 'Đã xác nhận', silent: 'Im lặng',
    sounding: 'Đang kêu', muted: 'Đã tạm tắt', offline: 'Ngoại tuyến', idle: 'Đang chờ', streaming: 'Đang phát',
    unavailable: 'Không khả dụng', recording: 'Đang ghi', stopped: 'Đã dừng', waiting_time_sync: 'Chờ đồng bộ giờ',
    recycling: 'Đang xoay vòng', missing: 'Không có thẻ nhớ', available: 'Đủ nước', low: 'Sắp hết', empty: 'Đã cạn',
    running: 'Đang chạy', manual: 'Thủ công', automatic: 'Tự động', healthy: 'Ổn định', completed: 'Hoàn tất',
};

const BY_STATE: Record<string, Record<string, string>> = {
    incident_state: { idle: 'Không có sự cố' },
    pump_output_state: { stopped: 'Đang dừng' },
};

const BOOLEANS: Record<string, [string, string]> = {
    online: ['Đang kết nối', 'Mất kết nối'],
    rain_detected: ['Có mưa', 'Không mưa'],
    flame_detected: ['Có lửa', 'Không có lửa'],
    pin_configured: ['Đã đặt mã', 'Chưa đặt mã'],
};

const UNITS: Record<string, string> = { celsius: '°C', percent: '%', degree: '°', dbm: ' dBm', second: ' giây' };

const EVENTS: Record<string, string> = {
    lock_changed: 'Khóa đổi trạng thái', door_opened: 'Cửa được mở', door_closed: 'Cửa được đóng',
    pin_access_granted: 'Nhập đúng mã PIN', keypad_action: 'Có thao tác trên bàn phím',
    motion_started: 'Mái bắt đầu chuyển động', motion_completed: 'Mái dừng chuyển động', rain_stopped: 'Trời tạnh mưa',
    button_pressed: 'Nút trên thiết bị được nhấn', incident_started: 'Bắt đầu sự cố an toàn',
    incident_acknowledged: 'Sự cố được xác nhận', incident_resolved: 'Sự cố kết thúc', siren_tested: 'Thử còi báo động',
    watering_started: 'Bắt đầu tưới', watering_stopped: 'Dừng tưới', storage_recycled: 'Bộ nhớ ghi hình xoay vòng',
    recordings_deleted: 'Bản ghi bị xóa', recordings_wiped: 'Toàn bộ bản ghi bị xóa',
};

const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

/** 'instances.door.reported.door_state' → 'door_state'. */
export const stateName = (property: string) => property.split('.').at(-1) ?? property;

/** A state value in words ("open" of door_state → "Mở", 35 °C → "35°C"). */
export function valueLabel(name: string, value: unknown, unit?: string): string {
    if (typeof value === 'boolean') {
        const pair = BOOLEANS[name];
        return pair ? (value ? pair[0] : pair[1]) : (value ? 'Có' : 'Không');
    }
    if (typeof value === 'number') return `${value}${UNITS[unit ?? ''] ?? ''}`;
    return BY_STATE[name]?.[String(value)] ?? VALUES[String(value)] ?? String(value);
}

/** "Trạng thái cửa là Mở", "Độ ẩm đất dưới 30%", "Mưa: Có mưa". */
export function comparisonLabel(label: string, property: string, operator: string, value: unknown, unit?: string): string {
    const text = valueLabel(stateName(property), value, unit);
    if (typeof value === 'boolean') return `${label}: ${text}`;
    const word = operator === 'ne' ? 'không phải' : operator === 'gt' ? 'trên' : operator === 'lt' ? 'dưới' : 'là';
    return `${label} ${word} ${text}`;
}

/** An event in words (informational ones here, alerts as in notifications). */
export function eventLabel(eventName: string): string {
    return EVENTS[eventName] ?? eventTitle(eventName);
}

/** "Hằng ngày", "Thứ 2–6", "Cuối tuần", "T2, T4". */
export function daysLabel(days: number[]): string {
    const set = new Set(days);
    if (set.size === 7) return 'Hằng ngày';
    if (set.size === 5 && [1, 2, 3, 4, 5].every(day => set.has(day))) return 'Thứ 2–6';
    if (set.size === 2 && set.has(6) && set.has(7)) return 'Cuối tuần';
    return [...set].sort((a, b) => a - b).map(day => WEEKDAYS[day - 1]).join(', ');
}

/** "5 phút", "1 giờ 30 phút", "45 giây". */
export function durationLabel(seconds: number): string {
    if (seconds < 60) return `${seconds} giây`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return [hours ? `${hours} giờ` : '', minutes ? `${minutes} phút` : '', rest ? `${rest} giây` : '']
        .filter(Boolean).join(' ');
}
