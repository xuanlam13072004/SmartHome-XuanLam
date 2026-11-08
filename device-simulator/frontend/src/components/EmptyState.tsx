export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">—</span>
      <strong>{title}</strong>
      <p>{description}</p>
      {actionLabel && onAction && (
        <button className="button button--quiet" onClick={onAction} type="button">{actionLabel}</button>
      )}
    </div>
  )
}
