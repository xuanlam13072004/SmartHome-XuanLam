import { useCallback, useEffect, useRef, useState } from 'react'
import {
  extendRun,
  fetchDevices,
  fetchRuns,
  fetchUsers,
  runAction,
  setRunPermanent,
  subscribeStream,
} from '../api'
import type {
  SimulatedDevice,
  SimulatedUser,
  SimulationRun,
} from '../types'
import { Icon } from './Icon'

export default function RunsList({
  enabled,
  focusRunId,
  onSelectUser,
  onSelectDevice,
}: {
  enabled: boolean
  focusRunId?: string
  onSelectUser: (accountId: string) => void
  onSelectDevice: (mac: string) => void
}) {
  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [expandedRun, setExpandedRun] = useState<string | null>(focusRunId || null)
  const [users, setUsers] = useState<SimulatedUser[]>([])
  const [devices, setDevices] = useState<SimulatedDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState('')
  const [error, setError] = useState('')
  const [cleanupRun, setCleanupRun] = useState<SimulationRun | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const loadRuns = useCallback(async () => {
    if (!enabled) return
    try {
      setRuns(await fetchRuns())
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load simulation runs')
    } finally {
      setLoading(false)
    }
  }, [enabled])

  const loadChildren = useCallback(async (runId: string) => {
    const [nextUsers, nextDevices] = await Promise.all([
      fetchUsers(runId),
      fetchDevices(runId),
    ])
    setUsers(nextUsers)
    setDevices(nextDevices)
  }, [])

  useEffect(() => {
    void loadRuns()
    if (!enabled) return
    const stop = subscribeStream((event) => {
      void loadRuns()
      if (expandedRun && (!event.run_id || event.run_id === expandedRun)) {
        void loadChildren(expandedRun)
      }
    })
    const interval = window.setInterval(() => void loadRuns(), 10000)
    return () => {
      stop()
      window.clearInterval(interval)
    }
  }, [enabled, expandedRun, loadChildren, loadRuns])

  useEffect(() => {
    if (focusRunId) {
      setExpandedRun(focusRunId)
      if (enabled) void loadChildren(focusRunId)
    }
  }, [enabled, focusRunId, loadChildren])

  const toggleRun = async (runId: string) => {
    if (expandedRun === runId) {
      setExpandedRun(null)
      return
    }
    setExpandedRun(runId)
    try {
      await loadChildren(runId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load run details')
    }
  }

  const act = async (run: SimulationRun, action: 'pause' | 'resume' | 'cancel') => {
    setActing(`${run.id}:${action}`)
    setError('')
    try {
      await runAction(run.id, action)
      await loadRuns()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${action} run`)
    } finally {
      setActing('')
    }
  }

  const retain = async (run: SimulationRun, permanent: boolean) => {
    setActing(`${run.id}:retention`)
    try {
      await setRunPermanent(run.id, permanent)
      await loadRuns()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update retention')
    } finally {
      setActing('')
    }
  }

  const addDay = async (run: SimulationRun) => {
    setActing(`${run.id}:extend`)
    try {
      await extendRun(run.id, 24)
      await loadRuns()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not extend retention')
    } finally {
      setActing('')
    }
  }

  const openCleanup = (run: SimulationRun) => {
    setCleanupRun(run)
    window.setTimeout(() => dialogRef.current?.showModal(), 0)
  }

  const confirmCleanup = async (typedId: string) => {
    if (!cleanupRun || typedId !== cleanupRun.id) return
    setActing(`${cleanupRun.id}:cleanup`)
    try {
      await runAction(cleanupRun.id, 'cleanup')
      dialogRef.current?.close()
      setCleanupRun(null)
      setExpandedRun(null)
      await loadRuns()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not clean simulation data')
      dialogRef.current?.close()
    } finally {
      setActing('')
    }
  }

  return (
    <section aria-labelledby="runs-title">
      <div className="section-heading">
        <div>
          <h2 id="runs-title">Simulation runs</h2>
          <p>Expand a run to inspect every registered account and claimed device.</p>
        </div>
        <button className="button button--quiet" disabled={!enabled || loading} onClick={() => void loadRuns()} type="button">
          <Icon name="refresh" />
          Refresh
        </button>
      </div>

      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loading && <div className="skeleton-list" aria-label="Loading simulation runs" />}
      {!loading && runs.length === 0 && (
        <div className="empty-state">
          <Icon name="runs" size={24} />
          <h3>No simulation runs yet</h3>
          <p>Create one run to register users, provision devices and start MQTT telemetry.</p>
        </div>
      )}

      <div className="run-list">
        {runs.map((run) => {
          const expanded = expandedRun === run.id
          const progress = run.progress.users_requested > 0
            ? Math.round((run.progress.users_created / run.progress.users_requested) * 100)
            : 0
          const retainedPermanently = run.config.cleanup_policy === 'manual'
          return (
            <article className="run-sheet" key={run.id}>
              <button
                aria-expanded={expanded}
                className="run-summary"
                onClick={() => void toggleRun(run.id)}
                type="button"
              >
                <div className="run-identity">
                  <StatusBadge status={run.status} />
                  <strong>{run.id}</strong>
                  <span>{formatDate(run.created_at)}</span>
                </div>
                <div className="run-progress">
                  <span>{run.progress.users_created}/{run.progress.users_requested} users</span>
                  <span>{run.progress.devices_claimed}/{run.progress.devices_requested} devices</span>
                  <progress aria-label={`${progress}% of users generated`} max="100" value={progress} />
                </div>
                <Icon name="arrow" />
              </button>

              {expanded && (
                <div className="run-detail">
                  <div className="run-actions" aria-label={`Actions for ${run.id}`}>
                    {['queued', 'running'].includes(run.status) && (
                      <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act(run, 'pause')} type="button">Pause</button>
                    )}
                    {['paused', 'failed'].includes(run.status) && (
                      <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act(run, 'resume')} type="button">Resume</button>
                    )}
                    {!['completed', 'partial', 'failed', 'cancelled', 'cleaned', 'cleaning'].includes(run.status) && (
                      <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act(run, 'cancel')} type="button">Cancel</button>
                    )}
                    {run.status !== 'cleaned' && (
                      <>
                        <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void retain(run, !retainedPermanently)} type="button">
                          {retainedPermanently ? 'Restore 24 h cleanup' : 'Keep permanently'}
                        </button>
                        {!retainedPermanently && run.completed_at && (
                          <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void addDay(run)} type="button">Extend 24 h</button>
                        )}
                        <button className="button button--danger" disabled={Boolean(acting)} onClick={() => openCleanup(run)} type="button">Cleanup now</button>
                      </>
                    )}
                  </div>

                  <dl className="run-spec">
                    <div><dt>Cleanup</dt><dd>{retainedPermanently ? 'Manual' : run.cleanup_after ? formatDate(run.cleanup_after) : 'Starts after completion'}</dd></div>
                    <div><dt>Telemetry</dt><dd>Every {run.config.telemetry_interval} s</dd></div>
                    <div><dt>Errors</dt><dd>{run.total_errors}</dd></div>
                  </dl>

                  <div className="entity-columns">
                    <EntityList title="Generated users" empty="No account has registered yet.">
                      {users.map((user) => (
                        <button
                          className="entity-row"
                          disabled={!user.account_id}
                          key={`${user.run_id}:${user.generation_index}`}
                          onClick={() => user.account_id && onSelectUser(user.account_id)}
                          type="button"
                        >
                          <Icon name="user" />
                          <span><strong>{user.full_name}</strong><small>{user.email}</small></span>
                          <StatusBadge status={user.generation_state} />
                        </button>
                      ))}
                    </EntityList>
                    <EntityList title="Virtual devices" empty="No device has been provisioned yet.">
                      {devices.map((device) => (
                        <button className="entity-row" key={device.mac} onClick={() => onSelectDevice(device.mac)} type="button">
                          <Icon name="device" />
                          <span><strong>{device.name}</strong><small>{device.mac}</small></span>
                          <StatusBadge status={device.runtime_state} />
                        </button>
                      ))}
                    </EntityList>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>

      <CleanupDialog
        dialogRef={dialogRef}
        run={cleanupRun}
        busy={acting.endsWith(':cleanup')}
        onConfirm={confirmCleanup}
        onClose={() => setCleanupRun(null)}
      />
    </section>
  )
}

function EntityList({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: React.ReactNode
}) {
  const count = Array.isArray(children) ? children.length : 0
  return (
    <section className="entity-list">
      <h3>{title}</h3>
      {count > 0 ? children : <p className="empty-inline">{empty}</p>}
    </section>
  )
}

function CleanupDialog({
  dialogRef,
  run,
  busy,
  onConfirm,
  onClose,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>
  run: SimulationRun | null
  busy: boolean
  onConfirm: (typedId: string) => void
  onClose: () => void
}) {
  const [typedId, setTypedId] = useState('')
  useEffect(() => setTypedId(''), [run])
  return (
    <dialog className="confirm-dialog" onClose={onClose} ref={dialogRef}>
      <form onSubmit={(event) => { event.preventDefault(); onConfirm(typedId) }}>
        <h2>Delete this run’s generated data?</h2>
        <p>This removes only registry-tracked accounts, devices, shadows and telemetry. The action cannot be undone.</p>
        <label className="field">
          <span>Type the run ID to confirm</span>
          <input onChange={(event) => setTypedId(event.target.value)} value={typedId} />
          <small>{run?.id || '\u00a0'}</small>
        </label>
        <div className="dialog-actions">
          <button className="button button--quiet" onClick={() => dialogRef.current?.close()} type="button">Keep data</button>
          <button className="button button--danger" disabled={busy || typedId !== run?.id} type="submit">
            {busy ? 'Cleaning…' : 'Delete generated data'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ['online', 'completed', 'ready', 'cleaned'].includes(status)
    ? 'ok'
    : ['failed', 'cleanup_failed', 'mqtt_error'].includes(status)
      ? 'error'
      : ['partial', 'cleanup_blocked', 'paused'].includes(status)
        ? 'warning'
        : 'neutral'
  return <span className={`status-badge status-badge--${tone}`}>{status.replaceAll('_', ' ')}</span>
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
