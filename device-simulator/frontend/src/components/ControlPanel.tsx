import { useEffect, useMemo, useState } from 'react'
import { createRun, fetchCatalog } from '../api'
import type { CatalogProduct, RunConfig } from '../types'

const defaultConfig: RunConfig = {
  user_count: 2,
  email_prefix: 'sim',
  email_domain: 'simulator.local',
  devices_min: 1,
  devices_max: 3,
  networks_min: 1,
  networks_max: 1,
  products: [],
  telemetry_interval: 15,
  telemetry_jitter_percent: 10,
  startup_ramp_seconds: 30,
  initial_offline_rate: 5,
  cleanup_policy: 'auto_24h',
  auto_start: true,
}

export default function ControlPanel({
  enabled,
  onCreated,
}: {
  enabled: boolean
  onCreated: (runId: string) => void
}) {
  const [config, setConfig] = useState(defaultConfig)
  const [catalog, setCatalog] = useState<CatalogProduct[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!enabled) return
    void fetchCatalog().then((products) => {
      setCatalog(products)
      setConfig((current) => current.products.length > 0 || products.length === 0
        ? current
        : { ...current, products: [{ product_id: products[0].id, weight: 100 }] })
    }).catch((caught) => {
      setError(caught instanceof Error ? caught.message : 'Không tải được Product Catalog.')
    })
  }, [enabled])

  const selectedProducts = useMemo(
    () => new Map(config.products.map((product) => [product.product_id, product.weight])),
    [config.products],
  )

  const workloadEstimate = useMemo(() => {
    const maximumDevices = config.user_count * config.devices_max
    const expectedOnlineDevices = config.auto_start
      ? Math.ceil(maximumDevices * (1 - config.initial_offline_rate / 100))
      : 0
    return {
      maximumDevices,
      expectedOnlineDevices,
      telemetryPerSecond: expectedOnlineDevices / Math.max(1, config.telemetry_interval),
    }
  }, [
    config.auto_start,
    config.devices_max,
    config.initial_offline_rate,
    config.telemetry_interval,
    config.user_count,
  ])

  const updateNumber = (key: keyof RunConfig, value: string) => {
    setConfig((current) => ({ ...current, [key]: Number(value) }))
  }

  const toggleProduct = (productId: string, selected: boolean) => {
    setConfig((current) => ({
      ...current,
      products: selected
        ? [...current.products, { product_id: productId, weight: 100 }]
        : current.products.filter((product) => product.product_id !== productId),
    }))
  }

  const updateWeight = (productId: string, weight: number) => {
    setConfig((current) => ({
      ...current,
      products: current.products.map((product) =>
        product.product_id === productId ? { ...product, weight } : product),
    }))
  }

  const validate = (): string => {
    if (config.devices_min > config.devices_max) {
      return 'Số thiết bị tối đa phải lớn hơn hoặc bằng số tối thiểu.'
    }
    if (config.networks_min > config.networks_max) {
      return 'Số mạng Wi-Fi tối đa phải lớn hơn hoặc bằng số tối thiểu.'
    }
    if (config.devices_max > 0 && config.networks_min > config.devices_max) {
      return 'Số mạng Wi-Fi tối thiểu không được vượt quá số thiết bị tối đa của một user.'
    }
    if (config.products.length === 0) {
      return 'Chọn ít nhất một Product. Simulator cần contract thật từ Catalog.'
    }
    if (config.products.some((product) => product.weight <= 0)) {
      return 'Trọng số của mỗi Product phải lớn hơn 0.'
    }
    return ''
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    setLoading(true)
    setError('')
    try {
      const result = await createRun(config)
      onCreated(result.run_id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tạo được lần chạy mô phỏng.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section aria-labelledby="create-title">
      <div className="section-heading">
        <div>
          <h2 id="create-title">Tạo dữ liệu mô phỏng</h2>
          <p>User được đăng ký qua API Gateway; thiết bị được provision trong PostgreSQL, claim qua API công khai rồi kết nối MQTT.</p>
        </div>
      </div>

      {!enabled && (
        <p className="notice notice--warning">Hoàn tất preflight ở màn hình Hệ thống trước khi tạo dữ liệu.</p>
      )}
      {error && <p className="notice notice--error" role="alert">{error}</p>}

      <form className="run-form" onSubmit={handleSubmit}>
        <fieldset className="form-section" disabled={!enabled || loading}>
          <legend>Tài khoản và quyền sở hữu</legend>
          <div className="form-grid form-grid--uneven">
            <Field label="Số người dùng" help="1–10.000 user mỗi lần chạy">
              <input min="1" max="10000" onChange={(event) => updateNumber('user_count', event.target.value)} required type="number" value={config.user_count} />
            </Field>
            <Field label="Tiền tố email" help="Chữ, số, dấu gạch ngang hoặc gạch dưới">
              <input maxLength={24} onChange={(event) => setConfig({ ...config, email_prefix: event.target.value })} pattern="[a-zA-Z0-9_-]+" required value={config.email_prefix} />
            </Field>
            <Field label="Tên miền email" help="Chỉ dùng cho tài khoản được tự động sinh">
              <input onChange={(event) => setConfig({ ...config, email_domain: event.target.value })} required value={config.email_domain} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="form-section" disabled={!enabled || loading}>
          <legend>Phân bổ thiết bị</legend>
          <div className="form-grid">
            <Field label="Thiết bị tối thiểu mỗi user">
              <input min="0" max="100" onChange={(event) => updateNumber('devices_min', event.target.value)} required type="number" value={config.devices_min} />
            </Field>
            <Field label="Thiết bị tối đa mỗi user">
              <input min="0" max="100" onChange={(event) => updateNumber('devices_max', event.target.value)} required type="number" value={config.devices_max} />
            </Field>
            <Field label="Số mạng Wi-Fi tối thiểu" help="Mỗi mạng tự bầu một Hub">
              <input min="1" max="100" onChange={(event) => updateNumber('networks_min', event.target.value)} required type="number" value={config.networks_min} />
            </Field>
            <Field label="Số mạng Wi-Fi tối đa" help="Thiết bị được phân bổ ổn định theo seed">
              <input min="1" max="100" onChange={(event) => updateNumber('networks_max', event.target.value)} required type="number" value={config.networks_max} />
            </Field>
            <Field label="Chu kỳ telemetry" help="Đơn vị giây; tối thiểu 5">
              <input min="5" max="86400" onChange={(event) => updateNumber('telemetry_interval', event.target.value)} required type="number" value={config.telemetry_interval} />
            </Field>
            <Field label="Jitter chu kỳ" help="0–50%; giãn thời điểm gửi lặp lại">
              <input min="0" max="50" onChange={(event) => updateNumber('telemetry_jitter_percent', event.target.value)} required type="number" value={config.telemetry_jitter_percent} />
            </Field>
            <Field label="Startup ramp" help="Đơn vị giây; giãn đợt telemetry đầu tiên">
              <input min="0" max="3600" onChange={(event) => updateNumber('startup_ramp_seconds', event.target.value)} required type="number" value={config.startup_ramp_seconds} />
            </Field>
            <Field label="Tỷ lệ offline ban đầu" help="Phần trăm thiết bị được giữ ngoại tuyến">
              <input min="0" max="100" onChange={(event) => updateNumber('initial_offline_rate', event.target.value)} required type="number" value={config.initial_offline_rate} />
            </Field>
          </div>

          <div className="load-preview" aria-label="Tải tối đa dự kiến">
            <div><span>Thiết bị tối đa</span><strong>{formatNumber(workloadEstimate.maximumDevices)}</strong></div>
            <div><span>Dự kiến online</span><strong>{formatNumber(workloadEstimate.expectedOnlineDevices)}</strong></div>
            <div><span>Telemetry dự kiến</span><strong>{formatRate(workloadEstimate.telemetryPerSecond)} msg/s</strong></div>
          </div>

          <div className="product-selector">
            <h3>Product được sử dụng</h3>
            <p>Trọng số là tương đối; tỷ lệ 70/30 sẽ tạo phân bố gần tương ứng khi số lượng đủ lớn.</p>
            <div className="product-list">
              {catalog.map((product) => {
                const selected = selectedProducts.has(product.id)
                return (
                  <div className="product-row" key={product.id}>
                    <label>
                      <input
                        checked={selected}
                        onChange={(event) => toggleProduct(product.id, event.target.checked)}
                        type="checkbox"
                      />
                      <span>
                        <strong>{product.display_name}</strong>
                        <small>{product.id} · {product.capability_count} capability</small>
                      </span>
                    </label>
                    <input
                      aria-label={`Trọng số của ${product.display_name}`}
                      disabled={!selected}
                      min="1"
                      onChange={(event) => updateWeight(product.id, Number(event.target.value))}
                      type="number"
                      value={selectedProducts.get(product.id) || 100}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </fieldset>

        <fieldset className="form-section" disabled={!enabled || loading}>
          <legend>Runtime và lưu trữ</legend>
          <div className="form-grid">
            <Field label="Chính sách dọn dẹp" help="Bộ đếm 24 giờ chỉ bắt đầu sau khi lần chạy hoàn tất.">
              <select
                onChange={(event) => setConfig({
                  ...config,
                  cleanup_policy: event.target.value as RunConfig['cleanup_policy'],
                })}
                value={config.cleanup_policy}
              >
                <option value="auto_24h">Dọn sau 24 giờ kể từ lúc hoàn tất</option>
                <option value="manual">Giữ đến khi dọn thủ công</option>
              </select>
            </Field>
            <Field label="Random seed" help="Không bắt buộc; tái tạo số lượng và lựa chọn Product">
              <input
                onChange={(event) => setConfig({ ...config, random_seed: event.target.value || undefined })}
                placeholder="Ví dụ: regression-2026-07"
                value={config.random_seed || ''}
              />
            </Field>
          </div>
          <label className="check-control">
            <input
              checked={config.auto_start}
              onChange={(event) => setConfig({ ...config, auto_start: event.target.checked })}
              type="checkbox"
            />
            Kết nối MQTT ngay sau khi thiết bị được claim
          </label>
        </fieldset>

        <div className="form-actions">
          <button
            className="button button--primary"
            data-state={loading ? 'loading' : 'default'}
            disabled={!enabled || loading}
            type="submit"
          >
            {loading ? 'Đang tạo dữ liệu…' : 'Tạo lần chạy'}
          </button>
          <p>Tốc độ đăng ký được giới hạn để tuân thủ rate limit thật của Auth API.</p>
        </div>
      </form>
    </section>
  )
}

const formatNumber = (value: number) => new Intl.NumberFormat('vi-VN').format(value)
const formatRate = (value: number) => new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 2,
}).format(value)

function Field({
  label,
  help = '\u00a0',
  children,
}: {
  label: string
  help?: string
  children: React.ReactNode
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      <small>{help}</small>
    </label>
  )
}
