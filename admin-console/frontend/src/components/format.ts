const numberFormat = new Intl.NumberFormat('vi-VN')

export const formatNumber = (value: number): string => numberFormat.format(Math.round(value))

export const formatDecimal = (value: number, digits = 1): string => new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: digits,
  minimumFractionDigits: 0,
}).format(value)

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${formatDecimal(bytes / 1024 ** 3)} GB`
  if (bytes >= 1024 ** 2) return `${formatDecimal(bytes / 1024 ** 2, 0)} MB`
  if (bytes >= 1024) return `${formatDecimal(bytes / 1024, 0)} KB`
  return `${formatNumber(bytes)} B`
}

export const formatDate = (value: string): string =>
  new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))

export const formatRelative = (value?: string | null, now = Date.now()): string => {
  if (!value) return 'Chưa gửi'
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000))
  if (seconds < 5) return 'Vừa xong'
  if (seconds < 60) return `${seconds} giây trước`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`
  return formatDate(value)
}

export const formatDuration = (minutes: number): string => {
  if (minutes < 1) return '< 1 phút'
  if (minutes < 60) return `${Math.ceil(minutes)} phút`
  const hours = Math.floor(minutes / 60)
  const rest = Math.ceil(minutes % 60)
  return rest ? `${hours} giờ ${rest} phút` : `${hours} giờ`
}

export type Tone = 'online' | 'paused' | 'error' | 'offline' | 'pairing'

export const runtimeTone = (state: string): Tone => {
  if (state === 'online') return 'online'
  if (state === 'awaiting_claim') return 'pairing'
  if (state === 'paused' || state === 'connecting') return 'paused'
  if (state === 'mqtt_error' || state === 'contract_error') return 'error'
  return 'offline'
}

export const runTone = (status: string): Tone => {
  if (['running', 'queued'].includes(status)) return 'online'
  if (['completed', 'cleaned'].includes(status)) return 'pairing'
  if (['paused', 'partial', 'cleaning', 'cleanup_blocked'].includes(status)) return 'paused'
  if (['failed', 'cleanup_failed'].includes(status)) return 'error'
  return 'offline'
}

export const runStatusLabel = (status: string): string => ({
  queued: 'Đang chờ',
  running: 'Đang tạo',
  paused: 'Tạm dừng',
  completed: 'Hoàn tất',
  partial: 'Thiếu một phần',
  failed: 'Thất bại',
  cancelled: 'Đã hủy',
  cleaning: 'Đang dọn',
  cleaned: 'Đã dọn',
  cleanup_failed: 'Dọn thất bại',
  cleanup_blocked: 'Bị chặn dọn',
}[status] || status)

export const categoryCode = (category?: string): string => ({
  security: 'SEC',
  environment: 'ENV',
  safety: 'SAFE',
  agriculture: 'WTR',
}[category || ''] || 'DEV')

export const readError = (caught: unknown, fallback: string): string =>
  caught instanceof Error && caught.message ? `${fallback} (${caught.message})` : fallback
