import { useState } from 'react'
import { signIn } from '../api'
import { explain } from './ConsoleContext'
import { PasswordForm } from './PasswordForm'

/** The Console's front door: staff e-mail and password (customers' accounts do not work here). */
export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  return (
    <main className="console-gate">
      <section aria-labelledby="login-title" className="console-gate__card">
        <span className="brand-mark" aria-hidden="true">SX</span>
        <h1 id="login-title">Admin Console</h1>
        <p>SmartHome XuanLam · dành cho nhân viên công ty</p>
        <form
          className="console-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy) return
            setBusy(true)
            setError('')
            signIn(email.trim(), password)
              .then(() => onSignedIn())
              .catch((caught) => setError(explain(caught, 'Chưa đăng nhập được.')))
              .finally(() => setBusy(false))
          }}
        >
          <label className="field">
            <span>Email</span>
            <input autoComplete="username" autoFocus onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
          </label>
          <label className="field">
            <span>Mật khẩu</span>
            <input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
          </label>
          {error && <p className="notice notice--error" role="alert">{error}</p>}
          <button className="button button--primary" disabled={busy || !email || !password} type="submit">
            {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
          </button>
        </form>
        <p className="console-gate__note">Quên mật khẩu? Nhờ admin gốc đặt lại mật khẩu tạm.</p>
      </section>
    </main>
  )
}

/** A temporary password (new staff member, reset) must be replaced before anything else. */
export function FirstPasswordPage({ name, onDone, onSignOut }: { name: string; onDone: () => void; onSignOut: () => void }) {
  return (
    <main className="console-gate">
      <section aria-labelledby="first-password-title" className="console-gate__card">
        <span className="brand-mark" aria-hidden="true">SX</span>
        <h1 id="first-password-title">Chào {name}</h1>
        <p>Bạn đang dùng mật khẩu tạm. Hãy đặt mật khẩu của riêng bạn để tiếp tục.</p>
        <PasswordForm onChanged={onDone} temporary />
        <button className="button button--quiet button--compact" onClick={onSignOut} type="button">Đăng xuất</button>
      </section>
    </main>
  )
}
