import { type ReactNode, useEffect, useRef, useState } from 'react'
import { readError } from '../format'

/**
 * Every change on the "Quản trị" page asks why: the reason goes to the
 * administration log with the change. [children] adds fields (plan, amount).
 */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  ready = true,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  danger?: boolean
  /** False while the extra fields are incomplete. */
  ready?: boolean
  onCancel: () => void
  onConfirm: (reason: string) => Promise<void>
  children?: ReactNode
}) {
  const ref = useRef<HTMLDialogElement | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      setReason('')
      setError('')
      setBusy(false)
      dialog.showModal()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  const valid = reason.trim().length >= 3 && ready

  return (
    <dialog className="confirm-dialog" onClose={onCancel} ref={ref}>
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!valid || busy) return
          setBusy(true)
          setError('')
          onConfirm(reason.trim())
            .catch((caught) => setError(readError(caught, 'Chưa thực hiện được.')))
            .finally(() => setBusy(false))
        }}
      >
        <h2>{title}</h2>
        <div className="admin-dialog__description">{description}</div>
        {children}
        <label className="field">
          <span>Lý do (ghi vào nhật ký quản trị)</span>
          <textarea
            maxLength={300}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Ví dụ: khách báo bị lộ mật khẩu qua tổng đài"
            required
            rows={3}
            value={reason}
          />
        </label>
        {error && <p className="notice notice--error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button button--quiet" onClick={onCancel} type="button">Thôi</button>
          <button className={`button ${danger ? 'button--danger' : 'button--primary'}`} disabled={!valid || busy} type="submit">
            {busy ? 'Đang thực hiện…' : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  )
}
