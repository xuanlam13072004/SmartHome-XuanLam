import { useCallback, useEffect, useState } from 'react'
import { fetchPreflight } from '../api'
import type { Preflight } from '../types'
import { Icon } from './Icon'

/** The Simulator's dependencies, checked by its backend (reached through the Console). */
export function PreflightPanel({
  onReadyChange,
}: {
  onReadyChange: (ready: boolean) => void
}) {
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const runPreflight = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await fetchPreflight()
      setPreflight(result)
      onReadyChange(result.success)
    } catch (caught) {
      setPreflight(null)
      onReadyChange(false)
      setError(caught instanceof Error ? caught.message : 'Không kiểm tra được hạ tầng Simulator.')
    } finally {
      setLoading(false)
    }
  }, [onReadyChange])

  useEffect(() => {
    void runPreflight()
  }, [runPreflight])

  return (
    <section className="preflight" aria-labelledby="preflight-title">
      <div className="section-heading">
        <div>
          <h2 id="preflight-title">Kiểm tra hạ tầng</h2>
          <p>Năm dependency phải sẵn sàng trước khi Simulator tạo tài khoản và thiết bị thật trong hệ thống.</p>
        </div>
        <button
          className="button button--quiet"
          data-state={loading ? 'loading' : 'default'}
          disabled={loading}
          onClick={() => void runPreflight()}
          type="button"
        >
          <Icon name="refresh" />
          {loading ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
        </button>
      </div>

      {error && <p className="notice notice--error" role="alert">{error}</p>}

      {!error && preflight && (
        <p
          className={`notice ${preflight.success ? 'notice--success' : 'notice--warning'}`}
          role="status"
        >
          {preflight.success
            ? 'Toàn bộ hạ tầng Simulator đã sẵn sàng.'
            : 'Một hoặc nhiều dependency chưa sẵn sàng.'}
        </p>
      )}

      <div className="check-grid" aria-live="polite">
        {preflight
          ? Object.entries(preflight.checks).map(([name, check]) => (
              <article className="check-row" key={name}>
                <span className={`status-mark status-mark--${check.status}`} aria-hidden="true" />
                <div>
                  <strong>{dependencyName(name)}</strong>
                  <span>{check.status === 'ok' ? `${check.latency_ms} ms` : check.message}</span>
                </div>
              </article>
            ))
          : <p className="empty-inline">{loading ? 'Đang kiểm tra…' : 'Chưa có kết quả.'}</p>}
      </div>
    </section>
  )
}

const dependencyName = (value: string): string => ({
  api_gateway: 'API Gateway',
  factory_api: 'API xưởng (FACTORY_API_KEY)',
  mongodb: 'MongoDB của Simulator',
  mqtt: 'Cổng MQTT của broker',
  catalog: 'Product Catalog',
}[value] || value.replaceAll('_', ' '))
