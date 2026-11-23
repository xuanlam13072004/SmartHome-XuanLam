import { useMemo, useState, type FormEvent } from 'react'
import { createRun } from '../../api'
import type { CatalogProduct, Overview, RunConfig } from '../../types'
import { formatDuration, formatNumber, readError } from '../format'

interface Preset {
  id: string
  label: string
  users: number
  min: number
  max: number
  interval: number
}

const PRESETS: Preset[] = [
  { id: 'smoke', label: 'Thử nhanh', users: 5, min: 2, max: 2, interval: 15 },
  { id: '1k', label: '1.000 thiết bị', users: 250, min: 3, max: 5, interval: 30 },
  { id: '10k', label: '10.000 thiết bị', users: 2500, min: 3, max: 5, interval: 30 },
  { id: '30k', label: '30.000 thiết bị', users: 7500, min: 3, max: 5, interval: 30 },
]

/** Seconds of simulator work per device (key pair, factory record, claim, first connect). */
const SECONDS_PER_DEVICE_PER_LANE = 0.35

export function ScenarioForm({
  products,
  limits,
  onCreated,
}: {
  products: CatalogProduct[]
  limits: Overview['limits'] | null
  onCreated: (runId: string) => void
}) {
  const [preset, setPreset] = useState('smoke')
  const [users, setUsers] = useState(5)
  const [devicesMin, setDevicesMin] = useState(2)
  const [devicesMax, setDevicesMax] = useState(2)
  const [interval, setIntervalSeconds] = useState(15)
  const [offlineRate, setOfflineRate] = useState(0)
  const [keep, setKeep] = useState(false)
  const [excluded, setExcluded] = useState<Set<string> | null>(null)
  const [networksMax, setNetworksMax] = useState(1)
  const [rampSeconds, setRampSeconds] = useState(60)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Cameras need a webcam to produce video; a load mix leaves them out by default.
  const defaultExcluded = useMemo(
    () => new Set(products.filter((product) => product.ui_profile === 'security_camera').map((product) => product.id)),
    [products],
  )
  const excludedProducts = excluded ?? defaultExcluded
  const selected = products.filter((product) => !excludedProducts.has(product.id))

  const applyPreset = (next: Preset) => {
    setPreset(next.id)
    setUsers(next.users)
    setDevicesMin(next.min)
    setDevicesMax(next.max)
    setIntervalSeconds(next.interval)
    setRampSeconds(next.users > 1000 ? 300 : 60)
  }

  const estimate = useMemo(() => {
    const averageDevices = users * (devicesMin + devicesMax) / 2
    const maximumDevices = users * devicesMax
    const online = averageDevices * (1 - offlineRate / 100)
    const register = limits?.gateway_register_per_minute || 20
    const login = limits?.gateway_login_per_minute || 100
    const lanes = limits?.generation_concurrency || 16
    const stages = [
      { label: `đăng ký tài khoản (${register}/phút)`, minutes: Math.max(0, users - register) / register },
      { label: `đăng nhập (${login}/phút)`, minutes: Math.max(0, users - login) / login },
      { label: `cấp phát thiết bị (${lanes} luồng)`, minutes: averageDevices * SECONDS_PER_DEVICE_PER_LANE / lanes / 60 },
    ]
    const bottleneck = stages.reduce((slowest, stage) => (stage.minutes > slowest.minutes ? stage : slowest))
    return { averageDevices, maximumDevices, online, telemetry: online / interval, bottleneck }
  }, [devicesMax, devicesMin, interval, limits, offlineRate, users])

  const problems = [
    devicesMin > devicesMax ? 'Số thiết bị tối thiểu lớn hơn tối đa.' : '',
    selected.length === 0 ? 'Chọn ít nhất một sản phẩm.' : '',
    limits && users > limits.max_users_per_run ? `Vượt giới hạn ${formatNumber(limits.max_users_per_run)} người dùng mỗi lần chạy (MAX_USERS_PER_RUN).` : '',
    limits && estimate.maximumDevices > limits.max_devices_per_run ? `Tối đa ${formatNumber(estimate.maximumDevices)} thiết bị, vượt MAX_DEVICES_PER_RUN (${formatNumber(limits.max_devices_per_run)}).` : '',
    limits && offlineRate < 100 && estimate.maximumDevices > limits.max_active_devices ? `Vượt MAX_ACTIVE_DEVICES (${formatNumber(limits.max_active_devices)}).` : '',
    limits && offlineRate < 100 && estimate.maximumDevices / interval > limits.max_telemetry_messages_per_second ? `Telemetry tối đa ${formatNumber(estimate.maximumDevices / interval)} msg/s, vượt MAX_TELEMETRY_MESSAGES_PER_SECOND (${formatNumber(limits.max_telemetry_messages_per_second)}).` : '',
  ].filter(Boolean)

  const toggleProduct = (productId: string) => {
    const next = new Set(excludedProducts)
    if (next.has(productId)) next.delete(productId)
    else next.add(productId)
    setExcluded(next)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (problems.length > 0 || busy) return
    setBusy(true)
    setError('')
    const config: RunConfig = {
      user_count: users,
      email_prefix: 'load',
      email_domain: 'simulator.local',
      devices_min: devicesMin,
      devices_max: devicesMax,
      networks_min: 1,
      networks_max: Math.max(1, Math.min(networksMax, devicesMax || 1)),
      products: selected.map((product) => ({ product_id: product.id, weight: 100 })),
      telemetry_interval: interval,
      telemetry_jitter_percent: 10,
      startup_ramp_seconds: rampSeconds,
      initial_offline_rate: offlineRate,
      cleanup_policy: keep ? 'manual' : 'auto_24h',
      auto_start: true,
    }
    try {
      const result = await createRun(config)
      onCreated(result.run_id)
    } catch (caught) {
      setError(readError(caught, 'Không tạo được lần chạy.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="scenario" onSubmit={(event) => void submit(event)}>
      <header className="work-panel__heading">
        <div>
          <h3>Tạo người dùng và thiết bị</h3>
          <p>Simulator đăng ký người dùng qua API Gateway, cấp phát và ghép thiết bị cho từng người rồi kết nối MQTT như thiết bị thật. Chọn một mẫu hoặc tự nhập số lượng.</p>
        </div>
      </header>

      <div className="segmented scenario__presets" role="group" aria-label="Mẫu kịch bản">
        {PRESETS.map((item) => (
          <button aria-pressed={preset === item.id} key={item.id} onClick={() => applyPreset(item)} type="button">{item.label}</button>
        ))}
      </div>

      <div className="scenario__grid">
        <label className="field">
          <span>Người dùng</span>
          <input min={1} onChange={(event) => { setPreset(''); setUsers(Number(event.target.value)) }} type="number" value={users} />
        </label>
        <div className="field">
          <span>Thiết bị mỗi người</span>
          <div className="range-pair">
            <input aria-label="Tối thiểu" min={0} max={100} onChange={(event) => { setPreset(''); setDevicesMin(Number(event.target.value)) }} type="number" value={devicesMin} />
            <span aria-hidden="true">–</span>
            <input aria-label="Tối đa" min={0} max={100} onChange={(event) => { setPreset(''); setDevicesMax(Number(event.target.value)) }} type="number" value={devicesMax} />
          </div>
        </div>
        <label className="field">
          <span>Chu kỳ telemetry</span>
          <select onChange={(event) => setIntervalSeconds(Number(event.target.value))} value={interval}>
            {[5, 10, 15, 30, 60, 120].map((seconds) => <option key={seconds} value={seconds}>{seconds} giây</option>)}
          </select>
        </label>
        <label className="field">
          <span>Ngoại tuyến lúc đầu</span>
          <select onChange={(event) => setOfflineRate(Number(event.target.value))} value={offlineRate}>
            {[0, 5, 10, 25, 50].map((rate) => <option key={rate} value={rate}>{rate} %</option>)}
          </select>
        </label>
      </div>

      <fieldset className="chip-set">
        <legend>Sản phẩm (chia đều)</legend>
        {products.map((product) => (
          <label className="chip" key={product.id}>
            <input checked={!excludedProducts.has(product.id)} onChange={() => toggleProduct(product.id)} type="checkbox" />
            <span>{product.display_name}</span>
          </label>
        ))}
      </fieldset>

      <details className="scenario__advanced">
        <summary>Tùy chọn khác</summary>
        <div className="scenario__grid">
          <label className="field">
            <span>Mạng Wi-Fi tối đa mỗi người</span>
            <input max={100} min={1} onChange={(event) => setNetworksMax(Number(event.target.value))} type="number" value={networksMax} />
            <small>Thiết bị cùng mạng gom thành Hub–Node.</small>
          </label>
          <label className="field">
            <span>Khởi động dần trong</span>
            <select onChange={(event) => setRampSeconds(Number(event.target.value))} value={rampSeconds}>
              {[0, 30, 60, 120, 300, 600].map((seconds) => <option key={seconds} value={seconds}>{seconds ? `${seconds} giây` : 'Không'}</option>)}
            </select>
            <small>Rải lượt gửi đầu tiên để tránh dồn tải.</small>
          </label>
          <label className="check-control">
            <input checked={keep} onChange={(event) => setKeep(event.target.checked)} type="checkbox" />
            Giữ dữ liệu đến khi tự dọn (mặc định tự dọn sau 24 giờ)
          </label>
        </div>
      </details>

      <dl className="scenario__estimate">
        <div><dt>Thiết bị</dt><dd>~{formatNumber(estimate.averageDevices)}</dd></div>
        <div><dt>Telemetry</dt><dd>~{formatNumber(estimate.telemetry)} msg/s</dd></div>
        <div><dt>Thời gian tạo</dt><dd>{formatDuration(estimate.bottleneck.minutes)}</dd></div>
      </dl>
      {estimate.bottleneck.minutes > 30 && (
        <p className="field-help">
          Chậm nhất ở bước {estimate.bottleneck.label}. Để chạy nhanh hơn, nâng cùng lúc
          {' '}<code>RATE_LIMIT_REGISTER_PER_IP_PER_MINUTE</code> của API Gateway và <code>GATEWAY_REGISTER_PER_MINUTE</code> của Simulator.
        </p>
      )}

      {problems.map((problem) => <p className="notice notice--warning" key={problem}>{problem}</p>)}
      {error && <p className="notice notice--error" role="alert">{error}</p>}

      <button className="button button--primary" data-state={busy ? 'loading' : 'default'} disabled={busy || problems.length > 0} type="submit">
        {busy ? 'Đang tạo…' : 'Bắt đầu chạy'}
      </button>
    </form>
  )
}
