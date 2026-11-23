import { useEffect, useState } from 'react'
import { fetchDevicePairing } from '../../api'
import { downloadBlob, labelFilename, renderLabelPng, type PairingLabelContent } from '../../factory/qr'
import type { DevicePairing } from '../../types'
import { CopyButton } from '../CopyButton'
import { Icon } from '../Icon'
import { PairingLabel, PrintLabelSheet } from './PairingLabel'

/** "Tem QR" tab of the device workbench: the label every simulated device carries. */
export function DevicePairingPanel({
  mac,
  productName,
  provisioningState,
}: {
  mac: string
  productName: string
  /** Re-reads ownership when the registry reports a claim or unpair. */
  provisioningState: string
}) {
  const [pairing, setPairing] = useState<DevicePairing | null>(null)
  const [error, setError] = useState('')
  const [printing, setPrinting] = useState(false)

  useEffect(() => {
    let active = true
    fetchDevicePairing(mac)
      .then((result) => {
        if (!active) return
        setPairing(result)
        setError('')
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Không đọc được tem QR của thiết bị.')
      })
    return () => {
      active = false
    }
  }, [mac, provisioningState])

  if (error) return <p className="notice notice--error" role="alert">Không đọc được tem QR. {error}</p>
  if (!pairing) return <div className="registry-skeleton" aria-label="Đang tải tem QR"><span /><span /></div>

  const label: PairingLabelContent = {
    payload: pairing.payload,
    productName,
    serial: pairing.serial_number,
    mac: pairing.mac,
  }
  const download = async () => {
    try {
      downloadBlob(await renderLabelPng(label), labelFilename(label))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tạo được ảnh tem.')
    }
  }

  return (
    <div className="pairing-panel">
      <PairingLabel label={label} size="large" />
      <div className="pairing-panel__body">
        <header className="work-panel__heading">
          <div>
            <h3>Tem ghép nối</h3>
            <p>Tem chứa MAC và mã bí mật nhà máy. Ai có tem thì thêm được thiết bị vào tài khoản của mình khi thiết bị chưa có chủ.</p>
          </div>
        </header>

        <p className={`notice ${pairing.claimable ? 'notice--success' : 'notice--warning'}`}>
          {pairing.claimable
            ? 'Thiết bị chưa có chủ: quét tem trong app SmartHome để ghép nối.'
            : pairing.owner
              ? `Đang thuộc “${pairing.owner.device_name}” của ${pairing.owner.account_email || 'một tài khoản'}. App sẽ báo thiết bị đã có chủ cho tới khi chủ hiện tại gỡ thiết bị.`
              : 'Thiết bị đang có chủ. App sẽ báo thiết bị đã có chủ cho tới khi chủ hiện tại gỡ thiết bị.'}
        </p>

        {pairing.origin === 'run' && (
          <p className="field-help">
            Thiết bị này được sinh cùng tài khoản ảo của một lần chạy. Nếu tài khoản ảo gỡ nó, thiết bị tắt theo lần chạy; dùng Xưởng sản xuất để có thiết bị trắng luôn chờ ghép nối.
          </p>
        )}

        <ol className="pairing-steps">
          <li>Trong app SmartHome, mở <strong>Thêm thiết bị</strong>.</li>
          <li>Quét tem này bằng camera, hoặc trên web chọn <strong>Dán mã ghép nối</strong> và dán mã đã sao chép.</li>
          <li>Đặt tên thiết bị rồi xác nhận. Thiết bị nhận chủ mới qua MQTT và bắt đầu gửi dữ liệu.</li>
        </ol>

        <div className="technical-actions">
          <CopyButton label="Sao chép mã ghép nối" value={pairing.payload} />
          <button className="button button--quiet button--compact" onClick={() => void download()} type="button">
            <Icon name="download" size={15} />Tải tem PNG
          </button>
          <button className="button button--quiet button--compact" onClick={() => setPrinting(true)} type="button">
            <Icon name="print" size={15} />In tem
          </button>
        </div>
        <details className="raw-disclosure">
          <summary>Nội dung mã QR</summary>
          <pre>{pairing.payload}</pre>
        </details>
      </div>
      {printing && <PrintLabelSheet labels={[label]} onDone={() => setPrinting(false)} />}
    </div>
  )
}
