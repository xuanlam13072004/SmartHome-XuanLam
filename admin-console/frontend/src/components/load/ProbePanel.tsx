import { useCallback, useEffect, useState } from 'react'
import { downloadProbe, fetchProbes, startProbe, stopProbe } from '../../api'
import type { ProbeKind, ProbeList, ProbeResult } from '../../types'
import { formatDate, formatDecimal, formatNumber, readError } from '../format'

const KINDS: Array<{ id: ProbeKind; label: string; help: string }> = [
  {
    id: 'commands',
    label: 'Lệnh điều khiển',
    help: 'Người dùng ảo gửi một lệnh an toàn (khóa cửa, dừng tưới…) qua API tới thiết bị đang kết nối. Đo từ lúc gửi đến khi thiết bị báo kết quả.',
  },
  {
    id: 'app_reads',
    label: 'Người dùng mở app',
    help: 'Người dùng ảo mở danh sách thiết bị, huy hiệu và thông báo như khi mở app. Đo thời gian trả lời của từng yêu cầu.',
  },
]

const STATUS: Record<ProbeResult['status'], string> = {
  preparing: 'Đang đăng nhập người dùng',
  running: 'Đang đo',
  completed: 'Xong',
  stopped: 'Đã dừng',
  failed: 'Không chạy được',
}

const ms = (value: number | undefined) => (value === undefined ? '—' : `${formatNumber(value)} ms`)

/**
 * End-to-end measurements for the report: commands from the app to the device
 * and back, or the app's reads, by simulated users through the public API.
 * Run it while a load run keeps devices sending telemetry.
 */
export function ProbePanel() {
  const [data, setData] = useState<ProbeList | null>(null)
  const [kind, setKind] = useState<ProbeKind>('commands')
  const [users, setUsers] = useState(100)
  const [perUser, setPerUser] = useState(5)
  const [concurrency, setConcurrency] = useState(50)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await fetchProbes())
    } catch (caught) {
      setError(readError(caught, 'Không đọc được các bài đo.'))
    }
  }, [])

  const live = data?.current && ['preparing', 'running'].includes(data.current.status) ? data.current : null
  const measuring = live !== null

  // Every second while a probe runs, otherwise every 10 seconds.
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, measuring ? 1000 : 10000)
    return () => window.clearInterval(timer)
  }, [load, measuring])

  const start = async () => {
    setBusy(true)
    setError('')
    try {
      await startProbe({ kind, users, per_user: perUser, concurrency })
      await load()
    } catch (caught) {
      setError(readError(caught, 'Không bắt đầu được bài đo.'))
    } finally {
      setBusy(false)
    }
  }

  const results = [...(data?.current && !live ? [data.current] : []), ...(data?.results ?? [])]
  const limits = data?.limits

  return (
    <section aria-labelledby="probe-title" className="probe">
      <header className="work-panel__heading">
        <div>
          <h3 id="probe-title">Đo độ trễ đầu-cuối</h3>
          <p>
            Số liệu cho báo cáo: người dùng ảo dùng hệ thống qua đúng API như app thật. Chạy trong lúc các thiết bị ảo
            đang gửi telemetry để đo khi hệ thống chịu tải; xem thêm biểu đồ trong Grafana.
          </p>
        </div>
      </header>
      {error && <p className="notice notice--error" role="alert">{error}</p>}

      <div className="segmented" role="group" aria-label="Loại bài đo">
        {KINDS.map((item) => (
          <button aria-pressed={kind === item.id} disabled={Boolean(live)} key={item.id} onClick={() => setKind(item.id)} type="button">{item.label}</button>
        ))}
      </div>
      <p className="field-help">{KINDS.find((item) => item.id === kind)?.help}</p>

      <div className="probe__grid">
        <label className="field">
          <span>Người dùng</span>
          <input disabled={Boolean(live)} max={limits?.users} min={1} onChange={(event) => setUsers(Number(event.target.value))} type="number" value={users} />
        </label>
        <label className="field">
          <span>{kind === 'commands' ? 'Lệnh mỗi người' : 'Lượt mở app mỗi người'}</span>
          <input disabled={Boolean(live)} max={limits?.per_user} min={1} onChange={(event) => setPerUser(Number(event.target.value))} type="number" value={perUser} />
        </label>
        <label className="field">
          <span>Cùng lúc</span>
          <input disabled={Boolean(live)} max={limits?.concurrency} min={1} onChange={(event) => setConcurrency(Number(event.target.value))} type="number" value={concurrency} />
          <small>Số người dùng thao tác đồng thời.</small>
        </label>
      </div>

      <div className="run-row__actions">
        {live ? (
          <button className="button button--danger" onClick={() => void stopProbe(live.id).then(load)} type="button">Dừng bài đo</button>
        ) : (
          <button className="button button--primary" disabled={busy} onClick={() => void start()} type="button">Bắt đầu đo</button>
        )}
      </div>

      {live && <ProbeSummary result={live} live />}

      {results.length > 0 && (
        <ol className="probe__results">
          {results.map((result) => <li key={result.id}><ProbeSummary result={result} /></li>)}
        </ol>
      )}
    </section>
  )
}

function ProbeSummary({ result, live = false }: { result: ProbeResult; live?: boolean }) {
  const [error, setError] = useState('')
  const kind = KINDS.find((item) => item.id === result.params.kind)?.label ?? result.params.kind
  const success = result.totals.requests > 0 ? (result.totals.ok / result.totals.requests) * 100 : 0
  const errors = Object.entries(result.errors)
  const save = (format: 'csv' | 'json') => void downloadProbe(result.id, format).catch((caught) => setError(readError(caught, 'Không tải được.')))
  return (
    <article className={`probe-card${live ? ' probe-card--live' : ''}`}>
      <header>
        <strong>{kind} · {STATUS[result.status]}</strong>
        <small>
          {formatDate(result.started_at)} · {formatNumber(result.users_used || result.params.users)} người dùng × {result.params.per_user}
          {' '}· {result.params.concurrency} cùng lúc
          {result.context.devices_connected !== undefined && ` · lúc đó ${formatNumber(result.context.devices_connected)} thiết bị kết nối, ${formatDecimal(result.context.telemetry_per_second ?? 0)} msg/s`}
        </small>
      </header>
      {result.note && <p className="notice notice--warning">{result.note}</p>}
      <dl className="probe-card__facts">
        <div><dt>Yêu cầu</dt><dd>{formatNumber(result.totals.requests)}</dd></div>
        <div><dt>Thành công</dt><dd>{formatDecimal(success)} %</dd></div>
        <div><dt>Thông lượng</dt><dd>{formatDecimal(result.throughput_per_second)} /s</dd></div>
        <div><dt>p50</dt><dd>{ms(result.latency?.p50_ms)}</dd></div>
        <div><dt>p95</dt><dd>{ms(result.latency?.p95_ms)}</dd></div>
        <div><dt>p99</dt><dd>{ms(result.latency?.p99_ms)}</dd></div>
        {result.server && <div><dt>Trong backend p95</dt><dd>{ms(result.server.p95_ms)}</dd></div>}
        <div><dt>Chậm nhất</dt><dd>{ms(result.latency?.max_ms)}</dd></div>
      </dl>
      {errors.length > 0 && (
        <p className="field-help">Lỗi: {errors.map(([code, count]) => `${code} × ${formatNumber(count)}`).join(', ')}</p>
      )}
      {!live && (
        <div className="run-row__actions">
          <button className="button button--quiet button--compact" onClick={() => save('csv')} type="button">Tải CSV</button>
          <button className="button button--quiet button--compact" onClick={() => save('json')} type="button">Tải JSON</button>
          <small className="field-help">
            Máy đo: {result.machine.cpus} lõi · {formatDecimal(result.machine.memory_gb)} GB RAM · {result.machine.cpu_model}
          </small>
        </div>
      )}
      {error && <p className="notice notice--error">{error}</p>}
    </article>
  )
}
