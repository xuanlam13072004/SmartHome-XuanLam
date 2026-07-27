import { useEffect, useMemo, useState } from 'react'
import { createRun, fetchCatalog } from '../api'
import type { CatalogProduct, RunConfig } from '../types'

const defaultConfig: RunConfig = {
  user_count: 2,
  username_prefix: 'sim',
  email_domain: 'simulator.local',
  devices_min: 1,
  devices_max: 3,
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
      setError(caught instanceof Error ? caught.message : 'Could not load product catalog')
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
      return 'Maximum devices must be greater than or equal to minimum devices.'
    }
    if (config.products.length === 0) {
      return 'Select at least one product. The simulator needs a real catalog template.'
    }
    if (config.products.some((product) => product.weight <= 0)) {
      return 'Every selected product needs a weight greater than zero.'
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
      setError(caught instanceof Error ? caught.message : 'Could not create simulation run')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section aria-labelledby="create-title">
      <div className="section-heading">
        <div>
          <h2 id="create-title">Create a simulation run</h2>
          <p>Accounts register through API Gateway. Devices provision in PostgreSQL, claim through the public API, then connect to MQTT.</p>
        </div>
      </div>

      {!enabled && (
        <p className="notice notice--warning">Complete infrastructure preflight before creating a run.</p>
      )}
      {error && <p className="notice notice--error" role="alert">{error}</p>}

      <form className="run-form" onSubmit={handleSubmit}>
        <fieldset className="form-section" disabled={!enabled || loading}>
          <legend>Accounts and ownership</legend>
          <div className="form-grid form-grid--uneven">
            <Field label="Number of users" help="1–10,000 per run">
              <input min="1" max="10000" onChange={(event) => updateNumber('user_count', event.target.value)} required type="number" value={config.user_count} />
            </Field>
            <Field label="Username prefix" help="Letters, numbers, dash or underscore">
              <input maxLength={24} onChange={(event) => setConfig({ ...config, username_prefix: event.target.value })} pattern="[a-zA-Z0-9_-]+" required value={config.username_prefix} />
            </Field>
            <Field label="Email domain" help="Used only for generated accounts">
              <input onChange={(event) => setConfig({ ...config, email_domain: event.target.value })} required value={config.email_domain} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="form-section" disabled={!enabled || loading}>
          <legend>Device distribution</legend>
          <div className="form-grid">
            <Field label="Minimum per user">
              <input min="0" max="100" onChange={(event) => updateNumber('devices_min', event.target.value)} required type="number" value={config.devices_min} />
            </Field>
            <Field label="Maximum per user">
              <input min="0" max="100" onChange={(event) => updateNumber('devices_max', event.target.value)} required type="number" value={config.devices_max} />
            </Field>
            <Field label="Telemetry interval" help="Seconds; minimum 5">
              <input min="5" max="86400" onChange={(event) => updateNumber('telemetry_interval', event.target.value)} required type="number" value={config.telemetry_interval} />
            </Field>
            <Field label="Interval jitter" help="0–50%; spreads recurring telemetry">
              <input min="0" max="50" onChange={(event) => updateNumber('telemetry_jitter_percent', event.target.value)} required type="number" value={config.telemetry_jitter_percent} />
            </Field>
            <Field label="Startup ramp" help="Seconds; spreads the first telemetry burst">
              <input min="0" max="3600" onChange={(event) => updateNumber('startup_ramp_seconds', event.target.value)} required type="number" value={config.startup_ramp_seconds} />
            </Field>
            <Field label="Initial offline rate" help="Percent of devices kept offline">
              <input min="0" max="100" onChange={(event) => updateNumber('initial_offline_rate', event.target.value)} required type="number" value={config.initial_offline_rate} />
            </Field>
          </div>

          <div className="load-preview" aria-label="Projected maximum workload">
            <div><span>Max devices</span><strong>{formatNumber(workloadEstimate.maximumDevices)}</strong></div>
            <div><span>Expected online</span><strong>{formatNumber(workloadEstimate.expectedOnlineDevices)}</strong></div>
            <div><span>Projected telemetry</span><strong>{formatRate(workloadEstimate.telemetryPerSecond)} msg/s</strong></div>
          </div>

          <div className="product-selector">
            <h3>Product templates</h3>
            <p>Weights are relative. A 70 / 30 split produces roughly that distribution for large runs.</p>
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
                        <small>{product.id} · {product.capability_count} capabilities</small>
                      </span>
                    </label>
                    <input
                      aria-label={`Weight for ${product.display_name}`}
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
          <legend>Runtime and retention</legend>
          <div className="form-grid">
            <Field label="Cleanup policy" help="The 24-hour timer begins only after the run finishes.">
              <select
                onChange={(event) => setConfig({
                  ...config,
                  cleanup_policy: event.target.value as RunConfig['cleanup_policy'],
                })}
                value={config.cleanup_policy}
              >
                <option value="auto_24h">Clean 24 hours after completion</option>
                <option value="manual">Keep until manual cleanup</option>
              </select>
            </Field>
            <Field label="Random seed" help="Optional; reproduces counts and product choices">
              <input
                onChange={(event) => setConfig({ ...config, random_seed: event.target.value || undefined })}
                placeholder="Example: regression-2026-07"
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
            Connect eligible devices to MQTT as soon as they are claimed
          </label>
        </fieldset>

        <div className="form-actions">
          <button
            className="button button--primary"
            data-state={loading ? 'loading' : 'default'}
            disabled={!enabled || loading}
            type="submit"
          >
            {loading ? 'Creating run…' : 'Create run'}
          </button>
          <p>Registration is throttled to respect the real auth rate limit.</p>
        </div>
      </form>
    </section>
  )
}

const formatNumber = (value: number) => new Intl.NumberFormat().format(value)
const formatRate = (value: number) => new Intl.NumberFormat(undefined, {
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
