import { useCallback, useEffect, useState } from 'react'
import { fetchEvents, subscribeStream } from '../api'
import type { SimulatorEvent } from '../types'
import { EventRows } from './DeviceDetail'
import { Icon } from './Icon'

export function EventsLog({ enabled }: { enabled: boolean }) {
  const [events, setEvents] = useState<SimulatorEvent[]>([])
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      setEvents(await fetchEvents())
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load simulator events')
    }
  }, [enabled])

  useEffect(() => {
    void load()
    if (!enabled) return
    return subscribeStream((event) => {
      setEvents((current) => [event, ...current].slice(0, 200))
    }, (streamError) => setError(streamError.message))
  }, [enabled, load])

  return (
    <section aria-labelledby="events-title">
      <div className="section-heading">
        <div><h2 id="events-title">Simulator events</h2><p>Operational history stored separately from SmartHome telemetry.</p></div>
        <button className="button button--quiet" disabled={!enabled} onClick={() => void load()} type="button"><Icon name="refresh" />Refresh</button>
      </div>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      <div className="data-panel data-panel--full"><EventRows events={events} /></div>
    </section>
  )
}
