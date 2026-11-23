import { useState } from 'react'
import { changeOwnPassword } from '../api'
import { explain } from './ConsoleContext'

const MIN = 10

/** Change the signed-in person's password: the current one, then the new one twice. */
export function PasswordForm({ onChanged, temporary }: { onChanged: () => void; temporary?: boolean }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const problem = next.length > 0 && next.length < MIN
    ? `Mật khẩu mới cần ít nhất ${MIN} ký tự.`
    : again.length > 0 && again !== next ? 'Hai lần nhập mật khẩu mới chưa giống nhau.' : ''
  const ready = current.length > 0 && next.length >= MIN && next === again && !busy

  return (
    <form
      className="console-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!ready) return
        setBusy(true)
        setError('')
        changeOwnPassword(current, next)
          .then(() => {
            setCurrent('')
            setNext('')
            setAgain('')
            onChanged()
          })
          .catch((caught) => setError(explain(caught, 'Chưa đổi được mật khẩu.')))
          .finally(() => setBusy(false))
      }}
    >
      <label className="field">
        <span>{temporary ? 'Mật khẩu tạm' : 'Mật khẩu hiện tại'}</span>
        <input autoComplete="current-password" onChange={(event) => setCurrent(event.target.value)} type="password" value={current} />
      </label>
      <label className="field">
        <span>Mật khẩu mới</span>
        <input autoComplete="new-password" onChange={(event) => setNext(event.target.value)} type="password" value={next} />
        <small>Ít nhất {MIN} ký tự. Các phiên đăng nhập khác sẽ bị đăng xuất.</small>
      </label>
      <label className="field">
        <span>Nhập lại mật khẩu mới</span>
        <input autoComplete="new-password" onChange={(event) => setAgain(event.target.value)} type="password" value={again} />
      </label>
      {(problem || error) && <p className="notice notice--error" role="alert">{error || problem}</p>}
      <button className="button button--primary" disabled={!ready} type="submit">{busy ? 'Đang đổi…' : 'Đổi mật khẩu'}</button>
    </form>
  )
}
