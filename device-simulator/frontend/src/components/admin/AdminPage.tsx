import { useEffect, useState } from 'react'
import { ApiError, fetchAdminPlans } from '../../api'
import { EmptyState } from '../EmptyState'
import { AccountsTab } from './AccountsTab'
import { AssistantTab } from './AssistantTab'
import { AuditTab } from './AuditTab'
import { OverviewTab } from './OverviewTab'
import { PaymentsTab } from './PaymentsTab'

type Tab = 'overview' | 'accounts' | 'payments' | 'assistant' | 'audit'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Tổng quan' },
  { id: 'accounts', label: 'Tài khoản' },
  { id: 'payments', label: 'Thanh toán' },
  { id: 'assistant', label: 'Trợ lý' },
  { id: 'audit', label: 'Nhật ký' },
]

/** Why the page cannot reach the Gateway's administration API, in words the operator can act on. */
const setupProblem = (caught: unknown): string | null => {
  if (!(caught instanceof ApiError)) return null
  switch (caught.code) {
    case 'ADMIN_NOT_CONFIGURED':
      return 'Simulator chưa có ADMIN_API_KEY. Thêm vào device-simulator/.env.docker rồi khởi động lại Simulator.'
    case 'NOT_FOUND':
      return 'API Gateway chưa bật quản trị: đặt ADMIN_API_KEY trong file .env gốc rồi chạy lại docker compose up -d api-gateway.'
    case 'ADMIN_KEY_INVALID':
      return 'ADMIN_API_KEY của Simulator và API Gateway không giống nhau.'
    case 'ADMIN_INTERNAL_ONLY':
      return 'Simulator đang gọi API Gateway qua Cloudflare Tunnel. Đặt API_GATEWAY_URL=http://api-gateway:3000 cho Simulator.'
    case 'ADMIN_GATEWAY_UNREACHABLE':
      return 'Simulator không kết nối được API Gateway.'
    default:
      return null
  }
}

/**
 * "Quản trị": the company's page (docs/architecture/admin.md). Everything goes
 * through the API Gateway's /admin API with the server-held key; every change
 * needs a reason and lands in the administration log.
 */
export function AdminPage({ enabled }: { enabled: boolean }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [problem, setProblem] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [focus, setFocus] = useState<{ id: string; email: string; at: number } | null>(null)

  useEffect(() => {
    if (!enabled) return
    fetchAdminPlans()
      .then(() => setProblem(null))
      .catch((caught) => setProblem(setupProblem(caught)))
      .finally(() => setChecked(true))
  }, [enabled])

  if (!enabled) {
    return (
      <EmptyState
        actionLabel="Mở Hệ thống"
        description="Nhập admin token của Simulator trước khi vào trang quản trị."
        onAction={() => window.dispatchEvent(new CustomEvent('simulator:navigate-system'))}
        title="Simulator chưa sẵn sàng."
      />
    )
  }

  const openAccount = (account: { id: string; email: string }) => {
    setFocus({ ...account, at: Date.now() })
    setTab('accounts')
  }

  return (
    <section aria-labelledby="admin-title" className="registry-page admin-page">
      <header className="page-heading page-heading--tabs">
        <div>
          <h2 id="admin-title">Số liệu và hỗ trợ khách hàng</h2>
          <p>
            Dành cho công ty: số liệu hệ thống và hỗ trợ khách hàng. Mọi thay đổi cần ghi lý do và được lưu vào nhật ký;
            trang này không đọc trò chuyện, camera hay lịch sử ra vào của khách.
          </p>
        </div>
        <nav className="data-tabs" role="tablist" aria-label="Mục quản trị">
          {TABS.map((item) => (
            <button aria-selected={tab === item.id} key={item.id} onClick={() => setTab(item.id)} role="tab" type="button">
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {!checked ? (
        <div className="registry-skeleton" aria-label="Đang kiểm tra kết nối quản trị"><span /><span /></div>
      ) : problem ? (
        <EmptyState description={problem} title="Chưa kết nối được trang quản trị." />
      ) : (
        <>
          {tab === 'overview' && <OverviewTab onOpenPayments={() => setTab('payments')} />}
          {tab === 'accounts' && <AccountsTab focus={focus} />}
          {tab === 'payments' && <PaymentsTab onOpenAccount={openAccount} />}
          {tab === 'assistant' && <AssistantTab onOpenAccount={openAccount} />}
          {tab === 'audit' && <AuditTab onOpenAccount={openAccount} />}
        </>
      )}
    </section>
  )
}
