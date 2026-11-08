import { formatNumber } from '../format'

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number
  pageSize: number
  total: number
  onPage: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <nav aria-label="Phân trang" className="pager">
      <span>{formatNumber(from)}–{formatNumber(to)} / {formatNumber(total)}</span>
      <button className="button button--quiet button--compact" disabled={page <= 1} onClick={() => onPage(page - 1)} type="button">Trước</button>
      <span aria-current="page">Trang {formatNumber(page)} / {formatNumber(pages)}</span>
      <button className="button button--quiet button--compact" disabled={page >= pages} onClick={() => onPage(page + 1)} type="button">Sau</button>
    </nav>
  )
}
