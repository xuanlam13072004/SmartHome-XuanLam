import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  fetchCatalog,
  fetchFactoryBatches,
  fetchFactoryDevices,
  manufactureBatch,
  scrapFactoryDevice,
  scrapUnclaimedBatch,
  setFactoryPower,
  subscribeStream,
} from '../../api'
import { downloadBlob, labelFilename, renderLabelPng, type PairingLabelContent } from '../../factory/qr'
import type { CatalogProduct, FactoryBatch, FactoryDevice } from '../../types'
import { CopyButton } from '../CopyButton'
import { EmptyState } from '../EmptyState'
import { Icon } from '../Icon'
import { PairingLabel, PrintLabelSheet } from './PairingLabel'

type StockFilter = 'all' | 'in_stock' | 'claimed'
type PendingScrap = { kind: 'device'; device: FactoryDevice } | { kind: 'lot'; batch: FactoryBatch }

export function FactoryPage({
  enabled,
  onSelectDevice,
}: {
  enabled: boolean
  onSelectDevice: (mac: string) => void
}) {
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [batches, setBatches] = useState<FactoryBatch[]>([])
  const [maxBatchSize, setMaxBatchSize] = useState(20)
  const [devices, setDevices] = useState<FactoryDevice[]>([])
  const [payloads, setPayloads] = useState<Record<string, string>>({})
  const [lot, setLot] = useState('')
  const [stock, setStock] = useState<StockFilter>('all')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [printing, setPrinting] = useState<PairingLabelContent[] | null>(null)
  const [pendingScrap, setPendingScrap] = useState<PendingScrap | null>(null)
  const payloadsRef = useRef(payloads)
  useEffect(() => {
    payloadsRef.current = payloads
  }, [payloads])
  const factoryMacs = useRef(new Set<string>())
  useEffect(() => {
    factoryMacs.current = new Set(devices.map((device) => device.mac))
  }, [devices])

  const rememberPayloads = useCallback((items: FactoryDevice[]) => {
    const found = Object.fromEntries(items.flatMap((item) => (
      item.pairing_payload ? [[item.mac, item.pairing_payload]] : []
    )))
    if (Object.keys(found).length === 0) return
    payloadsRef.current = { ...payloadsRef.current, ...found }
    setPayloads((current) => ({ ...current, ...found }))
  }, [])

  const load = useCallback(async () => {
    if (!enabled) {
      setLoading(false)
      return
    }
    try {
      const [batchResult, deviceItems] = await Promise.all([
        fetchFactoryBatches(),
        fetchFactoryDevices(),
      ])
      setBatches(batchResult.batches)
      setMaxBatchSize(batchResult.max_batch_size)
      setDevices(deviceItems)
      // Labels never change; only devices without a cached label are fetched with secrets.
      if (deviceItems.some((item) => !payloadsRef.current[item.mac])) {
        rememberPayloads(await fetchFactoryDevices({ includePairing: true }))
      }
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được dữ liệu xưởng sản xuất.'))
    } finally {
      setLoading(false)
    }
  }, [enabled, rememberPayloads])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    void fetchCatalog().then(setProducts).catch(() => undefined)
    void load()
    // Claims and unpairs arrive as simulator events; bursts collapse into one reload.
    let pending: number | undefined
    const stop = subscribeStream((event) => {
      const relevant = event.type.startsWith('factory.')
        || event.run_id === 'factory'
        || (event.mac !== undefined && factoryMacs.current.has(event.mac))
      if (!relevant) return
      window.clearTimeout(pending)
      pending = window.setTimeout(() => void load(), 400)
    })
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 8000)
    return () => {
      stop()
      window.clearTimeout(pending)
      window.clearInterval(timer)
    }
  }, [enabled, load])

  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])
  const productName = (productId: string) => productMap.get(productId)?.display_name || productId

  const visible = useMemo(() => devices.filter((device) => {
    if (lot && device.factory_batch_id !== lot) return false
    if (stock === 'in_stock') return device.provisioning_state !== 'claimed'
    if (stock === 'claimed') return device.provisioning_state === 'claimed'
    return true
  }), [devices, lot, stock])

  const totals = useMemo(() => ({
    made: devices.length,
    inStock: devices.filter((device) => device.provisioning_state !== 'claimed').length,
    claimed: devices.filter((device) => device.provisioning_state === 'claimed').length,
    waiting: devices.filter((device) => device.runtime_state === 'awaiting_claim').length,
  }), [devices])

  const labelOf = (device: FactoryDevice): PairingLabelContent | null => {
    const payload = payloads[device.mac]
    return payload ? {
      payload,
      productName: productName(device.product_id),
      serial: device.serial_number,
      mac: device.mac,
    } : null
  }

  const run = async (key: string, action: () => Promise<void>, failure: string) => {
    setBusy(key)
    setNotice('')
    try {
      await action()
      setError('')
    } catch (caught) {
      setError(readError(caught, failure))
    } finally {
      setBusy('')
    }
  }

  const manufacture = (input: { productId: string; quantity: number; powerOn: boolean; note: string }) =>
    run('manufacture', async () => {
      const result = await manufactureBatch({
        product_id: input.productId,
        quantity: input.quantity,
        power_on: input.powerOn,
        ...(input.note.trim() ? { note: input.note.trim() } : {}),
      })
      rememberPayloads(result.devices)
      setLot(result.batch.id)
      setStock('all')
      await load()
      setNotice(`Đã sản xuất lô ${result.batch.id}: ${result.devices.length} ${productName(result.batch.product_id)}.`
        + (input.powerOn ? ' Thiết bị đã bật nguồn và đang chờ ghép nối.' : ''))
    }, 'Không sản xuất được lô thiết bị. Kiểm tra PostgreSQL và MQTT broker trong trang Hệ thống.')

  const togglePower = (device: FactoryDevice) => run(`power:${device.mac}`, async () => {
    await setFactoryPower(device.mac, device.desired_state !== 'online')
    await load()
  }, device.desired_state === 'online' ? 'Không tắt được nguồn thiết bị.' : 'Không bật được nguồn thiết bị. Kiểm tra MQTT broker.')

  const downloadLabel = (device: FactoryDevice) => run(`png:${device.mac}`, async () => {
    const label = labelOf(device)
    if (!label) throw new Error('Tem của thiết bị chưa tải xong.')
    downloadBlob(await renderLabelPng(label), labelFilename(label))
  }, 'Không tạo được ảnh tem.')

  const printLabels = (items: FactoryDevice[]) => {
    const labels = items.flatMap((item) => {
      const label = labelOf(item)
      return label ? [label] : []
    })
    if (labels.length === 0) {
      setError('Không có tem nào để in trong danh sách đang lọc.')
      return
    }
    setPrinting(labels)
  }

  const confirmScrap = () => {
    const target = pendingScrap
    setPendingScrap(null)
    if (!target) return
    if (target.kind === 'device') {
      void run(`scrap:${target.device.mac}`, async () => {
        await scrapFactoryDevice(target.device.mac)
        await load()
        setNotice(`Đã tiêu hủy ${target.device.serial_number || target.device.mac}.`)
      }, 'Không tiêu hủy được thiết bị. Thiết bị đã có chủ phải được gỡ trong app trước.')
    } else {
      void run(`lot:${target.batch.id}`, async () => {
        const result = await scrapUnclaimedBatch(target.batch.id)
        if (lot === target.batch.id && result.kept === 0) setLot('')
        await load()
        setNotice(`Đã tiêu hủy ${result.scrapped} thiết bị tồn kho của lô ${target.batch.id}`
          + (result.kept ? `; giữ lại ${result.kept} thiết bị đã có chủ.` : '.'))
      }, 'Không tiêu hủy được hàng tồn của lô.')
    }
  }

  if (!enabled) {
    return (
      <EmptyState
        actionLabel="Mở kiểm tra hệ thống"
        description="Xác thực admin token và hoàn tất preflight trước khi sản xuất thiết bị."
        onAction={() => window.dispatchEvent(new CustomEvent('simulator:navigate-system'))}
        title="Simulator chưa sẵn sàng."
      />
    )
  }

  return (
    <section aria-labelledby="factory-title" className="factory-page">
      <header className="page-heading">
        <div>
          <h2 id="factory-title">Tạo thiết bị trắng</h2>
          <p>Thiết bị trắng chưa thuộc về ai: có danh tính nhà máy, tài khoản MQTT và tem QR. Người dùng thật quét tem (hoặc dán mã) trong app SmartHome để thêm thiết bị vào tài khoản của mình.</p>
        </div>
      </header>

      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {notice && <p className="notice notice--success" role="status">{notice}</p>}

      <div className="factory-layout">
        <ManufactureForm
          busy={busy === 'manufacture'}
          maxBatchSize={maxBatchSize}
          onSubmit={manufacture}
          products={products}
        />

        <section aria-labelledby="factory-stock-title" className="factory-stock">
          <h3 className="visually-hidden" id="factory-stock-title">Tồn kho</h3>
          <dl className="stat-sheet factory-stats">
            <div><dt>Đã sản xuất</dt><dd>{totals.made}</dd></div>
            <div><dt>Trong kho</dt><dd>{totals.inStock}</dd></div>
            <div><dt>Đang chờ ghép</dt><dd>{totals.waiting}</dd></div>
            <div><dt>Đã có chủ</dt><dd>{totals.claimed}</dd></div>
          </dl>

          <div className="factory-lots">
            <header className="work-panel__heading">
              <div>
                <h3>Lô sản xuất</h3>
                <p>Chọn một lô để xem và in tem của lô đó.</p>
              </div>
            </header>
            {loading ? (
              <div className="registry-skeleton" aria-label="Đang tải lô sản xuất"><span /><span /></div>
            ) : batches.length === 0 ? (
              <p className="empty-inline">Chưa có lô nào. Chọn sản phẩm và số lượng để sản xuất lô đầu tiên.</p>
            ) : (
              <ol className="lot-list">
                {batches.map((batch) => (
                  <li aria-current={lot === batch.id ? 'true' : undefined} key={batch.id}>
                    <button className="lot-list__select" onClick={() => setLot(lot === batch.id ? '' : batch.id)} type="button">
                      <code>{batch.id}</code>
                      <span>{productName(batch.product_id)}{batch.note ? ` · ${batch.note}` : ''}</span>
                      <small>
                        {formatDate(batch.created_at)} · {batch.in_stock} trong kho · {batch.claimed} đã có chủ
                      </small>
                    </button>
                    <button
                      className="button button--quiet button--compact"
                      disabled={Boolean(busy) || batch.in_stock === 0}
                      onClick={() => setPendingScrap({ kind: 'lot', batch })}
                      title="Tiêu hủy các thiết bị chưa có chủ của lô"
                      type="button"
                    >
                      {busy === `lot:${batch.id}` ? 'Đang hủy…' : 'Hủy tồn kho'}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      </div>

      <section aria-labelledby="factory-labels-title" className="factory-labels">
        <header className="section-heading section-heading--compact">
          <div>
            <h3 id="factory-labels-title">Tem QR {lot ? `· ${lot}` : ''}</h3>
            <p>Mỗi tem chứa MAC và mã bí mật của thiết bị. Trên web, dùng “Sao chép mã” rồi chọn “Dán mã ghép nối” trong app.</p>
          </div>
          <button className="button" disabled={visible.length === 0} onClick={() => printLabels(visible)} type="button">
            <Icon name="print" size={16} />In {visible.length} tem
          </button>
        </header>

        <div className="registry-toolbar registry-toolbar--simple factory-toolbar">
          <div className="segmented" role="group" aria-label="Lọc theo tình trạng">
            {([
              ['all', 'Tất cả'],
              ['in_stock', 'Trong kho'],
              ['claimed', 'Đã có chủ'],
            ] as const).map(([value, label]) => (
              <button aria-pressed={stock === value} key={value} onClick={() => setStock(value)} type="button">{label}</button>
            ))}
          </div>
          {lot && (
            <button className="button button--quiet button--compact" onClick={() => setLot('')} type="button">Bỏ lọc lô</button>
          )}
        </div>

        {loading ? (
          <div className="registry-skeleton" aria-label="Đang tải tem"><span /><span /><span /></div>
        ) : visible.length === 0 ? (
          <p className="empty-inline">
            {devices.length === 0 ? 'Chưa có thiết bị nào xuất xưởng.' : 'Không có thiết bị nào khớp bộ lọc.'}
          </p>
        ) : (
          <ul className="factory-grid">
            {visible.map((device) => {
              const label = labelOf(device)
              const claimed = device.provisioning_state === 'claimed'
              return (
                <li className="factory-card" key={device.mac}>
                  {label ? <PairingLabel label={label} /> : <div className="pairing-label pairing-label--pending" aria-label="Đang tải tem" />}
                  <div className="factory-card__body">
                    <FactoryStatus device={device} />
                    {device.owner ? (
                      <p className="factory-card__owner">
                        <strong>{device.owner.device_name}</strong>
                        <span>{device.owner.account_email || 'Tài khoản không xác định'}</span>
                      </p>
                    ) : (
                      <p className="factory-card__owner factory-card__owner--empty">
                        {device.desired_state === 'online'
                          ? 'Đang bật, chờ người dùng quét tem.'
                          : 'Trong kho, chưa bật nguồn. Vẫn ghép được; thiết bị nhận chủ khi bật nguồn.'}
                      </p>
                    )}
                    <small className="factory-card__meta">
                      {device.factory_batch_id || 'Không rõ lô'} · {formatDate(device.created_at)}
                    </small>
                  </div>
                  <div className="factory-card__actions">
                      <button
                        className="button button--compact"
                        disabled={Boolean(busy)}
                        onClick={() => void togglePower(device)}
                        type="button"
                      >
                        <Icon name="power" size={15} />
                        {busy === `power:${device.mac}` ? 'Đang đổi…' : device.desired_state === 'online' ? 'Tắt nguồn' : 'Bật nguồn'}
                      </button>
                      {label && <CopyButton label="Sao chép mã" value={label.payload} />}
                      <button
                        className="button button--quiet button--compact"
                        disabled={!label || Boolean(busy)}
                        onClick={() => void downloadLabel(device)}
                        type="button"
                      >
                        <Icon name="download" size={15} />Tải tem
                      </button>
                      <button className="button button--quiet button--compact" onClick={() => onSelectDevice(device.mac)} type="button">
                        Mở thiết bị<Icon name="arrow" size={15} />
                      </button>
                      {!claimed && (
                        <button
                          className="button button--quiet button--compact factory-card__scrap"
                          disabled={Boolean(busy)}
                          onClick={() => setPendingScrap({ kind: 'device', device })}
                          type="button"
                        >
                          {busy === `scrap:${device.mac}` ? 'Đang hủy…' : 'Tiêu hủy'}
                        </button>
                      )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <ScrapDialog pending={pendingScrap} onCancel={() => setPendingScrap(null)} onConfirm={confirmScrap} />
      {printing && <PrintLabelSheet labels={printing} onDone={() => setPrinting(null)} />}
    </section>
  )
}

function ManufactureForm({
  products,
  maxBatchSize,
  busy,
  onSubmit,
}: {
  products: CatalogProduct[]
  maxBatchSize: number
  busy: boolean
  onSubmit: (input: { productId: string; quantity: number; powerOn: boolean; note: string }) => Promise<void>
}) {
  const [productId, setProductId] = useState('')
  const [quantity, setQuantity] = useState(5)
  const [powerOn, setPowerOn] = useState(true)
  const [note, setNote] = useState('')
  const selected = productId || products[0]?.id || ''
  const valid = Boolean(selected) && Number.isInteger(quantity) && quantity >= 1 && quantity <= maxBatchSize

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid || busy) return
    void onSubmit({ productId: selected, quantity, powerOn, note })
  }

  return (
    <form className="factory-order" onSubmit={submit}>
      <header className="work-panel__heading">
        <div>
          <h3>Lệnh sản xuất</h3>
          <p>Mỗi thiết bị được cấp MAC, mã bí mật, khóa RSA và tài khoản MQTT riêng.</p>
        </div>
      </header>

      <fieldset className="factory-products">
        <legend className="visually-hidden">Sản phẩm</legend>
        {products.length === 0 && <p className="empty-inline">Đang tải danh mục sản phẩm…</p>}
        {products.map((product) => (
          <label className="factory-product" key={product.id}>
            <input
              checked={selected === product.id}
              name="factory-product"
              onChange={() => setProductId(product.id)}
              type="radio"
              value={product.id}
            />
            <span className="device-row__symbol" aria-hidden="true">{categoryCode(product.category)}</span>
            <span>
              <strong>{product.display_name}</strong>
              <small>{product.id}</small>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="factory-order__row">
        <label className="field">
          <span>Số lượng</span>
          <input
            inputMode="numeric"
            max={maxBatchSize}
            min={1}
            onChange={(event) => setQuantity(Number(event.target.value))}
            type="number"
            value={Number.isFinite(quantity) ? quantity : ''}
          />
          <small>Tối đa {maxBatchSize} thiết bị mỗi lô.</small>
        </label>
        <label className="field">
          <span>Ghi chú lô</span>
          <input maxLength={120} onChange={(event) => setNote(event.target.value)} placeholder="Ví dụ: demo bảo vệ" value={note} />
          <small>Không bắt buộc.</small>
        </label>
      </div>

      <label className="check-control">
        <input checked={powerOn} onChange={(event) => setPowerOn(event.target.checked)} type="checkbox" />
        Bật nguồn ngay sau khi sản xuất
      </label>

      <button className="button button--primary" data-state={busy ? 'loading' : 'default'} disabled={!valid || busy} type="submit">
        {busy ? 'Đang sản xuất…' : `Sản xuất ${valid ? quantity : ''} thiết bị`}
      </button>
    </form>
  )
}

function FactoryStatus({ device }: { device: FactoryDevice }) {
  const claimed = device.provisioning_state === 'claimed'
  const [tone, label] = claimed
    ? device.runtime_state === 'online'
      ? ['online', 'Đã có chủ · trực tuyến']
      : device.desired_state === 'online'
        ? ['paused', 'Đã có chủ · đang kết nối']
        : ['offline', 'Đã có chủ · tắt nguồn']
    : device.runtime_state === 'awaiting_claim'
      ? ['pairing', 'Chờ ghép nối']
      : device.desired_state === 'online'
        ? device.runtime_state === 'mqtt_error' ? ['error', 'Lỗi MQTT'] : ['paused', 'Đang khởi động']
        : ['offline', 'Trong kho · tắt nguồn']
  return (
    <div className="factory-card__status">
      <span className={`runtime-badge runtime-badge--${tone}`}><i aria-hidden="true" />{label}</span>
      <small>{device.name}</small>
    </div>
  )
}

function ScrapDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingScrap | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (pending && !dialog.open) dialog.showModal()
    if (!pending && dialog.open) dialog.close()
  }, [pending])

  const title = pending?.kind === 'lot'
    ? `Tiêu hủy ${pending.batch.in_stock} thiết bị tồn kho của lô ${pending.batch.id}?`
    : `Tiêu hủy ${pending?.device.serial_number || pending?.device.mac || 'thiết bị'}?`
  return (
    <dialog className="confirm-dialog" onClose={onCancel} ref={dialogRef}>
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); onConfirm() }}>
        <h2>{title}</h2>
        <p>Danh tính nhà máy, tài khoản MQTT, bản ghi và video của thiết bị bị xóa; tem QR đã in sẽ không dùng được nữa. Thiết bị đã có chủ luôn được giữ lại.</p>
        <div className="dialog-actions">
          <button className="button button--quiet" onClick={onCancel} type="button">Giữ thiết bị</button>
          <button className="button button--danger" type="submit">Tiêu hủy</button>
        </div>
      </form>
    </dialog>
  )
}

const categoryCode = (category?: string): string => ({
  security: 'SEC',
  environment: 'ENV',
  safety: 'SAFE',
  agriculture: 'WTR',
}[category || ''] || 'DEV')

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))

const readError = (caught: unknown, fallback: string): string =>
  caught instanceof Error && caught.message ? `${fallback} (${caught.message})` : fallback
