import { useCallback, useEffect, useState } from 'react'
import { actOnStaff, createStaff, fetchPermissions, fetchStaff, type StaffAction, updateStaff } from '../api'
import { CopyButton } from '../components/CopyButton'
import { formatRelative, readError } from '../components/format'
import { ReasonDialog } from '../components/admin/ReasonDialog'
import type { PermissionInfo, PermissionPreset, StaffMember } from '../types'
import { explain } from './ConsoleContext'

/** Picks permissions: presets, then one box per permission grouped by area; "manage" includes "view". */
function PermissionPicker({
  catalog,
  presets,
  value,
  onChange,
}: {
  catalog: PermissionInfo[]
  presets: PermissionPreset[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  const implied = new Set(catalog.filter((item) => value.includes(item.code)).flatMap((item) => item.implies ?? []))
  const groups = [...new Set(catalog.map((item) => item.group))]
  const toggle = (code: string, on: boolean) => onChange(on ? [...value, code] : value.filter((item) => item !== code))
  // A preset is "on" when the boxes add up to exactly its permissions (a manage includes its view).
  const expand = (codes: readonly string[]) =>
    new Set(codes.flatMap((code) => [code, ...(catalog.find((item) => item.code === code)?.implies ?? [])]))
  const chosen = expand(value)
  const matches = (preset: PermissionPreset) => {
    const wanted = expand(preset.permissions)
    return wanted.size === chosen.size && [...wanted].every((code) => chosen.has(code))
  }
  return (
    <div className="permission-picker">
      <div className="segment-control" role="group" aria-label="Mẫu quyền">
        {presets.map((preset) => (
          <button
            aria-pressed={matches(preset)}
            className="segment-control__option"
            key={preset.code}
            onClick={() => onChange([...preset.permissions])}
            type="button"
          >
            {preset.name}
          </button>
        ))}
        <button className="segment-control__option" onClick={() => onChange([])} type="button">Bỏ hết</button>
      </div>
      <div className="permission-picker__groups">
        {groups.map((group) => (
          <fieldset className="permission-group" key={group}>
            <legend>{group}</legend>
            {catalog.filter((item) => item.group === group).map((item) => {
              const included = implied.has(item.code) && !value.includes(item.code)
              return (
                <label className="check-control" key={item.code}>
                  <input
                    checked={value.includes(item.code) || included}
                    disabled={included}
                    onChange={(event) => toggle(item.code, event.target.checked)}
                    type="checkbox"
                  />
                  <span>{item.label}{included ? ' (đã gồm)' : ''}</span>
                </label>
              )
            })}
          </fieldset>
        ))}
      </div>
    </div>
  )
}

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; member: StaffMember }
  | { kind: StaffAction; member: StaffMember }
  | null

const ACTION_TEXT: Record<StaffAction, { title: string; confirm: string; danger?: boolean; description: string }> = {
  disable: { title: 'Khóa nhân viên?', confirm: 'Khóa', danger: true, description: 'Người này bị đăng xuất ngay và không đăng nhập được cho đến khi mở khóa.' },
  enable: { title: 'Mở khóa nhân viên?', confirm: 'Mở khóa', description: 'Người này đăng nhập lại được bằng mật khẩu cũ.' },
  'reset-password': { title: 'Đặt lại mật khẩu?', confirm: 'Tạo mật khẩu tạm', description: 'Mật khẩu cũ hết hiệu lực, mọi phiên bị đăng xuất. Mật khẩu tạm hiện một lần để bạn gửi cho người đó.' },
  'sign-out': { title: 'Đăng xuất mọi nơi?', confirm: 'Đăng xuất', description: 'Mọi trình duyệt đang đăng nhập tài khoản này bị đăng xuất.' },
}

/** "Nhân viên" (root only): staff accounts, their permissions, lock/unlock and passwords. */
export function StaffPage() {
  const [staff, setStaff] = useState<StaffMember[] | null>(null)
  const [catalog, setCatalog] = useState<PermissionInfo[]>([])
  const [presets, setPresets] = useState<PermissionPreset[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [permissions, setPermissions] = useState<string[]>([])
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setStaff(await fetchStaff())
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được danh sách nhân viên.'))
    }
  }, [])

  useEffect(() => {
    void load()
    fetchPermissions()
      .then((result) => { setCatalog(result.permissions); setPresets(result.presets) })
      .catch((caught) => setError(readError(caught, 'Không tải được danh sách quyền.')))
  }, [load])

  const labelOf = (code: string) => catalog.find((item) => item.code === code)
  // What was ticked: the stored list also holds what a "manage" includes.
  const ticked = (codes: string[]) => codes.filter((code) => !codes.some((other) => labelOf(other)?.implies?.includes(code)))
  const summary = (member: StaffMember) => member.is_root
    ? 'Toàn quyền'
    : member.permissions.length === 0 ? 'Chưa có quyền' : ticked(member.permissions)
      .map((code) => `${labelOf(code)?.group ?? code}: ${labelOf(code)?.label ?? ''}`).join(' · ')

  const openCreate = () => {
    setEmail('')
    setName('')
    setPermissions([])
    setDialog({ kind: 'create' })
  }

  const openEdit = (member: StaffMember) => {
    setName(member.full_name)
    setPermissions(ticked(member.permissions))
    setDialog({ kind: 'edit', member })
  }

  const submitForm = async () => {
    setBusy(true)
    setError('')
    try {
      if (dialog?.kind === 'create') {
        const result = await createStaff({ email: email.trim(), full_name: name.trim(), permissions })
        setSecret({ email: result.staff.email, password: result.temporary_password })
      } else if (dialog?.kind === 'edit') {
        await updateStaff(dialog.member.id, { full_name: name.trim(), permissions })
        setNotice(`Đã cập nhật ${dialog.member.email}; quyền mới có hiệu lực ngay.`)
      }
      setDialog(null)
      await load()
    } catch (caught) {
      setError(explain(caught, 'Chưa lưu được.'))
    } finally {
      setBusy(false)
    }
  }

  const formOpen = dialog?.kind === 'create' || dialog?.kind === 'edit'
  const action = dialog && dialog.kind !== 'create' && dialog.kind !== 'edit' ? dialog : null

  return (
    <section aria-labelledby="staff-title" className="registry-page console-page">
      <header className="page-heading">
        <div>
          <h2 className="visually-hidden" id="staff-title">Nhân viên</h2>
          <p>
            Chỉ admin gốc thấy trang này. Mỗi nhân viên có tài khoản riêng và chỉ dùng được phần được giao; mọi thay đổi
            được ghi vào nhật ký.
          </p>
        </div>
        <button className="button button--primary" onClick={openCreate} type="button">Thêm nhân viên</button>
      </header>
      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {notice && <p className="notice notice--success" role="status">{notice}</p>}
      {secret && (
        <div className="notice notice--warning console-secret" role="status">
          <p>
            Mật khẩu tạm của <code>{secret.email}</code> (chỉ hiện lần này, người đó phải đổi khi đăng nhập):
          </p>
          <p><code className="console-secret__value">{secret.password}</code><CopyButton value={secret.password} /></p>
          <button className="button button--quiet button--compact" onClick={() => setSecret(null)} type="button">Đã gửi, ẩn đi</button>
        </div>
      )}

      {!staff ? (
        <div className="registry-skeleton" aria-label="Đang tải nhân viên"><span /><span /></div>
      ) : (
        <table className="data-table console-table">
          <thead>
            <tr>
              <th scope="col">Nhân viên</th>
              <th scope="col">Quyền</th>
              <th scope="col">Đăng nhập gần nhất</th>
              <th scope="col">Trạng thái</th>
              <th scope="col"><span className="visually-hidden">Thao tác</span></th>
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => (
              <tr key={member.id}>
                <td><span className="console-cell"><strong>{member.full_name}</strong><code>{member.email}</code></span></td>
                <td className="console-permissions">{summary(member)}</td>
                <td className="cell-muted">{member.last_login_at ? formatRelative(member.last_login_at) : 'Chưa đăng nhập'}</td>
                <td>
                  <span className={`runtime-badge runtime-badge--${member.status === 'active' ? 'online' : 'error'}`}>
                    <i aria-hidden="true" />
                    {member.is_root ? 'Admin gốc' : member.status === 'disabled' ? 'Đã khóa'
                      : member.must_change_password ? 'Chờ đổi mật khẩu' : member.locked ? 'Tạm khóa (sai mật khẩu)' : 'Hoạt động'}
                  </span>
                </td>
                <td>
                  {!member.is_root && (
                    <div className="admin-row-actions">
                      <button className="button button--compact" onClick={() => openEdit(member)} type="button">Sửa quyền</button>
                      <button className="button button--quiet button--compact" onClick={() => setDialog({ kind: 'reset-password', member })} type="button">Đặt lại mật khẩu</button>
                      {member.sessions > 0 && (
                        <button className="button button--quiet button--compact" onClick={() => setDialog({ kind: 'sign-out', member })} type="button">Đăng xuất</button>
                      )}
                      {member.status === 'active'
                        ? <button className="button button--quiet button--compact console-danger" onClick={() => setDialog({ kind: 'disable', member })} type="button">Khóa</button>
                        : <button className="button button--quiet button--compact" onClick={() => setDialog({ kind: 'enable', member })} type="button">Mở khóa</button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {formOpen && (
        <div className="console-overlay" role="dialog" aria-modal="true" aria-labelledby="staff-form-title">
          <form
            className="console-overlay__card console-form"
            onSubmit={(event) => { event.preventDefault(); void submitForm() }}
          >
            <h2 id="staff-form-title">{dialog?.kind === 'create' ? 'Thêm nhân viên' : `Sửa ${dialog?.kind === 'edit' ? dialog.member.email : ''}`}</h2>
            {dialog?.kind === 'create' && (
              <label className="field">
                <span>Email đăng nhập</span>
                <input onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
              </label>
            )}
            <label className="field">
              <span>Họ tên</span>
              <input maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} />
            </label>
            <div className="field">
              <span>Quyền</span>
              <PermissionPicker catalog={catalog} onChange={setPermissions} presets={presets} value={permissions} />
            </div>
            <div className="dialog-actions">
              <button className="button button--quiet" onClick={() => setDialog(null)} type="button">Thôi</button>
              <button className="button button--primary" disabled={busy || !name.trim() || (dialog?.kind === 'create' && !email.trim())} type="submit">
                {busy ? 'Đang lưu…' : dialog?.kind === 'create' ? 'Tạo và lấy mật khẩu tạm' : 'Lưu'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ReasonDialog
        confirmLabel={action ? ACTION_TEXT[action.kind].confirm : ''}
        danger={action ? ACTION_TEXT[action.kind].danger : false}
        description={action ? <p><code>{action.member.email}</code>: {ACTION_TEXT[action.kind].description}</p> : null}
        onCancel={() => setDialog(null)}
        onConfirm={async (reason) => {
          if (!action) return
          const result = await actOnStaff(action.member.id, action.kind, reason)
          setDialog(null)
          if (result.temporary_password) setSecret({ email: action.member.email, password: result.temporary_password })
          else setNotice(`Đã ${ACTION_TEXT[action.kind].confirm.toLowerCase()}: ${action.member.email}.`)
          await load()
        }}
        open={Boolean(action)}
        title={action ? ACTION_TEXT[action.kind].title : ''}
      />
    </section>
  )
}
