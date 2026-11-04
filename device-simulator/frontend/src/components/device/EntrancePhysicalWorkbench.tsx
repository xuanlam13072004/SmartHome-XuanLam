/* Hallmark · component: entrance hardware workbench · genre: modern-minimal · theme: Coral
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: token-bound
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  CapabilityInstance,
  DeviceStatePatch,
  EntranceRuntimeStatus,
  SimulatedDevice,
  VirtualHardwareDetail,
} from '../../types'
import { CopyButton } from '../CopyButton'
import { LcdSimulator } from './LcdSimulator'
import { formatValue, readPropertyValue } from './device-utils'

const KEYPAD_ROWS = [
  ['1', '2', '3', 'A'],
  ['4', '5', '6', 'B'],
  ['7', '8', '9', 'C'],
  ['*', '0', '#', 'D'],
] as const

type SensorState = 'calibrating' | 'ready' | 'fault'
type ActionState = 'default' | 'loading' | 'error' | 'success'

export function EntrancePhysicalWorkbench({
  device,
  instances,
  virtualHardware,
  wifiControl,
  onDoorPosition,
  onKeypad,
  onPatch,
}: {
  device: SimulatedDevice
  instances: CapabilityInstance[]
  virtualHardware: VirtualHardwareDetail | null
  wifiControl: ReactNode
  onDoorPosition: (angleDegrees: number, sensorState: SensorState) => Promise<void>
  onKeypad: (key: string) => Promise<void>
  onPatch: (patch: DeviceStatePatch) => Promise<void>
}) {
  const lock = instances.find((instance) => instance.capability_id === 'door_lock')
  const position = instances.find((instance) => instance.capability_id === 'door_position')
  const lcd = instances.find((instance) => instance.capability_id === 'character_display_4x20')
  const lockState = String(readInstanceProperty(device, lock, 'lock_state') || 'locked')
  const doorState = String(readInstanceProperty(device, position, 'door_state') || 'unknown')
  const reportedAngle = Number(readInstanceProperty(device, position, 'door_angle_degrees') || 0)
  const reportedSensorState = normalizeSensorState(
    readInstanceProperty(device, position, 'position_sensor_state'),
  )
  const entrance = virtualHardware?.entrance || null
  const [previewAngle, setPreviewAngle] = useState(reportedAngle)

  useEffect(() => setPreviewAngle(reportedAngle), [reportedAngle])

  return (
    <div className="entrance-workbench">
      <header className="work-panel__heading work-panel__heading--page">
        <div>
          <h3>Cửa chính vật lý</h3>
          <p>Nhập PIN trên keypad, quan sát servo và thay đổi góc MPU6050 như trên thiết bị thật.</p>
        </div>
        <span className="state-version">State v{device.state_snapshot?.state_version ?? 0}</span>
      </header>

      {wifiControl}

      <div className="entrance-workbench__layout">
        <main className="entrance-workbench__controls">
          <LockAndDoorStatus
            angle={previewAngle}
            doorState={doorState}
            entrance={entrance}
            lockState={lockState}
            sensorState={reportedSensorState}
          />
          <VirtualKeypad
            accessPin={virtualHardware?.access_pin || ''}
            entrance={entrance}
            onKeypad={onKeypad}
          />
          <DoorPositionControl
            angle={reportedAngle}
            doorState={doorState}
            lockState={lockState}
            onDoorPosition={onDoorPosition}
            onPreviewAngle={setPreviewAngle}
            sensorState={reportedSensorState}
          />
        </main>

        <aside className="entrance-workbench__display">
          {lcd ? (
            <LcdSimulator
              disabled={false}
              instance={lcd}
              onPatch={onPatch}
              state={device.state_snapshot}
            />
          ) : (
            <p className="notice notice--error">Product Contract chưa khai báo LCD 4×20.</p>
          )}
          <section className="entrance-behaviour-note">
            <h3>Quy tắc firmware</h3>
            <p>Mở khóa không đồng nghĩa cửa đã mở. Nếu cửa không chuyển động trong 30 giây, servo tự khóa lại.</p>
            <p>Sau khi MPU6050 xác nhận cửa đã đóng ổn định 3 giây, servo mới được phép khóa.</p>
            <p>Khi cảm biến lỗi hoặc cửa còn mở, firmware từ chối khóa để tránh kẹt cơ khí.</p>
          </section>
        </aside>
      </div>
    </div>
  )
}

function LockAndDoorStatus({
  angle,
  lockState,
  doorState,
  sensorState,
  entrance,
}: {
  angle: number
  lockState: string
  doorState: string
  sensorState: SensorState
  entrance: EntranceRuntimeStatus | null
}) {
  const doorAngle = Number.isFinite(angle) ? Math.min(180, Math.max(0, angle)) : 0
  const doorAngleStyle = { '--door-angle': `${doorAngle}deg` } as CSSProperties
  return (
    <section className="entrance-status-panel">
      <header>
        <div>
          <h4>Khóa và cánh cửa</h4>
          <p>Servo SG90 và góc cửa là hai trạng thái độc lập.</p>
        </div>
        <strong>{lockLabel(lockState)}</strong>
      </header>
      <div className="entrance-status-panel__body">
        <div
          aria-label={`Góc cánh cửa ${formatAngle(doorAngle)}`}
          className="door-angle-dial"
          role="img"
          style={doorAngleStyle}
        >
          <span />
          <strong>{formatAngle(doorAngle)}</strong>
        </div>
        <dl className="entrance-status-list">
          <div><dt>Chốt khóa</dt><dd>{lockLabel(lockState)}</dd></div>
          <div><dt>Cánh cửa</dt><dd>{doorLabel(doorState)}</dd></div>
          <div><dt>MPU6050</dt><dd>{sensorLabel(sensorState)}</dd></div>
          <div><dt>Tiến trình cục bộ</dt><dd>{phaseLabel(entrance?.phase)}</dd></div>
        </dl>
      </div>
    </section>
  )
}

function VirtualKeypad({
  accessPin,
  entrance,
  onKeypad,
}: {
  accessPin: string
  entrance: EntranceRuntimeStatus | null
  onKeypad: (key: string) => Promise<void>
}) {
  const [actionState, setActionState] = useState<ActionState>('default')
  const [activeKey, setActiveKey] = useState('')
  const [feedback, setFeedback] = useState('Nhấn A để nhập PIN; khi MPU6050 đang hiệu chuẩn, nhấn D để lấy góc đóng làm mốc.')

  const press = async (key: string) => {
    setActiveKey(key)
    setActionState('loading')
    setFeedback(`Đang gửi phím ${key} vào firmware ảo…`)
    try {
      await onKeypad(key)
      setActionState('success')
      setFeedback(`Firmware đã nhận phím ${key}. Quan sát phản hồi trên LCD.`)
      window.setTimeout(() => setActionState('default'), 700)
    } catch (caught) {
      setActionState('error')
      setFeedback(caught instanceof Error
        ? caught.message
        : 'Firmware không nhận được phím. Kiểm tra trạng thái khóa rồi thử lại.')
    } finally {
      setActiveKey('')
    }
  }

  return (
    <section className="virtual-keypad-panel" data-state={actionState}>
      <header>
        <div>
          <h4>Bàn phím 4×4</h4>
          <p>PIN được kiểm tra cục bộ; backend chỉ nhận kết quả xác thực đã làm sạch.</p>
        </div>
        <span className="phase-badge">{phaseLabel(entrance?.phase)}</span>
      </header>

      <div className="virtual-pin">
        <div>
          <span>PIN của thiết bị ảo</span>
          <code>{accessPin || 'Chưa cấu hình'}</code>
        </div>
        {accessPin && <CopyButton label="Sao chép PIN" value={accessPin} />}
      </div>

      <div aria-label="Bàn phím khóa cửa 4 nhân 4" className="virtual-keypad" role="group">
        {KEYPAD_ROWS.flat().map((key) => (
          <button
            aria-label={keypadAriaLabel(key)}
            className={key === 'A' || key === '#' ? 'virtual-keypad__key virtual-keypad__key--action' : 'virtual-keypad__key'}
            data-state={activeKey === key ? 'loading' : actionState === 'error' ? 'error' : 'default'}
            disabled={actionState === 'loading' || !accessPin}
            key={key}
            onClick={() => void press(key)}
            type="button"
          >
            {activeKey === key ? '…' : key}
          </button>
        ))}
      </div>
      <p aria-live="polite" className="control-feedback" role={actionState === 'error' ? 'alert' : 'status'}>
        {feedback}
      </p>
      {entrance?.lockout_until && (
        <p className="notice notice--error">
          Bàn phím tạm khóa đến {new Date(entrance.lockout_until).toLocaleTimeString('vi-VN')} sau nhiều lần nhập sai.
        </p>
      )}
    </section>
  )
}

function DoorPositionControl({
  angle,
  doorState,
  lockState,
  sensorState,
  onDoorPosition,
  onPreviewAngle,
}: {
  angle: number
  doorState: string
  lockState: string
  sensorState: SensorState
  onDoorPosition: (angleDegrees: number, sensorState: SensorState) => Promise<void>
  onPreviewAngle: (angleDegrees: number) => void
}) {
  const [draftAngle, setDraftAngle] = useState(angle)
  const [draftSensor, setDraftSensor] = useState(sensorState)
  const [actionState, setActionState] = useState<ActionState>('default')
  const [feedback, setFeedback] = useState('0° là cửa đóng; từ 12° trở lên được xem là cửa đã mở.')
  const canOpenDoor = lockState === 'unlocked'
  const openingDraftIsBlocked = draftAngle > 4 && !canOpenDoor

  useEffect(() => setDraftAngle(angle), [angle])
  useEffect(() => setDraftSensor(sensorState), [sensorState])

  const apply = async (nextAngle = draftAngle, nextSensor = draftSensor) => {
    setActionState('loading')
    setFeedback('Đang cập nhật tín hiệu MPU6050…')
    setDraftAngle(nextAngle)
    onPreviewAngle(nextAngle)
    try {
      await onDoorPosition(nextAngle, nextSensor)
      setDraftSensor(nextSensor)
      setActionState('success')
      setFeedback('Firmware đã nhận góc mới và tự suy ra trạng thái cánh cửa.')
      window.setTimeout(() => setActionState('default'), 700)
    } catch (caught) {
      setDraftAngle(angle)
      setDraftSensor(sensorState)
      onPreviewAngle(angle)
      setActionState('error')
      setFeedback(caught instanceof Error
        ? caught.message
        : 'Không cập nhật được MPU6050. Kiểm tra giá trị rồi thử lại.')
    }
  }

  return (
    <section className="door-position-panel" data-state={actionState}>
      <header>
        <div>
          <h4>Mô phỏng MPU6050</h4>
          <p>Góc cửa chỉ thay đổi bằng thao tác tại đây và chỉ được mở sau khi PIN hợp lệ.</p>
        </div>
        <strong>{doorLabel(doorState)} · {formatAngle(angle)}</strong>
      </header>

      <label className="door-angle-field">
        <span>Góc cửa</span>
        <output>{formatAngle(draftAngle)}</output>
        <input
          aria-valuetext={formatAngle(draftAngle)}
          disabled={actionState === 'loading' || !canOpenDoor}
          max="180"
          min="0"
          onChange={(event) => {
            const nextAngle = Number(event.target.value)
            setDraftAngle(nextAngle)
            onPreviewAngle(nextAngle)
          }}
          step="1"
          type="range"
          value={draftAngle}
        />
      </label>

      <label className="door-sensor-field">
        <span>Trạng thái cảm biến</span>
        <select
          disabled={actionState === 'loading'}
          onChange={(event) => setDraftSensor(event.target.value as SensorState)}
          value={draftSensor}
        >
          <option value="ready">Sẵn sàng</option>
          <option value="calibrating">Đang hiệu chuẩn</option>
          <option value="fault">Lỗi cảm biến</option>
        </select>
      </label>

      <div className="door-position-actions">
        <button className="button button--quiet" disabled={actionState === 'loading'} onClick={() => void apply(0, 'ready')} type="button">
          Đóng cửa · 0°
        </button>
        <button
          className="button button--quiet"
          disabled={actionState === 'loading' || !canOpenDoor}
          onClick={() => void apply(90, 'ready')}
          title={canOpenDoor ? 'Mô phỏng mở cánh cửa' : 'Nhập đúng PIN và chờ mở khóa trước'}
          type="button"
        >
          Mở cửa · 90°
        </button>
        <button className="button button--primary" disabled={actionState === 'loading' || openingDraftIsBlocked} onClick={() => void apply()} type="button">
          {actionState === 'loading' ? 'Đang áp dụng…' : 'Áp dụng tín hiệu'}
        </button>
      </div>
      {!canOpenDoor && (
        <p className="notice notice--warning">Cửa đang khóa. Nhập đúng PIN trên bàn phím và chờ servo mở khóa trước khi mở cửa.</p>
      )}
      <p aria-live="polite" className="control-feedback" role={actionState === 'error' ? 'alert' : 'status'}>{feedback}</p>
    </section>
  )
}

const readInstanceProperty = (
  device: SimulatedDevice,
  instance: CapabilityInstance | undefined,
  propertyId: string,
): unknown => {
  const property = instance?.properties.find((candidate) => candidate.id === propertyId)
  return instance && property
    ? readPropertyValue(device.state_snapshot, instance.instance_id, property)
    : null
}

const normalizeSensorState = (value: unknown): SensorState =>
  value === 'calibrating' || value === 'fault' ? value : 'ready'

const lockLabel = (value: string): string => ({
  locked: 'Đã khóa',
  unlocking: 'Đang mở khóa',
  unlocked: 'Đã mở khóa',
  locking: 'Đang khóa',
  fault: 'Lỗi servo',
}[value] || 'Chưa xác định')

const doorLabel = (value: string): string => ({
  closed: 'Đã đóng',
  opening: 'Đang mở',
  open: 'Đã mở',
  closing: 'Đang đóng',
  unknown: 'Chưa xác định',
}[value] || formatValue(value))

const sensorLabel = (value: SensorState): string => ({
  ready: 'Sẵn sàng',
  calibrating: 'Đang hiệu chuẩn',
  fault: 'Đang lỗi',
}[value])

const phaseLabel = (value?: EntranceRuntimeStatus['phase']): string => ({
  idle: 'Đang chờ',
  pin_entry: 'Đang nhập PIN',
  unlocking: 'Servo đang mở khóa',
  unlocked_wait_open: 'Chờ mở cửa',
  door_open: 'Cửa đang mở',
  closed_wait_relock: 'Chờ tự khóa',
  locking: 'Servo đang khóa',
  sensor_fault: 'Chờ cảm biến an toàn',
  pin_locked_out: 'Bàn phím tạm khóa',
}[value || 'idle'])

const formatAngle = (value: number): string => `${Math.round(value * 10) / 10}°`

const keypadAriaLabel = (key: string): string => ({
  A: 'Bắt đầu mở khóa',
  D: 'Xác nhận góc cửa đóng khi hiệu chuẩn',
  '*': 'Xóa hoặc hủy',
  '#': 'Xác nhận mã PIN',
}[key] || `Phím ${key}`)
