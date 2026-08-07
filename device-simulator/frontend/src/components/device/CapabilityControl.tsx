import { useEffect, useState } from 'react'
import type { CapabilityProperty } from '../../types'
import { formatValue, humanize, propertyLabel, unitLabel } from './device-utils'

export function CapabilityControl({
  property,
  value,
  disabled,
  onCommit,
}: {
  property: CapabilityProperty
  value: unknown
  disabled: boolean
  onCommit: (value: unknown) => Promise<void>
}) {
  const [draft, setDraft] = useState(toDraft(value))
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [message, setMessage] = useState('')

  useEffect(() => setDraft(toDraft(value)), [value])

  const commit = async (next: unknown) => {
    const previous = draft
    setDraft(toDraft(next))
    setStatus('saving')
    setMessage('')
    try {
      await onCommit(next)
      setStatus('idle')
    } catch (error) {
      setDraft(previous)
      setStatus('error')
      setMessage(error instanceof Error ? error.message : 'Không thể cập nhật giá trị này.')
    }
  }

  const controlDisabled = disabled || status === 'saving'
  const label = propertyLabel(property)

  return (
    <div
      className={`physical-control physical-control--${property.type}`}
      data-state={status}
    >
      <div className="physical-control__heading">
        <div>
          <strong>{label}</strong>
          <small>{property.channel === 'diagnostic' ? 'Tín hiệu chẩn đoán' : 'Trạng thái thiết bị báo cáo'}</small>
        </div>
        <output aria-live="polite">{formatValue(value, property)}</output>
      </div>

      {property.nullable && (
        <label className="nullable-toggle">
          <input
            checked={value === null || value === undefined}
            disabled={controlDisabled}
            onChange={(event) => void commit(event.target.checked ? null : defaultValue(property))}
            type="checkbox"
          />
          Không có tín hiệu
        </label>
      )}

      {value !== null && value !== undefined && renderControl({
        property,
        draft,
        disabled: controlDisabled,
        setDraft,
        commit,
      })}

      <p className="control-feedback" role={status === 'error' ? 'alert' : 'status'}>
        {status === 'saving' ? 'Đang cập nhật và gửi telemetry…' : message}
      </p>
    </div>
  )
}

function renderControl({
  property,
  draft,
  disabled,
  setDraft,
  commit,
}: {
  property: CapabilityProperty
  draft: string
  disabled: boolean
  setDraft: (value: string) => void
  commit: (value: unknown) => Promise<void>
}) {
  if (property.type === 'boolean') {
    const checked = draft === 'true'
    return (
      <label className="switch-control">
        <input
          checked={checked}
          disabled={disabled}
          onChange={(event) => void commit(event.target.checked)}
          role="switch"
          type="checkbox"
        />
        <span aria-hidden="true" className="switch-control__track"><span /></span>
        <span>{checked ? 'Bật' : 'Tắt'}</span>
      </label>
    )
  }

  if ((property.type === 'number' || property.type === 'integer') && draft !== '') {
    const step = property.type === 'integer'
      ? 1
      : 1 / (10 ** (property.precision ?? 1))
    const min = property.minimum
    const max = property.maximum
    const parsed = Number(draft)
    const canSlide = Number.isFinite(min) && Number.isFinite(max)
    const commitNumber = () => {
      if (!Number.isFinite(parsed)) return
      void commit(property.type === 'integer' ? Math.round(parsed) : parsed)
    }
    return (
      <div className="number-control">
        {canSlide && (
          <input
            aria-label={`Điều chỉnh ${propertyLabel(property)}`}
            disabled={disabled}
            max={max}
            min={min}
            onChange={(event) => setDraft(event.target.value)}
            onKeyUp={(event) => {
              if (event.key.startsWith('Arrow')) commitNumber()
            }}
            onPointerUp={commitNumber}
            step={step}
            type="range"
            value={draft}
          />
        )}
        <label className="number-input">
          <span>Giá trị mô phỏng</span>
          <span>
            <input
              aria-invalid={!Number.isFinite(parsed)}
              disabled={disabled}
              max={max}
              min={min}
              onBlur={commitNumber}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitNumber()
                }
              }}
              step={step}
              type="number"
              value={draft}
            />
            {property.unit && <em>{unitLabel(property.unit)}</em>}
          </span>
        </label>
      </div>
    )
  }

  if (property.type === 'string' && property.enum?.length) {
    if (property.enum.length <= 5) {
      return (
        <div aria-label={propertyLabel(property)} className="segment-control" role="group">
          {property.enum.map((option) => (
            <button
              aria-pressed={draft === String(option)}
              className="segment-control__option"
              disabled={disabled}
              key={String(option)}
              onClick={() => void commit(option)}
              type="button"
            >
              {humanize(String(option))}
            </button>
          ))}
        </div>
      )
    }
    return (
      <label className="select-control">
        <span>Chọn trạng thái</span>
        <select
          disabled={disabled}
          onChange={(event) => void commit(event.target.value)}
          value={draft}
        >
          {property.enum.map((option) => (
            <option key={String(option)} value={String(option)}>{humanize(String(option))}</option>
          ))}
        </select>
      </label>
    )
  }

  if (property.type === 'string') {
    return (
      <label className="text-control">
        <span>Giá trị mô phỏng</span>
        <input
          disabled={disabled}
          maxLength={property.max_length}
          onBlur={() => void commit(draft)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void commit(draft)
            }
          }}
          value={draft}
        />
      </label>
    )
  }

  return (
    <p className="control-unavailable">
      Kiểu dữ liệu `{property.type}` chỉ được hiển thị, chưa hỗ trợ chỉnh trực tiếp.
    </p>
  )
}

const toDraft = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const defaultValue = (property: CapabilityProperty): unknown => {
  if (property.default !== undefined && property.default !== null) return property.default
  if (property.type === 'boolean') return false
  if (property.type === 'number' || property.type === 'integer') return property.minimum ?? 0
  if (property.type === 'string') return property.enum?.[0] ?? ''
  if (property.type === 'array') return []
  return null
}
