import { useCallback, useEffect, useState } from 'react'
import { fetchPreflight, getAdminToken, setAdminToken } from '../api'
import type { Preflight } from '../types'
import { Icon } from './Icon'

export function PreflightPanel({
  onReadyChange,
}: {
  onReadyChange: (ready: boolean) => void
}) {
  const [token, setToken] = useState(getAdminToken())
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const runPreflight = useCallback(async () => {
    if (!getAdminToken()) {
      setPreflight(null)
      onReadyChange(false)
      return
    }
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

  const saveToken = (event: React.FormEvent) => {
    event.preventDefault()
    setAdminToken(token)
    void runPreflight()
  }

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
          disabled={loading || !getAdminToken()}
          onClick={() => void runPreflight()}
          type="button"
        >
          <Icon name="refresh" />
          {loading ? 'Đang kiểm tra…' : 'Kiểm tra lại'}
        </button>
      </div>

      <form className="token-form" onSubmit={saveToken}>
        <label htmlFor="admin-token">Admin token của Simulator</label>
        <div className="field-row">
          <input
            autoComplete="off"
            id="admin-token"
            onChange={(event) => setToken(event.target.value)}
            placeholder="Dán giá trị ADMIN_TOKEN từ .env.docker"
            type="password"
            value={token}
          />
          <button className="button button--primary" disabled={token.trim().length < 16} type="submit">
            Xác thực token
          </button>
        </div>
        <p className="field-help">Chỉ lưu trong session storage của tab trình duyệt này. Có thể dán cả `ADMIN_TOKEN=` hoặc `Bearer`.</p>
      </form>

      {error && <p className="notice notice--error" role="alert">{error}</p>}

      {!error && preflight && (
        <p
          className={`notice ${preflight.success ? 'notice--success' : 'notice--warning'}`}
          role="status"
        >
          {preflight.success
            ? 'Token hợp lệ. Toàn bộ hạ tầng Simulator đã sẵn sàng.'
            : 'Token hợp lệ, nhưng một hoặc nhiều dependency chưa sẵn sàng.'}
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
          : <p className="empty-inline">Nhập admin token để chạy preflight.</p>}
      </div>
    </section>
  )
}

const dependencyName = (value: string): string => ({
  api_gateway: 'API Gateway',
  postgres: 'PostgreSQL',
  mongodb: 'MongoDB',
  mqtt: 'MQTT Broker',
  catalog: 'Product Catalog',
}[value] || value.replaceAll('_', ' '))
