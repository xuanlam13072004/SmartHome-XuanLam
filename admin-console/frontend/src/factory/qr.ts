import qrcode from 'qrcode-generator'

export interface QrMatrix {
  size: number
  isDark: (row: number, column: number) => boolean
}

/**
 * Encodes the pairing payload. Level M survives a scuffed or slightly blurred
 * label while keeping the ~110 byte payload at version 7 (45 x 45 modules).
 */
export const encodeQr = (text: string): QrMatrix => {
  const code = qrcode(0, 'M')
  code.addData(text, 'Byte')
  code.make()
  return { size: code.getModuleCount(), isDark: (row, column) => code.isDark(row, column) }
}

/** One SVG path for all dark modules; `quiet` is the blank margin in modules. */
export const qrPath = (matrix: QrMatrix, quiet = 4): string => {
  const parts: string[] = []
  for (let row = 0; row < matrix.size; row += 1) {
    let column = 0
    while (column < matrix.size) {
      if (!matrix.isDark(row, column)) {
        column += 1
        continue
      }
      const start = column
      while (column < matrix.size && matrix.isDark(row, column)) column += 1
      parts.push(`M${start + quiet} ${row + quiet}h${column - start}v1h${start - column}z`)
    }
  }
  return parts.join('')
}

export interface PairingLabelContent {
  payload: string
  productName: string
  serial: string | null
  mac: string
}

/** Renders the printable label to PNG (about 50 x 64 mm at 300 dpi). */
export const renderLabelPng = async (label: PairingLabelContent): Promise<Blob> => {
  const width = 600
  const height = 760
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Trình duyệt không hỗ trợ vẽ canvas.')

  const ink = '#1d1714'
  const muted = '#6b5e57'
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.strokeStyle = '#d8ccc4'
  context.lineWidth = 2
  context.strokeRect(1, 1, width - 2, height - 2)

  context.fillStyle = muted
  context.font = '600 22px "Geist", "Segoe UI", sans-serif'
  context.textBaseline = 'alphabetic'
  context.fillText('SMARTHOME XUANLAM', 40, 62)
  context.fillStyle = ink
  context.font = '700 34px "Geist", "Segoe UI", sans-serif'
  context.fillText(fitText(context, label.productName, width - 80), 40, 108)

  const matrix = encodeQr(label.payload)
  const quiet = 2
  const area = 440
  const cell = Math.floor(area / (matrix.size + quiet * 2))
  const qrSize = cell * (matrix.size + quiet * 2)
  const left = Math.round((width - qrSize) / 2)
  const top = 136
  context.fillStyle = ink
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (matrix.isDark(row, column)) {
        context.fillRect(left + (column + quiet) * cell, top + (row + quiet) * cell, cell, cell)
      }
    }
  }

  const textTop = top + qrSize + 48
  context.textAlign = 'center'
  context.fillStyle = ink
  context.font = '600 30px "Geist Mono", "Cascadia Mono", monospace'
  context.fillText(label.serial || label.mac, width / 2, textTop)
  context.fillStyle = muted
  context.font = '500 22px "Geist Mono", "Cascadia Mono", monospace'
  context.fillText(`MAC ${label.mac}`, width / 2, textTop + 38)
  context.font = '400 21px "Geist", "Segoe UI", sans-serif'
  context.fillText('Quét bằng app SmartHome để thêm thiết bị', width / 2, textTop + 82)

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Không tạo được ảnh tem.'))), 'image/png')
  })
}

const fitText = (context: CanvasRenderingContext2D, text: string, maxWidth: number): string => {
  if (context.measureText(text).width <= maxWidth) return text
  let shortened = text
  while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1)
  }
  return `${shortened}…`
}

export const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const labelFilename = (label: { serial: string | null; mac: string }): string =>
  `tem-${(label.serial || label.mac).replaceAll(':', '')}.png`
