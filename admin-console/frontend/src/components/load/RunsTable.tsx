import { useEffect, useRef, useState } from 'react'
import { runAction, setRunPermanent } from '../../api'
import type { SimulationRun } from '../../types'
import { formatDate, formatNumber, readError, runStatusLabel, runTone } from '../format'

type RunAction = 'pause' | 'resume' | 'cancel' | 'stop-runtime' | 'restart-runtime'

const ACTIVE = ['queued', 'running']
const FINISHED = ['completed', 'partial', 'failed', 'cancelled']

/** History of load runs with the actions that apply to each state. */
export function RunsTable({
  runs,
  loading,
  focusRunId,
  onChanged,
  onOpenDevices,
}: {
  runs: SimulationRun[]
  loading: boolean
  focusRunId?: string
  onChanged: () => Promise<void>
  onOpenDevices: (runId: string) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(focusRunId || null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [cleanup, setCleanup] = useState<SimulationRun | null>(null)

  useEffect(() => {
    if (focusRunId) setExpanded(focusRunId)
  }, [focusRunId])

  const act = async (run: SimulationRun, key: string, action: () => Promise<unknown>, failure: string) => {
    setBusy(`${run.id}:${key}`)
    setError('')
    try {
      await action()
      await onChanged()
    } catch (caught) {
      setError(readError(caught, failure))
    } finally {
      setBusy('')
    }
  }

  const runActionOf = (run: SimulationRun, action: RunAction) =>
    act(run, action, () => runAction(run.id, action), 'Không cập nhật được lần chạy.')

  return (
    <section aria-labelledby="runs-title" className="runs">
      <header className="work-panel__heading">
        <div>
          <h3 id="runs-title">Các lần chạy</h3>
          <p>Mỗi lần chạy giữ người dùng và thiết bị của riêng nó; dọn lần chạy là xóa toàn bộ dữ liệu đó.</p>
        </div>
      </header>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {loading ? (
        <div className="registry-skeleton" aria-label="Đang tải các lần chạy"><span /><span /></div>
      ) : runs.length === 0 ? (
        <p className="empty-inline">Chưa có lần chạy nào. Chọn một mẫu bên cạnh rồi bấm “Bắt đầu chạy”.</p>
      ) : (
        <ol className="run-table">
          {runs.map((run) => {
            const open = expanded === run.id
            const progress = run.progress.devices_requested > 0
              ? run.progress.devices_claimed / run.progress.devices_requested
              : run.progress.users_requested > 0 ? run.progress.users_created / run.progress.users_requested : 0
            const permanent = run.config.cleanup_policy === 'manual'
            const disabled = Boolean(busy)
            return (
              <li className="run-row" data-open={open || undefined} key={run.id}>
                <button aria-expanded={open} className="run-row__summary" onClick={() => setExpanded(open ? null : run.id)} type="button">
                  <span className={`runtime-badge runtime-badge--${runTone(run.status)}`}><i aria-hidden="true" />{runStatusLabel(run.status)}</span>
                  <span className="run-row__identity">
                    <strong>{formatNumber(run.config.user_count)} người dùng · {run.config.devices_min}–{run.config.devices_max} thiết bị/người</strong>
                    <small>{formatDate(run.created_at)} · telemetry {run.config.telemetry_interval} giây · <code>{run.id.slice(4, 12)}</code></small>
                  </span>
                  <span className="run-row__progress">
                    <small>{formatNumber(run.progress.devices_claimed)} / {formatNumber(run.progress.devices_requested || 0)} thiết bị</small>
                    <progress aria-label="Tiến độ tạo thiết bị" max={1} value={Math.min(1, progress)} />
                  </span>
                </button>
                {open && (
                  <div className="run-row__detail">
                    <dl className="run-row__facts">
                      <div><dt>Người dùng đã tạo</dt><dd>{formatNumber(run.progress.users_created)} / {formatNumber(run.progress.users_requested)}</dd></div>
                      <div><dt>Thiết bị đã cấp phát</dt><dd>{formatNumber(run.progress.devices_provisioned)}</dd></div>
                      <div><dt>Lỗi ghi nhận</dt><dd>{formatNumber(run.total_errors)}</dd></div>
                      <div><dt>Dọn dữ liệu</dt><dd>{permanent ? 'Thủ công' : run.cleanup_after ? formatDate(run.cleanup_after) : '24 giờ sau khi xong'}</dd></div>
                    </dl>
                    {run.last_error && <p className="notice notice--error">{run.last_error}</p>}
                    <div className="run-row__actions">
                      <button className="button button--compact" onClick={() => onOpenDevices(run.id)} type="button">Xem thiết bị</button>
                      {ACTIVE.includes(run.status) && (
                        <button className="button button--compact" disabled={disabled} onClick={() => void runActionOf(run, 'pause')} type="button">Tạm dừng</button>
                      )}
                      {['paused', 'failed', 'partial'].includes(run.status) && (
                        <button className="button button--compact" disabled={disabled} onClick={() => void runActionOf(run, 'resume')} type="button">
                          {run.status === 'partial' ? 'Tạo bù phần thiếu' : 'Tiếp tục'}
                        </button>
                      )}
                      {[...ACTIVE, 'paused'].includes(run.status) && (
                        <button className="button button--quiet button--compact" disabled={disabled} onClick={() => void runActionOf(run, 'cancel')} type="button">Hủy tạo</button>
                      )}
                      {FINISHED.includes(run.status) && (
                        <>
                          <button className="button button--quiet button--compact" disabled={disabled} onClick={() => void runActionOf(run, 'stop-runtime')} type="button">Tắt thiết bị</button>
                          <button className="button button--quiet button--compact" disabled={disabled} onClick={() => void runActionOf(run, 'restart-runtime')} type="button">Bật lại thiết bị</button>
                        </>
                      )}
                      {!['cleaning', 'cleaned'].includes(run.status) && (
                        <>
                          <button
                            className="button button--quiet button--compact"
                            disabled={disabled}
                            onClick={() => void act(run, 'retention', () => setRunPermanent(run.id, !permanent), 'Không đổi được chế độ lưu giữ.')}
                            type="button"
                          >
                            {permanent ? 'Tự dọn sau 24 giờ' : 'Giữ dữ liệu'}
                          </button>
                          <button className="button button--danger button--compact" disabled={disabled} onClick={() => setCleanup(run)} type="button">Dọn dữ liệu</button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      <CleanupDialog
        run={cleanup}
        onCancel={() => setCleanup(null)}
        onConfirm={() => {
          const run = cleanup
          setCleanup(null)
          if (run) void act(run, 'cleanup', () => runAction(run.id, 'cleanup'), 'Không dọn được dữ liệu lần chạy.')
        }}
      />
    </section>
  )
}

function CleanupDialog({
  run,
  onCancel,
  onConfirm,
}: {
  run: SimulationRun | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const ref = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (run && !dialog.open) dialog.showModal()
    if (!run && dialog.open) dialog.close()
  }, [run])
  return (
    <dialog className="confirm-dialog" onClose={onCancel} ref={ref}>
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); onConfirm() }}>
        <h2>Dọn dữ liệu của lần chạy này?</h2>
        <p>
          {run ? `${formatNumber(run.progress.users_created)} tài khoản và ${formatNumber(run.progress.devices_claimed)} thiết bị ` : ''}
          bị gỡ khỏi hệ thống chính cùng telemetry, shadow và video của chúng. Không thể hoàn tác. Thiết bị Xưởng và tài khoản người dùng thật không bị ảnh hưởng.
        </p>
        <div className="dialog-actions">
          <button className="button button--quiet" onClick={onCancel} type="button">Giữ lại</button>
          <button className="button button--danger" type="submit">Dọn dữ liệu</button>
        </div>
      </form>
    </dialog>
  )
}
