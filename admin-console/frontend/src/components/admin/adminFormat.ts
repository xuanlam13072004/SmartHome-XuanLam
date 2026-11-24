import type { AccountStatus, AdminAuditItem, AdminOrder, AssistantOutcome } from '../../types'
import { formatNumber } from '../format'

export const formatVnd = (value: number): string => `${formatNumber(value)} đ`

const compact = new Intl.NumberFormat('vi-VN', { notation: 'compact', maximumFractionDigits: 1 })

/** Axis ticks: 1,5 Tr instead of 1.500.000. */
export const formatCompact = (value: number): string => (Math.abs(value) >= 10000 ? compact.format(value) : formatNumber(value))

/** '2026-11-23' → '23/11'. */
export const formatDay = (day: string): string => {
  const [, month, date] = day.split('-')
  return `${Number(date)}/${Number(month)}`
}

export const formatDateOnly = (value: string): string =>
  new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short' }).format(new Date(value))

export const accountStatusLabel: Record<AccountStatus, string> = {
  active: 'Hoạt động',
  disabled: 'Đã khóa',
  pending_deletion: 'Chờ xóa',
}

export const accountStatusTone = (status: AccountStatus): 'online' | 'error' | 'offline' =>
  status === 'active' ? 'online' : status === 'disabled' ? 'error' : 'offline'

export const orderStatusLabel: Record<AdminOrder['status'], string> = {
  pending: 'Chờ chuyển khoản',
  expired: 'QR hết hạn',
  review: 'Thiếu tiền',
  paid: 'Đã trả',
  cancelled: 'Đã hủy',
}

export const paidViaLabel: Record<NonNullable<AdminOrder['paid_via']>, string> = {
  sepay: 'SePay',
  manual: 'Xác nhận tay',
  mock: 'Thử nghiệm',
}

export const transferOutcomeLabel: Record<string, string> = {
  unmatched: 'Không khớp đơn nào',
  already_paid: 'Đơn đã trả trước đó',
}

export const auditActionLabel: Record<string, string> = {
  'account.disabled': 'Khóa tài khoản khách',
  'account.enabled': 'Mở khóa tài khoản khách',
  'account.signed_out': 'Đăng xuất mọi thiết bị',
  'plan.gifted': 'Tặng/gia hạn gói',
  'payment.confirmed': 'Xác nhận thanh toán',
  'payment.cancelled': 'Hủy đơn',
  'staff.created': 'Thêm nhân viên',
  'staff.updated': 'Sửa quyền nhân viên',
  'staff.disabled': 'Khóa nhân viên',
  'staff.enabled': 'Mở khóa nhân viên',
  'staff.password_reset': 'Đặt lại mật khẩu nhân viên',
  'staff.signed_out': 'Đăng xuất nhân viên',
  'simulator.request': 'Thao tác Simulator',
  'weather.mock_set': 'Đặt thời tiết giả lập',
  'weather.mock_cleared': 'Bỏ thời tiết giả lập',
}

/** Who did it: the staff member's name, a CLI tool, or the page before staff accounts existed. */
export const actorLabel = (actor: AdminAuditItem['actor']): string => {
  if (actor.kind === 'staff') return actor.name || actor.email || 'Nhân viên đã xóa'
  if (actor.kind === 'cli') return 'Lệnh CLI'
  return 'Trang Quản trị (cũ)'
}

export const outcomeLabel: Record<AssistantOutcome, string> = {
  chat: 'Trò chuyện',
  action: 'Điều khiển',
  clarify: 'Hỏi lại',
  confirm: 'Chờ xác nhận',
  refused: 'Từ chối',
  error: 'Lỗi',
}

export const platformLabel = (platform: string): string => ({
  android: 'Android', ios: 'iOS', web: 'Web', windows: 'Windows', macos: 'macOS', linux: 'Linux',
} as Record<string, string>)[platform] ?? 'Không rõ'

export const roleLabel = (role: string): string => ({
  owner: 'Chủ', controller: 'Điều khiển', viewer: 'Chỉ xem',
} as Record<string, string>)[role] ?? role

/** One line about what an entry changed: "Cơ bản · 30 ngày", "SHABCD2345 · 49.000 đ". */
export const auditDetail = (item: AdminAuditItem): string => {
  const details = item.details
  if (item.action === 'plan.gifted') return `${String(details.plan_name ?? details.plan_code)} · ${formatNumber(Number(details.days))} ngày`
  if (item.action === 'payment.confirmed') {
    return `${String(details.code)} · ${formatVnd(Number(details.amount_vnd ?? 0))}${details.outcome === 'partial' ? ' (còn thiếu)' : ''}`
  }
  if (item.action === 'payment.cancelled') return String(details.code)
  if (item.action === 'simulator.request') return `${String(details.method)} ${String(details.path)}`
  if (item.action.startsWith('weather.')) {
    const area = details.area === 'all' ? 'Mọi nơi' : String(details.area)
    return details.scenario ? `${area} · ${String(details.scenario)}` : area
  }
  const staff = details.staff as { email?: string } | undefined
  if (item.action.startsWith('staff.') && staff?.email) return staff.email
  if (typeof details.signed_out_sessions === 'number') return `${formatNumber(details.signed_out_sessions)} phiên đăng xuất`
  return ''
}
