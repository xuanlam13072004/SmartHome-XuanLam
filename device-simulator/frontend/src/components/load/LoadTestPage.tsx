import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchCatalog, fetchOverview, fetchRuns } from '../../api'
import type { CatalogProduct, Overview, SimulationRun } from '../../types'
import { EmptyState } from '../EmptyState'
import { readError } from '../format'
import { LiveBoard, type OverviewSample } from './LiveBoard'
import { RunsTable } from './RunsTable'
import { ScenarioForm } from './ScenarioForm'

const HISTORY = 60

export function LoadTestPage({
  enabled,
  focusScenario,
  onOpenDevices,
}: {
  enabled: boolean
  /** Bumped by "Tạo người dùng và thiết bị" buttons elsewhere: scroll to the form. */
  focusScenario: number
  onOpenDevices: (runId: string) => void
}) {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [history, setHistory] = useState<OverviewSample[]>([])
  const [overviewError, setOverviewError] = useState('')
  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [runsLoading, setRunsLoading] = useState(true)
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [focusRunId, setFocusRunId] = useState<string>()
  const scenarioRef = useRef<HTMLDivElement | null>(null)
  const runsRef = useRef(runs)
  useEffect(() => {
    if (focusScenario === 0) return
    const frame = window.requestAnimationFrame(() => {
      scenarioRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      scenarioRef.current?.querySelector('input')?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusScenario])
  useEffect(() => {
    runsRef.current = runs
  }, [runs])

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await fetchRuns())
    } finally {
      setRunsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    let stopped = false
    const poll = async () => {
      try {
        const next = await fetchOverview()
        if (stopped) return
        setOverview(next)
        setOverviewError('')
        setHistory((current) => [...current, {
          at: Date.parse(next.sampled_at),
          telemetry: next.rates.telemetry_per_second,
          connected: next.runtime.connected,
        }].slice(-HISTORY))
      } catch (caught) {
        if (!stopped) setOverviewError(readError(caught, 'Không đọc được số liệu Simulator.'))
      }
    }
    void poll()
    void fetchCatalog().then(setProducts).catch(() => undefined)
    const overviewTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void poll()
    }, 2000)
    // Runs change quickly only while one is generating.
    let runsTimer = 0
    const scheduleRuns = () => {
      const active = runsRef.current.some((run) => ['queued', 'running', 'cleaning'].includes(run.status))
      runsTimer = window.setTimeout(async () => {
        if (document.visibilityState === 'visible') await loadRuns().catch(() => undefined)
        if (!stopped) scheduleRuns()
      }, active ? 3000 : 15000)
    }
    void loadRuns().catch(() => undefined).then(scheduleRuns)
    return () => {
      stopped = true
      window.clearInterval(overviewTimer)
      window.clearTimeout(runsTimer)
    }
  }, [enabled, loadRuns])

  if (!enabled) {
    return (
      <EmptyState
        actionLabel="Mở Hệ thống"
        description="Nhập admin token và chạy kiểm tra hạ tầng trước khi tạo tải."
        onAction={() => window.dispatchEvent(new CustomEvent('simulator:navigate-system'))}
        title="Simulator chưa sẵn sàng."
      />
    )
  }

  return (
    <section aria-labelledby="load-title" className="load-page">
      <header className="page-heading">
        <div>
          <h2 className="visually-hidden" id="load-title">Kiểm thử tải</h2>
          <p>Tạo hàng nghìn người dùng và thiết bị ảo đi qua đúng API, MQTT như thiết bị thật, rồi theo dõi hệ thống chịu tải.</p>
        </div>
      </header>

      <LiveBoard error={overviewError} history={history} overview={overview} />

      <div className="load-layout" ref={scenarioRef}>
        <ScenarioForm
          limits={overview?.limits || null}
          onCreated={(runId) => {
            setFocusRunId(runId)
            void loadRuns()
          }}
          products={products}
        />
        <RunsTable
          focusRunId={focusRunId}
          loading={runsLoading}
          onChanged={loadRuns}
          onOpenDevices={onOpenDevices}
          runs={runs}
        />
      </div>
    </section>
  )
}
