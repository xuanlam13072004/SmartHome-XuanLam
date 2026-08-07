import { useEffect, useState } from 'react'
import type { CapabilityInstance, DeviceStatePatch, SimulatedDevice } from '../../types'
import { humanize, readPropertyValue } from './device-utils'

const LCD_ROWS = 4
const LCD_COLUMNS = 20

export function LcdSimulator({
  instance,
  state,
  disabled,
  onPatch,
}: {
  instance: CapabilityInstance
  state: SimulatedDevice['state_snapshot']
  disabled: boolean
  onPatch: (patch: DeviceStatePatch) => Promise<void>
}) {
  const linesProperty = instance.properties.find((property) => property.id === 'displayed_lines')
  const sourceProperty = instance.properties.find((property) => property.id === 'display_source')
  const currentLines = normalizeLines(linesProperty
    ? readPropertyValue(state, instance.instance_id, linesProperty)
    : [])
  const currentSource = sourceProperty
    ? String(readPropertyValue(state, instance.instance_id, sourceProperty) || 'firmware')
    : 'firmware'
  const currentLinesJson = JSON.stringify(currentLines)
  const [lines, setLines] = useState(currentLines)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => setLines(JSON.parse(currentLinesJson) as string[]), [currentLinesJson])

  const apply = async (source: 'custom' | 'firmware') => {
    setSaving(true)
    setError('')
    const reported: Record<string, unknown> = {
      display_source: source,
      ...(source === 'custom' ? { displayed_lines: normalizeLines(lines) } : {}),
    }
    const patch: DeviceStatePatch = {
      instances: {
        [instance.instance_id]: { reported },
      },
    }
    try {
      await onPatch(patch)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không thể cập nhật màn hình LCD.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="lcd-simulator" aria-labelledby={`lcd-${instance.instance_id}`}>
      <header className="work-panel__heading">
        <div>
          <h3 id={`lcd-${instance.instance_id}`}>{instance.presentation?.display_name || 'LCD 4×20'}</h3>
          <p>Màn hình mô phỏng đúng 4 dòng, tối đa 20 ký tự mỗi dòng.</p>
        </div>
        <span className="source-badge">Nguồn: {humanize(currentSource)}</span>
      </header>

      <div aria-label="Màn hình LCD đang hiển thị" className="lcd-screen" role="img">
        {currentLines.map((line, index) => (
          <div className="lcd-screen__line" key={index}>
            {padLine(line).split('').map((character, column) => (
              <span key={column}>{character === ' ' ? '\u00a0' : character}</span>
            ))}
          </div>
        ))}
      </div>

      <div className="lcd-editor">
        {lines.map((line, index) => (
          <label key={index}>
            <span>Dòng {index + 1}</span>
            <span className="lcd-editor__field">
              <input
                disabled={disabled || saving}
                maxLength={LCD_COLUMNS}
                onChange={(event) => {
                  const next = [...lines]
                  next[index] = event.target.value
                  setLines(next)
                }}
                value={line}
              />
              <small>{line.length}/{LCD_COLUMNS}</small>
            </span>
          </label>
        ))}
      </div>

      <div className="lcd-actions">
        <button
          className="button button--primary"
          disabled={disabled || saving}
          onClick={() => void apply('custom')}
          type="button"
        >
          {saving ? 'Đang gửi…' : 'Hiển thị nội dung'}
        </button>
        <button
          className="button button--quiet"
          disabled={disabled || saving || currentSource === 'firmware'}
          onClick={() => void apply('firmware')}
          type="button"
        >
          Trả về firmware
        </button>
      </div>
      <p className="control-feedback" role={error ? 'alert' : 'status'}>{error}</p>
    </section>
  )
}

const normalizeLines = (value: unknown): string[] => {
  const source = Array.isArray(value) ? value.map(String) : []
  return Array.from({ length: LCD_ROWS }, (_, index) => (source[index] || '').slice(0, LCD_COLUMNS))
}

const padLine = (line: string): string => line.slice(0, LCD_COLUMNS).padEnd(LCD_COLUMNS, ' ')
