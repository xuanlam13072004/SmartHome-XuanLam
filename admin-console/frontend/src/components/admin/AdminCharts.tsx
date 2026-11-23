import { useState } from 'react'
import { formatCompact, formatDay } from './adminFormat'

/** A round top for the axis (1, 2, 4, 5 or 10 × 10ⁿ) at or above [max]. */
const niceCeil = (max: number): number => {
  if (max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const factor of [1, 2, 4, 5, 10]) {
    if (factor * magnitude >= max) return factor * magnitude
  }
  return 10 * magnitude
}

const WIDTH = 640
const HEIGHT = 180
const LEFT = 48
const TOP = 10
const BOTTOM = 24

/**
 * One value per day as thin columns from a single baseline (one hue, hairline
 * grid). Hovering or focusing a day shows its value above the chart; the
 * numbers are also in the table under it.
 */
export function DailyColumns({
  title,
  days,
  values,
  format,
  unit,
}: {
  title: string
  days: string[]
  values: number[]
  format: (value: number) => string
  /** "tài khoản", "token": said after the total. */
  unit?: string
}) {
  const [active, setActive] = useState<number | null>(null)
  const top = niceCeil(Math.max(0, ...values))
  const plotHeight = HEIGHT - TOP - BOTTOM
  const y = (value: number) => TOP + (1 - value / top) * plotHeight
  const slot = (WIDTH - LEFT) / Math.max(1, values.length)
  // Thin columns with air between them (never wider than 24px).
  const barWidth = Math.max(2, Math.min(24, slot * 0.6))
  const ticks = [0, top / 2, top].filter((tick, index) => index !== 1 || Number.isInteger(tick))
  const total = values.reduce((sum, value) => sum + value, 0)
  const busiest = values.indexOf(Math.max(...values))
  const readout = active === null
    ? total === 0
      ? 'Chưa có số liệu trong 30 ngày.'
      : `30 ngày: ${format(total)}${unit ? ` ${unit}` : ''} · cao nhất ${format(values[busiest])} ngày ${formatDay(days[busiest])}`
    : `Ngày ${formatDay(days[active])}: ${format(values[active])}${unit ? ` ${unit}` : ''}`

  return (
    <figure className="admin-chart">
      <figcaption>
        <strong>{title}</strong>
        <span aria-live="polite">{readout}</span>
      </figcaption>
      <svg
        aria-label={`${title}: ${readout}`}
        className="admin-chart__plot"
        onMouseLeave={() => setActive(null)}
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="admin-chart__grid" x1={LEFT} x2={WIDTH} y1={y(tick)} y2={y(tick)} />
            <text className="admin-chart__tick" textAnchor="end" x={LEFT - 8} y={y(tick) + 4}>{formatCompact(tick)}</text>
          </g>
        ))}
        {values.map((value, index) => {
          const x = LEFT + slot * index + (slot - barWidth) / 2
          const height = value > 0 ? Math.max(2, (value / top) * plotHeight) : 0
          const radius = Math.min(4, barWidth / 2, height)
          const base = TOP + plotHeight
          return (
            <g key={days[index]}>
              {height > 0 && (
                <path
                  className={`admin-chart__bar${active !== null && active !== index ? ' admin-chart__bar--faded' : ''}`}
                  d={`M${x},${base} V${base - height + radius} Q${x},${base - height} ${x + radius},${base - height}
                      H${x + barWidth - radius} Q${x + barWidth},${base - height} ${x + barWidth},${base - height + radius} V${base} Z`}
                />
              )}
              <rect
                className="admin-chart__hit"
                height={plotHeight}
                onFocus={() => setActive(index)}
                onMouseEnter={() => setActive(index)}
                tabIndex={-1}
                width={slot}
                x={LEFT + slot * index}
                y={TOP}
              >
                <title>{`${formatDay(days[index])}: ${format(value)}`}</title>
              </rect>
              {(values.length - 1 - index) % 7 === 0 && (
                <text className="admin-chart__tick" textAnchor="middle" x={LEFT + slot * (index + 0.5)} y={HEIGHT - 6}>
                  {formatDay(days[index])}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <details className="admin-chart__table">
        <summary>Bảng số liệu</summary>
        <table className="data-table">
          <thead><tr><th scope="col">Ngày</th><th scope="col">{title}</th></tr></thead>
          <tbody>
            {days.map((day, index) => (
              <tr key={day}><td>{formatDay(day)}</td><td>{format(values[index])}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}

/** Horizontal bars for a few named groups (devices by product, plans in use). */
export function BarList({
  title,
  items,
  format,
}: {
  title: string
  items: Array<{ key: string; label: string; value: number }>
  format: (value: number) => string
}) {
  const max = Math.max(1, ...items.map((item) => item.value))
  return (
    <figure className="admin-bars">
      <figcaption><strong>{title}</strong></figcaption>
      {items.length === 0 ? <p className="empty-inline">Chưa có.</p> : (
        <ul>
          {items.map((item) => (
            <li key={item.key}>
              <span className="admin-bars__label">{item.label}</span>
              <span aria-hidden="true" className="admin-bars__track">
                <span className="admin-bars__fill" style={{ width: `${(item.value / max) * 100}%` }} />
              </span>
              <span className="admin-bars__value">{format(item.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  )
}
