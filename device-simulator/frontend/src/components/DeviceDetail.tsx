import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deviceAction,
  fetchDevice,
  fetchDeviceLive,
  performPhysicalSirenAction,
  revealDeviceSecret,
  sendDeviceTelemetry,
  setDeviceConnection,
  updateDeviceState,
} from '../api'
import type {
  CapabilityInstance,
  DeviceDetailPayload,
  DeviceOperation,
  DeviceStatePatch,
  SimulatedDevice,
  SimulatorEvent,
} from '../types'
import { CopyButton } from './CopyButton'
import { CapabilityControl } from './device/CapabilityControl'
import { DeviceTelemetryPanel } from './device/DeviceTelemetryPanel'
import { LcdSimulator } from './device/LcdSimulator'
import {
  formatValue,
  humanize,
  instanceLabel,
  isCameraInstance,
  isHiddenProperty,
  isLcdInstance,
  mergeDevicePatch,
  patchForProperty,
  propertyLabel,
  readPropertyValue,
} from './device/device-utils'

type DeviceTab = 'controls' | 'data' | 'history' | 'technical'

export function DeviceDetail({
  mac,
  onBack,
}: {
  mac: string
  onBack: () => void
}) {
  const [payload, setPayload] = useState<DeviceDetailPayload | null>(null)
  const [latestTelemetry, setLatestTelemetry] = useState<Record<string, unknown> | null>(null)
  const [tab, setTab] = useState<DeviceTab>('controls')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [acting, setActing] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const result = await fetchDevice(mac)
      setPayload(result)
      setLatestTelemetry(result.telemetry[0] || null)
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Không tải được thiết bị ảo. Kiểm tra backend Simulator rồi thử lại.'))
    } finally {
      setLoading(false)
    }
  }, [mac])

  const refreshLive = useCallback(async () => {
    try {
      const live = await fetchDeviceLive(mac)
      setPayload((current) => current ? {
        ...current,
        device: live.device,
        backend_shadow: live.backend_shadow,
      } : current)
      setLatestTelemetry(live.latest_telemetry)
    } catch {
      // The full load surface already owns visible errors. A transient polling
      // failure must not replace usable device data with an error screen.
    }
  }, [mac])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshLive()
    }, 2500)
    return () => window.clearInterval(timer)
  }, [refreshLive])

  const applyPatch = async (patch: DeviceStatePatch) => {
    const previous = payload?.device
    if (previous?.state_snapshot) {
      setPayload((current) => current ? {
        ...current,
        device: {
          ...current.device,
          state_snapshot: mergeDevicePatch(current.device.state_snapshot!, patch),
        },
      } : current)
    }
    try {
      const result = await updateDeviceState(mac, patch)
      setPayload((current) => current ? {
        ...current,
        device: { ...current.device, state_snapshot: result.state },
      } : current)
      window.setTimeout(() => void refreshLive(), 350)
    } catch (caught) {
      if (previous) {
        setPayload((current) => current ? { ...current, device: previous } : current)
      }
      throw new Error(readError(caught, 'Không thể cập nhật trạng thái vật lý.'))
    }
  }

  const setConnection = async (online: boolean) => {
    setActing(online ? 'connect' : 'disconnect')
    try {
      await setDeviceConnection(mac, online)
      await refreshLive()
    } catch (caught) {
      setError(readError(caught, 'Không đổi được kết nối MQTT.'))
    } finally {
      setActing('')
    }
  }

  const sendNow = async () => {
    setActing('telemetry')
    try {
      await sendDeviceTelemetry(mac)
      window.setTimeout(() => void refreshLive(), 450)
    } catch (caught) {
      setError(readError(caught, 'Không gửi được telemetry. Thiết bị phải trực tuyến và không bị tạm dừng.'))
    } finally {
      setActing('')
    }
  }

  const runPhysicalSiren = async (
    action: 'test_siren' | 'mute_siren' | 'resume_siren',
    durationSeconds = 0,
  ) => {
    setActing(`physical-${action}`)
    try {
      const result = await performPhysicalSirenAction(mac, action, durationSeconds)
      setPayload((current) => current ? {
        ...current,
        device: { ...current.device, state_snapshot: result.state },
      } : current)
      window.setTimeout(() => void refreshLive(), 350)
      setError('')
    } catch (caught) {
      setError(readError(caught, 'Thiết bị từ chối thao tác còi.'))
    } finally {
      setActing('')
    }
  }

  const act = async (
    action: 'pause' | 'resume' | 'force-offline' | 'reconnect' | 'reset-state',
  ) => {
    setActing(action)
    try {
      await deviceAction(mac, action)
      await load()
    } catch (caught) {
      setError(readError(caught, `Không thực hiện được thao tác ${action}.`))
    } finally {
      setActing('')
    }
  }

  const reveal = async () => {
    try {
      const result = await revealDeviceSecret(mac)
      setSecret(result.device.secret_key)
    } catch (caught) {
      setError(readError(caught, 'Không đọc được factory secret.'))
    }
  }

  if (loading) {
    return <DeviceDetailSkeleton onBack={onBack} />
  }

  if (!payload) {
    return (
      <section>
        <BackButton onBack={onBack} />
        <p className="notice notice--error" role="alert">{error || 'Không tìm thấy thiết bị.'}</p>
      </section>
    )
  }

  const { device, product, backend_shadow: backendShadow, operations, events } = payload
  const online = device.runtime_state === 'online'

  return (
    <section className="device-workbench" aria-labelledby="device-title">
      <BackButton onBack={onBack} />

      <header className="device-hero">
        <div className="device-hero__identity">
          <div className="product-symbol" aria-hidden="true">{productSymbol(product.category)}</div>
          <div>
            <p>{product.presentation?.display_name || product.model_name}</p>
            <h2 id="device-title">{device.name || device.mac}</h2>
            <code>{device.mac}</code>
          </div>
        </div>
        <div className="device-hero__status">
          <RuntimeBadge status={device.runtime_state} />
          <span>{device.topology_role === 'hub' ? 'Hub' : device.topology_role === 'node' ? 'Node' : 'Chưa phân vai'}</span>
          <span>{device.transport_mode ? humanize(device.transport_mode) : 'Direct'}</span>
        </div>
      </header>

      {error && <p className="notice notice--error" role="alert">{error}</p>}
      {(!payload.product_contract_compatible || device.runtime_state === 'contract_error') && (
        <p className="notice notice--error" role="alert">
          {device.last_error || 'Product Contract của thiết bị không còn tương thích với Catalog runtime. Hãy migrate thiết bị hoặc tạo lại dữ liệu test.'}
        </p>
      )}

      <div className="device-actions" aria-label="Điều khiển runtime">
        <button
          className="button button--primary"
          disabled={Boolean(acting)}
          onClick={() => void setConnection(!online)}
          type="button"
        >
          {acting === 'connect' || acting === 'disconnect'
            ? 'Đang đổi kết nối…'
            : online ? 'Ngắt kết nối' : 'Kết nối thiết bị'}
        </button>
        <button
          className="button button--quiet"
          disabled={Boolean(acting) || !online}
          onClick={() => void sendNow()}
          type="button"
        >
          {acting === 'telemetry' ? 'Đang gửi…' : 'Gửi telemetry'}
        </button>
        {device.runtime_state === 'paused' ? (
          <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void act('resume')} type="button">Tiếp tục tự gửi</button>
        ) : (
          <button className="button button--quiet" disabled={Boolean(acting) || !online} onClick={() => void act('pause')} type="button">Dừng tự gửi</button>
        )}
      </div>

      <nav aria-label="Nội dung thiết bị" className="detail-tabs">
        <DetailTab active={tab === 'controls'} label="Thiết bị vật lý" onClick={() => setTab('controls')} />
        <DetailTab active={tab === 'data'} label="Dữ liệu đang gửi" onClick={() => setTab('data')} />
        <DetailTab active={tab === 'history'} label="Lịch sử" onClick={() => setTab('history')} />
        <DetailTab active={tab === 'technical'} label="Kỹ thuật" onClick={() => setTab('technical')} />
      </nav>

      {tab === 'controls' && (
        <PhysicalWorkbench
          acting={acting}
          device={device}
          instances={product.capability_instances}
          onPatch={applyPatch}
          onSirenAction={runPhysicalSiren}
        />
      )}

      {tab === 'data' && (
        <DeviceTelemetryPanel
          backendShadow={backendShadow}
          device={device}
          latestTelemetry={latestTelemetry}
        />
      )}

      {tab === 'history' && (
        <HistoryView events={events} operations={operations} />
      )}

      {tab === 'technical' && (
        <TechnicalView
          acting={acting}
          device={device}
          onAction={act}
          onReveal={reveal}
          productRevision={product.catalog_revision}
          secret={secret}
        />
      )}
    </section>
  )
}

function PhysicalWorkbench({
  acting,
  device,
  instances,
  onPatch,
  onSirenAction,
}: {
  acting: string
  device: SimulatedDevice
  instances: CapabilityInstance[]
  onPatch: (patch: DeviceStatePatch) => Promise<void>
  onSirenAction: (
    action: 'test_siren' | 'mute_siren' | 'resume_siren',
    durationSeconds?: number,
  ) => Promise<void>
}) {
  const ordered = useMemo(() => [...instances].sort((left, right) => (
    Number(left.presentation?.order || 0) - Number(right.presentation?.order || 0)
  )), [instances])
  const lcd = ordered.find(isLcdInstance)
  const camera = ordered.find(isCameraInstance)
  const standard = ordered.filter((instance) => !isLcdInstance(instance) && !isCameraInstance(instance))

  if (device.product_id === 'prod_hazard_mitigation') {
    return (
      <HazardPhysicalWorkbench
        acting={acting}
        device={device}
        instances={ordered}
        onPatch={onPatch}
        onSirenAction={onSirenAction}
      />
    )
  }

  return (
    <div className="physical-workbench">
      <div className="physical-workbench__main">
        <header className="work-panel__heading work-panel__heading--page">
          <div>
            <h3>Trạng thái và tín hiệu vật lý</h3>
            <p>Giá trị thay đổi ở đây được ghi vào thiết bị ảo và publish qua MQTT khi thiết bị trực tuyến.</p>
          </div>
          <span className="state-version">State v{device.state_snapshot?.state_version ?? 0}</span>
        </header>

        <div className="capability-stack">
          {standard.map((instance) => (
            <CapabilitySection
              device={device}
              instance={instance}
              key={instance.instance_id}
              onPatch={onPatch}
            />
          ))}
        </div>
      </div>

      <aside className="physical-workbench__side">
        {lcd && (
          <LcdSimulator
            disabled={false}
            instance={lcd}
            onPatch={onPatch}
            state={device.state_snapshot}
          />
        )}
        {camera && <CameraPlaceholder device={device} instance={camera} />}
        {!lcd && !camera && (
          <section className="device-note">
            <h3>Phần cứng đặc biệt</h3>
            <p>Model này không khai báo LCD hoặc camera trong Product Catalog.</p>
          </section>
        )}
      </aside>
    </div>
  )
}

function HazardPhysicalWorkbench({
  acting,
  device,
  instances,
  onPatch,
  onSirenAction,
}: {
  acting: string
  device: SimulatedDevice
  instances: CapabilityInstance[]
  onPatch: (patch: DeviceStatePatch) => Promise<void>
  onSirenAction: (
    action: 'test_siren' | 'mute_siren' | 'resume_siren',
    durationSeconds?: number,
  ) => Promise<void>
}) {
  const sensorDefinitions = [
    ['temperature_measurement', 'temperature'],
    ['humidity_measurement', 'humidity'],
    ['gas_measurement', 'gas_level'],
    ['smoke_measurement', 'smoke_level'],
    ['flame_detection', 'flame_detected'],
  ] as const
  const sensorControls = sensorDefinitions.flatMap(([capabilityId, propertyId]) => {
    const instance = instances.find((item) => item.capability_id === capabilityId)
    const property = instance?.properties.find((item) => item.id === propertyId)
    return instance && property ? [{ instance, property }] : []
  })
  const sirenInstance = instances.find((item) => item.capability_id === 'alarm_siren')
  const sirenProperty = sirenInstance?.properties.find((item) => item.id === 'audible_state')
  const muteUntilProperty = sirenInstance?.properties.find((item) => item.id === 'mute_until')
  const riskInstance = instances.find((item) => item.capability_id === 'hazard_controller')
  const riskProperty = riskInstance?.properties.find((item) => item.id === 'risk_level')
  const audibleState = String(
    sirenInstance && sirenProperty
      ? readPropertyValue(device.state_snapshot, sirenInstance.instance_id, sirenProperty)
      : 'silent',
  )
  const riskLevel = String(
    riskInstance && riskProperty
      ? readPropertyValue(device.state_snapshot, riskInstance.instance_id, riskProperty)
      : 'sensor_fault',
  )
  const muteUntil = sirenInstance && muteUntilProperty
    ? readPropertyValue(device.state_snapshot, sirenInstance.instance_id, muteUntilProperty)
    : null
  const muteOperation = sirenInstance?.operations.find((item) => item.id === 'mute_siren')
  const durationSchema = muteOperation?.input.duration_seconds
  const durationOptions = (durationSchema?.enum || [60, 180, 300, 600, 1800])
    .filter((value): value is number => typeof value === 'number' && Number.isInteger(value))
    .sort((left, right) => left - right)
  const defaultDuration = typeof durationSchema?.default === 'number'
    && durationOptions.includes(durationSchema.default)
    ? durationSchema.default
    : durationOptions[0] || 60
  const [muteDuration, setMuteDuration] = useState(defaultDuration)
  const busy = acting.startsWith('physical-')
  const hazardActive = riskLevel === 'alarm' || riskLevel === 'emergency'

  return (
    <div className="hazard-workbench">
      <header className="work-panel__heading work-panel__heading--page">
        <div>
          <h3>Cảm biến an toàn</h3>
          <p>Điều chỉnh tín hiệu vật lý để kiểm tra cảnh báo; state mới sẽ được publish qua MQTT khi thiết bị trực tuyến.</p>
        </div>
        <span className="state-version">State v{device.state_snapshot?.state_version ?? 0}</span>
      </header>

      <div className="hazard-sensor-grid">
        {sensorControls.map(({ instance, property }) => (
          <section className="hazard-sensor-card" key={`${instance.instance_id}:${property.id}`}>
            <CapabilityControl
              disabled={false}
              onCommit={(value) => onPatch(patchForProperty(instance.instance_id, property, value))}
              property={property}
              value={readPropertyValue(device.state_snapshot, instance.instance_id, property)}
            />
          </section>
        ))}
      </div>

      <section className={`hazard-siren-panel hazard-siren-panel--${audibleState}`}>
        <header>
          <div>
            <p>Đầu ra an toàn tự động</p>
            <h3>Còi cảnh báo</h3>
          </div>
          <strong>{sirenStateLabel(audibleState)}</strong>
        </header>

        <dl className="hazard-status-strip">
          <div><dt>Mức nguy hiểm</dt><dd>{humanize(riskLevel)}</dd></div>
          <div><dt>Tắt còi đến</dt><dd>{formatMuteDeadline(muteUntil)}</dd></div>
        </dl>

        <div className="hazard-siren-actions">
          <button
            className="button button--primary"
            disabled={busy || audibleState !== 'silent' || hazardActive}
            onClick={() => void onSirenAction('test_siren', 5)}
            type="button"
          >
            {acting === 'physical-test_siren' ? 'Đang kiểm tra…' : 'Kiểm tra phần cứng 5 giây'}
          </button>
          <label>
            <span>Thời gian tắt còi</span>
            <select
              disabled={busy}
              onChange={(event) => setMuteDuration(Number(event.target.value))}
              value={muteDuration}
            >
              {durationOptions.map((seconds) => (
                <option key={seconds} value={seconds}>{formatSirenDuration(seconds)}</option>
              ))}
            </select>
          </label>
          <button
            className="button button--quiet"
            disabled={busy}
            onClick={() => void onSirenAction('mute_siren', muteDuration)}
            type="button"
          >
            {acting === 'physical-mute_siren'
              ? 'Đang cập nhật…'
              : audibleState === 'muted'
                ? 'Cập nhật thời gian tắt'
                : 'Tắt còi tạm thời'}
          </button>
          {audibleState === 'muted' && (
            <button
              className="button button--primary"
              disabled={busy}
              onClick={() => void onSirenAction('resume_siren')}
              type="button"
            >
              {acting === 'physical-resume_siren'
                ? 'Đang bật lại…'
                : 'Bật lại cảnh báo ngay'}
            </button>
          )}
        </div>

        <p className={`hazard-safety-note${audibleState === 'muted' ? ' hazard-safety-note--warning' : ''}`}>
          {audibleState === 'muted'
            ? 'Cảnh báo: còi vật lý đang bị tắt tạm thời. Cảm biến và cảnh báo dữ liệu vẫn hoạt động; bạn có thể bật lại còi ngay hoặc chờ đến hạn.'
            : 'Còi mặc định ở trạng thái chờ. Có thể tắt trước cảnh báo trong thời gian đã chọn; hết hạn còi sẽ kêu ngay nếu nguy hiểm đang tồn tại.'}
        </p>
      </section>
    </div>
  )
}

function sirenStateLabel(value: string) {
  if (value === 'sounding') return 'Đang kêu'
  if (value === 'muted') return 'Đã tắt cảnh báo tạm thời'
  if (value === 'silent') return 'Đang chờ cảnh báo'
  return 'Chưa xác định'
}

function formatSirenDuration(seconds: number) {
  return seconds < 60 ? `${seconds} giây` : `${seconds / 60} phút`
}

function formatMuteDeadline(value: unknown) {
  if (typeof value !== 'string' || !value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleTimeString('vi-VN')
}

function CapabilitySection({
  device,
  instance,
  onPatch,
}: {
  device: SimulatedDevice
  instance: CapabilityInstance
  onPatch: (patch: DeviceStatePatch) => Promise<void>
}) {
  const editable = instance.properties.filter((property) => (
    property.channel !== 'desired' && !isHiddenProperty(property)
  ))
  const desired = instance.properties.filter((property) => (
    property.channel === 'desired' && !isHiddenProperty(property)
  ))
  const eventOnly = editable.length === 0 && instance.events.length > 0

  if (editable.length === 0 && desired.length === 0 && !eventOnly) return null

  return (
    <section className="capability-section">
      <header>
        <div>
          <h4>{instanceLabel(instance)}</h4>
          {instance.presentation?.description && <p>{instance.presentation.description}</p>}
        </div>
        <code>{instance.instance_id}</code>
      </header>

      {editable.length > 0 && (
        <div className="capability-controls">
          {editable.map((property) => (
            <CapabilityControl
              disabled={false}
              key={`${property.channel}:${property.id}`}
              onCommit={(value) => onPatch(patchForProperty(instance.instance_id, property, value))}
              property={property}
              value={readPropertyValue(device.state_snapshot, instance.instance_id, property)}
            />
          ))}
        </div>
      )}

      {desired.length > 0 && (
        <dl className="desired-state">
          {desired.map((property) => (
            <div key={property.id}>
              <dt>Backend yêu cầu · {propertyLabel(property)}</dt>
              <dd>{formatValue(readPropertyValue(device.state_snapshot, instance.instance_id, property), property)}</dd>
            </div>
          ))}
        </dl>
      )}

      {eventOnly && (
        <div className="event-transport-gap">
          <strong>{instance.events.map((event) => humanize(event.id)).join(' · ')}</strong>
          <p>Catalog đã khai báo sự kiện vật lý, nhưng hệ thống chính chưa có MQTT event transport để nhận sự kiện này.</p>
          <button disabled type="button">Mô phỏng nút vật lý — chưa hỗ trợ</button>
        </div>
      )}
    </section>
  )
}

function CameraPlaceholder({
  device,
  instance,
}: {
  device: SimulatedDevice
  instance: CapabilityInstance
}) {
  const stateProperty = instance.properties.find((property) => property.id === 'camera_state')
  const value = stateProperty
    ? readPropertyValue(device.state_snapshot, instance.instance_id, stateProperty)
    : 'offline'
  return (
    <section className="camera-placeholder">
      <div className="camera-placeholder__screen" aria-hidden="true">
        <span>ESP32-CAM</span>
        <strong>STREAM TẠM HOÃN</strong>
      </div>
      <div>
        <h3>{instanceLabel(instance)}</h3>
        <p>Trạng thái catalog: <strong>{formatValue(value, stateProperty)}</strong></p>
        <p>Chưa mô phỏng video stream hoặc snapshot trong giai đoạn này.</p>
      </div>
    </section>
  )
}

function HistoryView({
  operations,
  events,
}: {
  operations: DeviceOperation[]
  events: SimulatorEvent[]
}) {
  return (
    <div className="history-grid">
      <section className="history-panel">
        <header className="work-panel__heading"><div><h3>Lệnh từ backend</h3><p>{operations.length} lệnh gần nhất được tải.</p></div></header>
        {operations.length > 0 ? (
          <ol className="operation-list">
            {operations.map((operation) => (
              <li key={operation.id}>
                <div><strong>{humanize(operation.operation_name)}</strong><small>{operation.instance_id}</small></div>
                <span className={`record-status record-status--${operation.status}`}>{humanize(operation.status)}</span>
                <time>{formatDate(operation.accepted_at)}</time>
                {Object.keys(operation.input || {}).length > 0 && <code>{JSON.stringify(operation.input)}</code>}
              </li>
            ))}
          </ol>
        ) : <EmptyHistory label="Chưa có lệnh nào được gửi tới thiết bị." />}
      </section>
      <section className="history-panel">
        <header className="work-panel__heading"><div><h3>Sự kiện Simulator</h3><p>Thao tác runtime, bảo mật và cập nhật thủ công.</p></div></header>
        <EventRows events={events} />
      </section>
    </div>
  )
}

function TechnicalView({
  device,
  productRevision,
  secret,
  acting,
  onReveal,
  onAction,
}: {
  device: SimulatedDevice
  productRevision: number
  secret: string
  acting: string
  onReveal: () => Promise<void>
  onAction: (action: 'pause' | 'resume' | 'force-offline' | 'reconnect' | 'reset-state') => Promise<void>
}) {
  return (
    <div className="technical-layout">
      <section className="technical-panel">
        <header className="work-panel__heading"><div><h3>Định danh và topology</h3><p>Thông tin được dùng khi kết nối với hệ thống chính.</p></div></header>
        <dl className="spec-sheet">
          <Spec label="MAC address" value={device.mac} mono />
          <Spec label="Product ID" value={device.product_id} mono />
          <Spec label="Catalog revision" value={String(productRevision)} />
          <Spec label="Provisioning" value={humanize(device.provisioning_state)} />
          <Spec label="Desired runtime" value={humanize(device.desired_state)} />
          <Spec label="Topology role" value={device.topology_role ? humanize(device.topology_role) : 'Chưa phân vai'} />
          <Spec label="Transport" value={device.transport_mode ? humanize(device.transport_mode) : 'Direct'} />
          <Spec label="Network ID" value={device.network_id || 'Chưa gán'} mono />
          <Spec label="Active Hub" value={device.active_hub_mac || '—'} mono />
          <Spec label="Topology epoch" value={String(device.topology_epoch ?? '—')} />
          <Spec label="Join rank" value={String(device.join_rank ?? '—')} />
          <Spec label="MQTT sequence" value={String(device.seq)} />
        </dl>
      </section>

      <section className="technical-panel">
        <header className="work-panel__heading"><div><h3>Factory identity</h3><p>Secret chỉ được giải mã khi bạn chủ động yêu cầu.</p></div></header>
        {secret ? (
          <div className="secret-line"><code>{secret}</code><CopyButton value={secret} /></div>
        ) : (
          <button className="button button--quiet" onClick={() => void onReveal()} type="button">Hiện factory secret</button>
        )}
      </section>

      <section className="technical-panel technical-panel--full">
        <header className="work-panel__heading"><div><h3>Khôi phục runtime</h3><p>Các thao tác này dành cho kiểm thử lỗi kết nối và state.</p></div></header>
        <div className="technical-actions">
          <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void onAction('reconnect')} type="button">Kết nối lại MQTT</button>
          <button className="button button--quiet" disabled={Boolean(acting)} onClick={() => void onAction('force-offline')} type="button">Ép ngoại tuyến</button>
          <button className="button button--danger" disabled={Boolean(acting)} onClick={() => void onAction('reset-state')} type="button">Đặt lại state</button>
        </div>
        <details className="raw-disclosure">
          <summary>Xem state JSON trong registry</summary>
          <pre>{JSON.stringify(device.state_snapshot, null, 2)}</pre>
        </details>
      </section>
    </div>
  )
}

export function EventRows({ events }: { events: SimulatorEvent[] }) {
  if (events.length === 0) return <EmptyHistory label="Chưa có sự kiện Simulator phù hợp." />
  return (
    <ol className="event-list">
      {events.map((event, index) => (
        <li key={event._id || `${event.created_at}:${index}`}>
          <span className={`status-mark status-mark--${event.severity === 'error' ? 'error' : event.severity === 'warning' ? 'warning' : 'ok'}`} />
          <div><strong>{event.message}</strong><small>{formatDate(event.created_at)} · {event.type}</small></div>
        </li>
      ))}
    </ol>
  )
}

function DetailTab({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button aria-current={active ? 'page' : undefined} onClick={onClick} type="button">{label}</button>
}

function RuntimeBadge({ status }: { status: string }) {
  const tone = status === 'online'
    ? 'online'
    : status === 'paused'
      ? 'paused'
      : status === 'contract_error' || status === 'mqtt_error'
        ? 'error'
        : 'offline'
  return <span className={`runtime-badge runtime-badge--${tone}`}><i aria-hidden="true" />{humanize(status)}</span>
}

function BackButton({ onBack }: { onBack: () => void }) {
  return <button className="back-link" onClick={onBack} type="button">← Danh sách thiết bị</button>
}

function DeviceDetailSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <section className="device-workbench" aria-busy="true">
      <BackButton onBack={onBack} />
      <div className="device-skeleton"><span /><span /><span /></div>
      <p className="visually-hidden">Đang tải thiết bị…</p>
    </section>
  )
}

function EmptyHistory({ label }: { label: string }) {
  return <div className="empty-state empty-state--compact"><strong>{label}</strong><p>Dữ liệu sẽ xuất hiện ở đây khi thiết bị hoạt động.</p></div>
}

function Spec({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><dt>{label}</dt><dd className={mono ? 'mono' : undefined}>{value}</dd></div>
}

const productSymbol = (category: string): string => ({
  security: 'SEC',
  environment: 'ENV',
  safety: 'SAFE',
  agriculture: 'WTR',
}[category] || 'DEV')

const formatDate = (value?: string) => value
  ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value))
  : 'Chưa có thời gian'

const readError = (value: unknown, fallback: string): string => value instanceof Error
  ? `${value.message} ${fallback}`
  : fallback
