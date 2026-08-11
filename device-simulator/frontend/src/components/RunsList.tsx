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
import { RunMetricsPanel } from './RunMetricsPanel'

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
      setError(caught instanceof Error ? caught.message : 'Không thể tải các phiên mô phỏng')
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
      setError(caught instanceof Error ? caught.message : 'Không thể tải chi tiết phiên')
    }
  }

  const act = async (
    run: SimulationRun,
    action: 'pause' | 'resume' | 'cancel' | 'stop-runtime' | 'restart-runtime',
  ) => {
    setActing(`${run.id}:${action}`)
    setError('')
    try {
      await runAction(run.id, action)
      await loadRuns()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không thể cập nhật trạng thái phiên')
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
      setError(caught instanceof Error ? caught.message : 'Không thể cập nhật chính sách lưu giữ')
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
      setError(caught instanceof Error ? caught.message : 'Không thể gia hạn dữ liệu')
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
      setError(caught instanceof Error ? caught.message : 'Không thể dọn dữ liệu mô phỏng')
      dialogRef.current?.close()
    } finally {
      setActing('')
    }
  }

  return (
    <section aria-labelledby="runs-title">
      <div className="section-heading">
        <div>
          <h2 id="runs-title">Phiên mô phỏng</h2>
          <p>Mở một phiên để xem toàn bộ tài khoản và thiết bị đã được tạo.</p>
        </div>
        <button className="button button--quiet" disabled={!enabled || loading} onClick={() => void loadRuns()} type="button">
          <Icon name="refresh" />
          Làm mới
        </button>
      </div>

      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loading && <div className="skeleton-list" aria-label="Đang tải các phiên mô phỏng" />}
      {!loading && runs.length === 0 && (
        <div className="empty-state">
          <Icon name="runs" size={24} />
          <h3>Chưa có phiên mô phỏng</h3>
          <p>Tạo một phiên để đăng ký người dùng, cấp phát thiết bị và bắt đầu gửi MQTT.</p>
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
                  <span>{run.progress.users_created}/{run.progress.users_requested} người dùng</span>
                  <span>{run.progress.devices_claimed}/{run.progress.devices_requested} thiết bị</span>
                  <progress aria-label={`Đã tạo ${progress}% người dùng`} max="100" value={progress} />
                </div>
                <Icon name="arrow" />
              </button>

              {expanded && (
                <div className="run-detail">
                  <div className="run-actions" aria-label={`Thao tác cho ${run.id}`}>
                    {['queued', 'running'].includes(run.status) && (
                      <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act(run, 'pause')} type="button">Tạm dừng</button>
                    )}
                    {['paused', 'failed'].includes(run.status) && (
                      <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act(run, 'resume')} type="button">Tiếp tục</button>
                    )}
                    {!['completed', 'partial', 'failed', 'cancelled', 'cleaned', 'cleaning'].includes(run.status) && (
                      <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act(run, 'cancel')} type="button">Hủy</button>
                    )}
                    {!['cleaning', 'cleaned', 'cleanup_blocked'].includes(run.status) && (
                      <>
                        <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act(run, 'stop-runtime')} type="button">Dừng thiết bị</button>
                        <button className="button button--quiet" disabled={Boolean(acting) || run.status === 'paused'} onClick={() => void act(run, 'restart-runtime')} type="button">Khởi động lại</button>
                      </>
                    )}
                    {run.status !== 'cleaned' && (
                      <>
                        <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void retain(run, !retainedPermanently)} type="button">
                          {retainedPermanently ? 'Khôi phục dọn sau 24 giờ' : 'Lưu vĩnh viễn'}
                        </button>
                        {!retainedPermanently && run.completed_at && (
                          <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void addDay(run)} type="button">Gia hạn 24 giờ</button>
                        )}
                        <button className="button button--danger" disabled={Boolean(acting)} onClick={() => openCleanup(run)} type="button">Dọn ngay</button>
                      </>
                    )}
                  </div>

                  <RunMetricsPanel runId={run.id} />

                  <dl className="run-spec">
                    <div><dt>Dọn dữ liệu</dt><dd>{retainedPermanently ? 'Thủ công' : run.cleanup_after ? formatDate(run.cleanup_after) : 'Bắt đầu sau khi hoàn tất'}</dd></div>
                    <div><dt>Telemetry</dt><dd>Mỗi {run.config.telemetry_interval} giây</dd></div>
                    <div><dt>Lỗi</dt><dd>{run.total_errors}</dd></div>
                  </dl>

                  <div className="entity-columns">
                    <EntityList title="Người dùng đã tạo" empty="Chưa có tài khoản nào được đăng ký.">
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
                    <EntityList title="Thiết bị ảo" empty="Chưa có thiết bị nào được cấp phát.">
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
        <h2>Xóa dữ liệu do phiên này tạo?</h2>
        <p>Chỉ tài khoản, thiết bị, shadow và telemetry có trong registry bị xóa. Thao tác này không thể hoàn tác.</p>
        <label className="field">
          <span>Nhập ID phiên để xác nhận</span>
          <input onChange={(event) => setTypedId(event.target.value)} value={typedId} />
          <small>{run?.id || '\u00a0'}</small>
        </label>
        <div className="dialog-actions">
          <button className="button button--quiet" onClick={() => dialogRef.current?.close()} type="button">Giữ dữ liệu</button>
          <button className="button button--danger" disabled={busy || typedId !== run?.id} type="submit">
            {busy ? 'Đang dọn…' : 'Xóa dữ liệu đã tạo'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ['online', 'completed', 'ready', 'cleaned'].includes(status)
    ? 'ok'
    : ['failed', 'cleanup_failed', 'mqtt_error', 'contract_error'].includes(status)
      ? 'error'
      : ['partial', 'cleanup_blocked', 'paused'].includes(status)
        ? 'warning'
        : 'neutral'
  return <span className={`status-badge status-badge--${tone}`}>{translateStatus(status)}</span>
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

const translateStatus = (status: string) => ({
  online: 'trực tuyến', offline: 'ngoại tuyến', completed: 'hoàn tất', ready: 'sẵn sàng',
  cleaned: 'đã dọn', failed: 'thất bại', cleanup_failed: 'dọn thất bại', mqtt_error: 'lỗi MQTT',
  contract_error: 'lỗi phiên bản Product',
  partial: 'một phần', cleanup_blocked: 'bị chặn dọn', paused: 'tạm dừng', queued: 'đang chờ',
  running: 'đang chạy', cancelled: 'đã hủy', cleaning: 'đang dọn', registered: 'đã đăng ký',
  claimed: 'đã ghép', provisioned: 'đã cấp phát', stopped: 'đã dừng', error: 'lỗi',
}[status] ?? status.replaceAll('_', ' '))
