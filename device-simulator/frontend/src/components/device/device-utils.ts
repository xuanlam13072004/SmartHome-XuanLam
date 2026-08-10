import type {
  CapabilityInstance,
  CapabilityProperty,
  DeviceStatePatch,
  SimulatedDevice,
} from '../../types'

const unitNames: Record<string, string> = {
  celsius: '°C',
  percent: '%',
  second: 'giây',
  millisecond: 'ms',
  volt: 'V',
  ampere: 'A',
  watt: 'W',
  kilowatt_hour: 'kWh',
  lux: 'lx',
  dbm: 'dBm',
}

const knownLabels: Record<string, string> = {
  online: 'Trực tuyến',
  offline: 'Ngoại tuyến',
  paused: 'Tạm dừng',
  locked: 'Đã khóa',
  unlocked: 'Đã mở khóa',
  locking: 'Đang khóa',
  unlocking: 'Đang mở khóa',
  opening: 'Đang mở',
  closing: 'Đang đóng',
  stopped: 'Đã dừng',
  running: 'Đang chạy',
  enabled: 'Đã bật',
  disabled: 'Đã tắt',
  normal: 'Bình thường',
  warning: 'Cảnh báo',
  critical: 'Nguy hiểm',
  sounding: 'Đang kêu',
  silent: 'Im lặng',
  muted: 'Đã tắt âm',
  detected: 'Đã phát hiện',
  clear: 'Không phát hiện',
  available: 'Sẵn sàng',
  unavailable: 'Không sẵn sàng',
  unknown: 'Chưa xác định',
  firmware: 'Firmware',
  authentication: 'Xác thực',
  safety: 'An toàn',
  custom: 'Tùy chỉnh',
}

export const instanceLabel = (instance: CapabilityInstance): string =>
  instance.presentation?.display_name || humanize(instance.instance_id)

export const propertyLabel = (property: CapabilityProperty): string =>
  property.presentation?.label || humanize(property.id)

export const humanize = (value: string): string => {
  const known = knownLabels[value.toLowerCase()]
  if (known) return known
  const words = value.replace(/[._-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—'
}

export const unitLabel = (unit?: string): string => unit ? unitNames[unit] || unit : ''

export const formatValue = (value: unknown, property?: CapabilityProperty): string => {
  if (value === null || value === undefined || value === '') return 'Chưa có dữ liệu'
  if (typeof value === 'boolean') return value ? 'Bật' : 'Tắt'
  if (typeof value === 'number') {
    const precision = property?.precision ?? (Number.isInteger(value) ? 0 : 1)
    const formatted = new Intl.NumberFormat('vi-VN', {
      maximumFractionDigits: precision,
      minimumFractionDigits: 0,
    }).format(value)
    const unit = unitLabel(property?.unit)
    return unit ? `${formatted} ${unit}` : formatted
  }
  if (Array.isArray(value)) return value.map(String).join(' · ')
  if (typeof value === 'string') return knownLabels[value.toLowerCase()] || value
  return JSON.stringify(value)
}

export const readPropertyValue = (
  state: SimulatedDevice['state_snapshot'],
  instanceId: string,
  property: CapabilityProperty,
): unknown => {
  if (property.state_authority === 'product_catalog') return property.default ?? null
  if (!state) return property.default ?? null
  if (property.channel === 'diagnostic') {
    return state.diagnostics[instanceId]?.[property.id] ?? property.default ?? null
  }
  return state.instances[instanceId]?.[property.channel]?.[property.id] ?? property.default ?? null
}

export const patchForProperty = (
  instanceId: string,
  property: CapabilityProperty,
  value: unknown,
): DeviceStatePatch => property.channel === 'diagnostic'
  ? { diagnostics: { [instanceId]: { [property.id]: value } } }
  : {
      instances: {
        [instanceId]: {
          [property.channel]: { [property.id]: value },
        },
      },
    }

export const isHiddenProperty = (property: CapabilityProperty): boolean =>
  property.presentation?.ui_hint === 'hidden'

export const isLcdInstance = (instance: CapabilityInstance): boolean =>
  instance.capability_id === 'character_display_4x20'

export const isCameraInstance = (instance: CapabilityInstance): boolean =>
  instance.capability_id === 'camera_stream'

export interface FlatValue {
  path: string
  value: unknown
}

export const flattenRecord = (
  input: unknown,
  prefix = '',
  depth = 0,
): FlatValue[] => {
  if (depth > 5) return [{ path: prefix, value: input }]
  if (input === null || typeof input !== 'object' || input instanceof Date) {
    return [{ path: prefix, value: input }]
  }
  if (Array.isArray(input)) return [{ path: prefix, value: input }]
  return Object.entries(input as Record<string, unknown>).flatMap(([key, value]) => {
    if (key === '_id') return []
    const path = prefix ? `${prefix}.${key}` : key
    return flattenRecord(value, path, depth + 1)
  })
}

export const mergeDevicePatch = (
  state: NonNullable<SimulatedDevice['state_snapshot']>,
  patch: DeviceStatePatch,
): NonNullable<SimulatedDevice['state_snapshot']> => {
  const next = structuredClone(state)
  for (const [instanceId, envelope] of Object.entries(patch.instances || {})) {
    next.instances[instanceId] ||= { reported: {}, desired: {} }
    Object.assign(next.instances[instanceId].reported, envelope.reported || {})
    Object.assign(next.instances[instanceId].desired, envelope.desired || {})
  }
  for (const [instanceId, values] of Object.entries(patch.diagnostics || {})) {
    next.diagnostics[instanceId] ||= {}
    Object.assign(next.diagnostics[instanceId], values)
  }
  next.state_version += 1
  return next
}
