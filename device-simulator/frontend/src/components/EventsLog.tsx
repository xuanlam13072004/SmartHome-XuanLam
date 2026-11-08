import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchEvents, subscribeStream } from '../api'
import type { SimulatorEvent } from '../types'
import { EventRows } from './DeviceDetail'
import { Icon } from './Icon'

const KEEP = 200

/**
 * Simulator operations log. Starting thousands of devices emits thousands of
 * events per second, so streamed events are buffered and shown once a second,
 * and per-device information is hidden unless asked for.
 */
export function EventsLog({ enabled }: { enabled: boolean }) {
  const [events, setEvents] = useState<SimulatorEvent[]>([])
  const [problemsOnly, setProblemsOnly] = useState(true)
  const [error, setError] = useState('')
  const pending = useRef<SimulatorEvent[]>([])

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      setEvents(await fetchEvents({ problemsOnly }))
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tải được sự kiện Simulator.')
    }
  }, [enabled, problemsOnly])

  useEffect(() => {
    void load()
    if (!enabled) return
    pending.current = []
    const stop = subscribeStream((event) => {
      if (problemsOnly && event.severity !== 'warning' && event.severity !== 'error') return
      pending.current.push(event)
      if (pending.current.length > KEEP) pending.current.splice(0, pending.current.length - KEEP)
    }, (streamError) => setError(streamError.message))
    const timer = window.setInterval(() => {
      if (pending.current.length === 0) return
      const fresh = pending.current.reverse()
      pending.current = []
      setEvents((current) => [...fresh, ...current].slice(0, KEEP))
    }, 1000)
    return () => {
      stop()
      window.clearInterval(timer)
    }
  }, [enabled, load, problemsOnly])

  return (
    <section aria-labelledby="events-title">
      <div className="section-heading">
        <div><h2 id="events-title">Nhật ký Simulator</h2><p>Lịch sử vận hành của Simulator, lưu riêng với dữ liệu của hệ thống chính.</p></div>
        <div className="section-heading__actions">
          <label className="check-control">
            <input checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} type="checkbox" />
            Chỉ cảnh báo và lỗi
          </label>
          <button className="button button--quiet" disabled={!enabled} onClick={() => void load()} type="button"><Icon name="refresh" />Tải lại</button>
        </div>
      </div>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <div className="data-panel data-panel--full"><EventRows events={events} /></div>
    </section>
  )
}
