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
      setError(caught instanceof Error ? caught.message : 'Could not check simulator infrastructure')
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
          <h2 id="preflight-title">Infrastructure</h2>
          <p>Five checks must pass before the simulator can create real accounts and devices.</p>
        </div>
        <button
          className="button button--quiet"
          data-state={loading ? 'loading' : 'default'}
          disabled={loading || !getAdminToken()}
          onClick={() => void runPreflight()}
          type="button"
        >
          <Icon name="refresh" />
          {loading ? 'Checking…' : 'Check again'}
        </button>
      </div>

      <form className="token-form" onSubmit={saveToken}>
        <label htmlFor="admin-token">Simulator admin token</label>
        <div className="field-row">
          <input
            autoComplete="off"
            id="admin-token"
            onChange={(event) => setToken(event.target.value)}
            placeholder="Paste the token from device-simulator/.env"
            type="password"
            value={token}
          />
          <button className="button button--primary" disabled={token.trim().length < 16} type="submit">
            Verify token
          </button>
        </div>
        <p className="field-help">Stored only in this browser tab’s session storage.</p>
      </form>

      {error && <p className="notice notice--error" role="alert">{error}</p>}

      <div className="check-grid" aria-live="polite">
        {preflight
          ? Object.entries(preflight.checks).map(([name, check]) => (
              <article className="check-row" key={name}>
                <span className={`status-mark status-mark--${check.status}`} aria-hidden="true" />
                <div>
                  <strong>{name.replaceAll('_', ' ')}</strong>
                  <span>{check.status === 'ok' ? `${check.latency_ms} ms` : check.message}</span>
                </div>
              </article>
            ))
          : <p className="empty-inline">Enter the admin token to run preflight checks.</p>}
      </div>
    </section>
  )
}
