export interface DeviceFilters {
  /** Run id, `factory` for manufactured devices, or empty for all. */
  runId: string
  productId: string
  status: string
  q: string
}

export const emptyDeviceFilters: DeviceFilters = { runId: '', productId: '', status: '', q: '' }

/** Search boxes query the server this long after the last keystroke. */
export const SEARCH_DEBOUNCE_MS = 300
