import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { encodeQr, qrPath, type PairingLabelContent } from '../../factory/qr'

/** QR symbol drawn as one crisp SVG path. */
export function QrSymbol({ value, title }: { value: string; title: string }) {
  const { size, path } = useMemo(() => {
    const matrix = encodeQr(value)
    return { size: matrix.size + 8, path: qrPath(matrix) }
  }, [value])
  return (
    <svg className="qr-symbol" role="img" shapeRendering="crispEdges" viewBox={`0 0 ${size} ${size}`}>
      <title>{title}</title>
      <rect fill="#fff" height={size} width={size} />
      <path d={path} fill="#1d1714" />
    </svg>
  )
}

/** The sticker attached to a device: brand, product, QR, serial and MAC. */
export function PairingLabel({
  label,
  size = 'regular',
}: {
  label: PairingLabelContent
  size?: 'regular' | 'large'
}) {
  return (
    <figure className={`pairing-label pairing-label--${size}`}>
      <figcaption>
        <small>SmartHome XuanLam</small>
        <strong>{label.productName}</strong>
      </figcaption>
      <QrSymbol title={`Mã QR ghép nối ${label.serial || label.mac}`} value={label.payload} />
      <div className="pairing-label__identity">
        <code>{label.serial || label.mac}</code>
        {label.serial && <small>MAC {label.mac}</small>}
      </div>
    </figure>
  )
}

/**
 * Print sheet rendered outside the app shell. Printing starts once the labels
 * are in the document and the sheet closes itself after the print dialog.
 */
export function PrintLabelSheet({
  labels,
  onDone,
}: {
  labels: PairingLabelContent[]
  onDone: () => void
}) {
  const [ready, setReady] = useState(false)
  const doneRef = useRef(onDone)
  useEffect(() => {
    doneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    document.body.classList.add('is-printing-labels')
    const finish = () => doneRef.current()
    window.addEventListener('afterprint', finish)
    const frame = window.requestAnimationFrame(() => setReady(true))
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('afterprint', finish)
      document.body.classList.remove('is-printing-labels')
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    const timer = window.setTimeout(() => window.print(), 50)
    return () => window.clearTimeout(timer)
  }, [ready])

  return createPortal(
    <div aria-hidden="true" className="print-sheet">
      {labels.map((label) => <PairingLabel key={label.mac} label={label} />)}
    </div>,
    document.body,
  )
}
