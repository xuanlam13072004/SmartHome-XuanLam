import { useEffect, useState } from 'react'
import { fetchAdminAssistant } from '../../api'
import type { AdminAssistant, AssistantOutcome } from '../../types'
import { formatDecimal, formatNumber, readError } from '../format'
import { DailyColumns } from './AdminCharts'
import { accountStatusLabel, outcomeLabel } from './adminFormat'

const OUTCOMES: AssistantOutcome[] = ['chat', 'action', 'clarify', 'confirm', 'refused', 'error']

/** "Trợ lý": how much the assistant is used and how it answers. Counts only; no message is read. */
export function AssistantTab({ onOpenAccount }: { onOpenAccount: (account: { id: string; email: string }) => void }) {
  const [data, setData] = useState<AdminAssistant | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchAdminAssistant()
      .then((result) => { setData(result); setError('') })
      .catch((caught) => setError(readError(caught, 'Không tải được số liệu trợ lý.')))
  }, [])

  if (!data) {
    return error
      ? <p className="notice notice--error" role="alert">{error}</p>
      : <div className="registry-skeleton" aria-label="Đang tải số liệu trợ lý"><span /><span /></div>
  }

  const tokens = data.by_plan.reduce((sum, plan) => sum + plan.tokens, 0)
  const requests = data.by_plan.reduce((sum, plan) => sum + plan.requests, 0)
  const turnsPerDay = data.daily.days.map((_, index) => OUTCOMES.reduce((sum, outcome) => sum + (data.daily.outcomes[outcome]?.[index] ?? 0), 0))
  const outcomeTotals = OUTCOMES.map((outcome) => ({
    outcome,
    count: (data.daily.outcomes[outcome] ?? []).reduce((sum, value) => sum + value, 0),
  }))
  const turns = outcomeTotals.reduce((sum, item) => sum + item.count, 0)
  const failed = outcomeTotals.filter((item) => item.outcome === 'error').reduce((sum, item) => sum + item.count, 0)

  return (
    <div className="admin-assistant">
      <dl className="live-grid">
        <div className="live-metric"><dt>Token tháng này</dt><dd><strong>{formatNumber(tokens)}</strong></dd><dd className="live-metric__note">{formatNumber(requests)} lượt hỏi</dd></div>
        <div className="live-metric"><dt>Hôm nay / trần hệ thống</dt><dd><strong>{formatNumber(data.tokens_today)}</strong></dd><dd className="live-metric__note">Trần {formatNumber(data.daily_cap)} token/ngày bảo vệ khóa Gemini</dd></div>
        <div className={`live-metric${failed > 0 ? ' live-metric--error' : ''}`}><dt>Lỗi 30 ngày</dt><dd><strong>{formatNumber(failed)}</strong></dd><dd className="live-metric__note">{turns ? `${formatDecimal((failed / turns) * 100, 1)}% số lượt` : 'Chưa có lượt nào'}</dd></div>
        <div className="live-metric"><dt>Giọng nói / văn bản</dt><dd><strong>{formatNumber(data.channels.voice ?? 0)} / {formatNumber(data.channels.text ?? 0)}</strong></dd><dd className="live-metric__note">Lượt trong 30 ngày</dd></div>
      </dl>

      <div className="admin-chart-grid">
        <DailyColumns days={data.daily.days} format={formatNumber} title="Lượt hỏi mỗi ngày" unit="lượt" values={turnsPerDay} />
        <DailyColumns days={data.daily.days} format={formatNumber} title="Token mỗi ngày" unit="token" values={data.daily.tokens} />
      </div>

      <div className="admin-two-columns">
        <section>
          <h3 className="admin-subtitle">Kết quả trả lời (30 ngày)</h3>
          <table className="data-table">
            <thead><tr><th scope="col">Kết quả</th><th scope="col">Lượt</th><th scope="col">Tỉ lệ</th></tr></thead>
            <tbody>
              {outcomeTotals.map((item) => (
                <tr key={item.outcome}>
                  <td>{outcomeLabel[item.outcome]}</td>
                  <td>{formatNumber(item.count)}</td>
                  <td className="cell-muted">{turns ? `${formatDecimal((item.count / turns) * 100, item.count / turns < 0.1 ? 1 : 0)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h3 className="admin-subtitle">Theo gói (tháng này)</h3>
          <table className="data-table">
            <thead><tr><th scope="col">Gói</th><th scope="col">Người dùng</th><th scope="col">Token</th><th scope="col">TB/người</th></tr></thead>
            <tbody>
              {data.by_plan.map((plan) => (
                <tr key={plan.code}>
                  <td>{plan.name}<small className="cell-muted"> · {formatNumber(plan.monthly_tokens)}/tháng</small></td>
                  <td>{formatNumber(plan.accounts)}</td>
                  <td>{formatNumber(plan.tokens)}</td>
                  <td className="cell-muted">{plan.accounts ? formatNumber(plan.tokens / plan.accounts) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section>
        <h3 className="admin-subtitle">Dùng nhiều nhất tháng này</h3>
        {data.top.length === 0 ? <p className="empty-inline">Chưa ai dùng trợ lý tháng này.</p> : (
          <table className="data-table">
            <thead><tr><th scope="col">Tài khoản</th><th scope="col">Gói</th><th scope="col">Token đã dùng</th><th scope="col">Lượt</th></tr></thead>
            <tbody>
              {data.top.map((row) => (
                <tr key={row.account_id}>
                  <td>
                    <button className="row-link" onClick={() => onOpenAccount({ id: row.account_id, email: row.email })} type="button">
                      <span><strong>{row.full_name}</strong><code>{row.email}</code></span>
                    </button>
                    {row.status !== 'active' && <small className="cell-error"> {accountStatusLabel[row.status]}</small>}
                  </td>
                  <td>{row.plan.name}</td>
                  <td>{formatNumber(row.tokens)} <small className="cell-muted">({Math.round((row.tokens / Math.max(1, row.monthly_tokens)) * 100)}% hạn mức)</small></td>
                  <td>{formatNumber(row.requests)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="admin-footnote">Chỉ đếm số lượt và token; trang này không đọc nội dung trò chuyện của khách.</p>
    </div>
  )
}
