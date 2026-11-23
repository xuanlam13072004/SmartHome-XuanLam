/* Hallmark · component: virtual security camera workbench · genre: modern-minimal · theme: Coral
 * states: default · starting · running · stopping · error · empty
 * contrast: token-bound
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { fetchCameraSegment, fetchCameraStatus } from '../../api'
import { webcamCapture, webcamCaptureSupported, type CaptureSnapshot } from '../../camera/webcam-capture'
import type { CameraSegment, CameraStatus, CapabilityInstance, SimulatedDevice } from '../../types'

const CAMERA_STATE_LABELS: Record<string, string> = {
  offline: 'Mất kết nối',
  idle: 'Có hình, chờ người xem',
  streaming: 'Đang phát trực tiếp',
  unavailable: 'Chưa có nguồn hình',
  fault: 'Lỗi',
}

const RECORDING_STATE_LABELS: Record<string, string> = {
  recording: 'Đang ghi',
  stopped: 'Không ghi',
  waiting_time_sync: 'Chờ đồng bộ giờ',
  fault: 'Lỗi ghi',
}

export function SecurityCameraWorkbench({
  device,
  instances,
  wifiControl,
}: {
  device: SimulatedDevice
  instances: CapabilityInstance[]
  wifiControl: ReactNode
}) {
  const camera = instances.find((instance) => instance.capability_id === 'camera_stream')
  const recording = instances.find((instance) => instance.capability_id === 'video_recording')
  const [capture, setCapture] = useState<CaptureSnapshot>(webcamCapture.current)
  const [status, setStatus] = useState<CameraStatus | null>(null)
  const [segments, setSegments] = useState<CameraSegment[]>([])
  const [statusError, setStatusError] = useState('')
  const [actionError, setActionError] = useState('')
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null)
  const [loadingSegment, setLoadingSegment] = useState('')
  const previewRef = useRef<HTMLVideoElement | null>(null)
  const supported = webcamCaptureSupported()
  const ownsCapture = capture.mac === device.mac
  const otherCamera = capture.mac && capture.mac !== device.mac
    && (capture.state === 'running' || capture.state === 'starting')

  useEffect(() => webcamCapture.subscribe(setCapture), [])

  useEffect(() => {
    const video = previewRef.current
    if (!video) return
    const stream = ownsCapture ? capture.stream : null
    if (video.srcObject !== stream) video.srcObject = stream
  }, [capture.stream, ownsCapture])

  const loadStatus = useCallback(async () => {
    try {
      const result = await fetchCameraStatus(device.mac)
      setStatus(result.status)
      setSegments(result.segments)
      setStatusError('')
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Không đọc được trạng thái camera ảo.')
    }
  }, [device.mac])

  useEffect(() => {
    void loadStatus()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadStatus()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [loadStatus])

  useEffect(() => () => {
    if (playing) URL.revokeObjectURL(playing.url)
  }, [playing])

  const start = async (force = false) => {
    setActionError('')
    try {
      await webcamCapture.start(device.mac, force)
      window.setTimeout(() => void loadStatus(), 1500)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Không bật được webcam.')
    }
  }

  const stop = async () => {
    setActionError('')
    await webcamCapture.stop()
    window.setTimeout(() => void loadStatus(), 800)
  }

  const play = async (segment: CameraSegment) => {
    setLoadingSegment(segment.id)
    try {
      const blob = await fetchCameraSegment(device.mac, segment.id)
      setPlaying({ id: segment.id, url: URL.createObjectURL(blob) })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Không mở được bản ghi.')
    } finally {
      setLoadingSegment('')
    }
  }

  const cameraState = String(reported(device, camera, 'camera_state') ?? 'unavailable')
  const recordingState = String(reported(device, recording, 'recording_state') ?? 'stopped')
  const running = ownsCapture && capture.state === 'running'
  const busy = ownsCapture && (capture.state === 'starting' || capture.state === 'stopping')
  const captureError = ownsCapture && capture.state === 'error' ? capture.error : null
  const usage = status?.storage
  const usedPercent = usage && usage.total_bytes > 0
    ? Math.min(100, Math.round((usage.store_used_bytes / usage.total_bytes) * 100))
    : 0

  return (
    <div className="camera-workbench">
      <header className="work-panel__heading work-panel__heading--page">
        <div>
          <h3>Camera an ninh ảo</h3>
          <p>Webcam và micro của máy tính đóng vai cảm biến hình ảnh. Camera ảo tự ghi liên tục vào thẻ nhớ ảo và trả lời hệ thống chính qua MQTT như camera thật.</p>
        </div>
        <span className="state-version">State v{device.state_snapshot?.state_version ?? 0}</span>
      </header>

      {wifiControl}

      <div className="camera-workbench__layout">
        <section className="camera-workbench__sensor" aria-label="Nguồn hình">
          <div className={`camera-screen${running ? ' camera-screen--live' : ''}`}>
            <video ref={previewRef} autoPlay muted playsInline aria-label="Xem trước webcam" />
            {!running && (
              <div className="camera-screen__empty">
                <span>{busy ? 'ĐANG BẬT WEBCAM…' : 'CHƯA CÓ NGUỒN HÌNH'}</span>
                <small>{otherCamera ? `Webcam đang dùng cho ${capture.mac}` : 'Bấm "Bật webcam và micro" để camera ảo có hình.'}</small>
              </div>
            )}
            {running && <span className="camera-screen__badge">REC · {capture.resolution}</span>}
          </div>

          <div className="camera-workbench__actions">
            {running ? (
              <button className="button button--danger" disabled={busy} onClick={() => void stop()} type="button">
                Tắt webcam
              </button>
            ) : (
              <button
                className="button button--primary"
                data-state={busy ? 'loading' : 'default'}
                disabled={!supported || busy}
                onClick={() => void start(false)}
                type="button"
              >
                Bật webcam và micro
              </button>
            )}
            {(otherCamera || captureError?.includes('Chiếm webcam')) && (
              <button className="button" disabled={busy} onClick={() => void start(true)} type="button">
                Chiếm webcam
              </button>
            )}
          </div>

          {!supported && (
            <p className="camera-workbench__note camera-workbench__note--error" role="alert">
              Trình duyệt này chưa hỗ trợ mã hóa WebCodecs. Hãy mở dashboard bằng Chrome hoặc Edge bản mới.
            </p>
          )}
          {(captureError || actionError) && (
            <p className="camera-workbench__note camera-workbench__note--error" role="alert">{captureError || actionError}</p>
          )}
          {ownsCapture && capture.audioNote && <p className="camera-workbench__note">{capture.audioNote}</p>}
          <p className="camera-workbench__note">
            Giữ tab dashboard này mở. Đóng tab hoặc tắt webcam thì camera ảo về trạng thái “chưa có nguồn hình” sau vài giây và ngừng ghi; bản ghi cũ vẫn còn.
          </p>
        </section>

        <aside className="camera-workbench__side">
          <dl className="spec-sheet">
            <div><dt>Trạng thái camera</dt><dd>{CAMERA_STATE_LABELS[cameraState] || cameraState}</dd></div>
            <div><dt>Ghi hình</dt><dd>{RECORDING_STATE_LABELS[recordingState] || recordingState}</dd></div>
            <div><dt>Độ phân giải</dt><dd>{status?.video_resolution || (running ? capture.resolution : '—')}</dd></div>
            <div><dt>Micro</dt><dd>{status?.source_active ? (status.audio ? 'Có tiếng (AAC 48 kHz)' : 'Không tiếng') : '—'}</dd></div>
            <div><dt>Tốc độ gửi</dt><dd>{running ? `${capture.sentKbps.toLocaleString('vi-VN')} kbps` : '—'}</dd></div>
            <div><dt>Thế hệ chủ sở hữu</dt><dd className="mono">{status?.generation ? status.generation.slice(0, 8) : 'Chưa nhận'}</dd></div>
          </dl>

          <section className="camera-storage" aria-label="Thẻ nhớ ảo">
            <header>
              <h4>Thẻ nhớ ảo</h4>
              <span>{usage ? `${formatBytes(usage.used_bytes)} của camera này` : '—'}</span>
            </header>
            <div className="camera-storage__bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPercent} aria-label="Dung lượng toàn kho Simulator">
              <span style={{ width: `${usedPercent}%` }} />
            </div>
            <p>
              Toàn kho Simulator: {usage ? `${formatBytes(usage.store_used_bytes)} / ${formatBytes(usage.total_bytes)}` : '—'}.
              Đầy thì tự xóa phút cũ nhất.
            </p>
            {usage?.oldest_recording_at && (
              <p>Từ {formatTime(usage.oldest_recording_at)} đến {formatTime(usage.newest_recording_at)}</p>
            )}
          </section>
          {statusError && <p className="camera-workbench__note camera-workbench__note--error">{statusError}</p>}
        </aside>
      </div>

      <section className="camera-recordings" aria-label="Bản ghi">
        <header className="work-panel__heading">
          <div>
            <h3>Bản ghi trên thẻ</h3>
            <p>Mỗi dòng là một file 1 phút (H.264 + AAC, fMP4). Đây là công cụ quản trị; app người dùng xem qua máy chủ media ở bước sau.</p>
          </div>
          <span className="state-version">{segments.length} file</span>
        </header>
        {playing && (
          <div className="camera-player">
            <video controls autoPlay src={playing.url} aria-label={`Bản ghi ${playing.id}`} />
            <button className="button button--quiet button--compact" onClick={() => setPlaying(null)} type="button">Đóng</button>
          </div>
        )}
        {segments.length === 0 ? (
          <p className="camera-workbench__note">Chưa có bản ghi. Bật webcam, sau khoảng 2 giây camera ảo bắt đầu ghi.</p>
        ) : (
          <ol className="camera-recordings__list">
            {segments.slice(0, 60).map((segment) => (
              <li key={segment.id} data-active={playing?.id === segment.id || undefined}>
                <span className="mono">{formatTime(segment.start)} → {formatClock(segment.end)}</span>
                <span>{formatBytes(segment.size)}</span>
                <button
                  className="button button--compact"
                  data-state={loadingSegment === segment.id ? 'loading' : 'default'}
                  disabled={Boolean(loadingSegment)}
                  onClick={() => void play(segment)}
                  type="button"
                >
                  Xem
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

const reported = (device: SimulatedDevice, instance: CapabilityInstance | undefined, property: string): unknown =>
  instance ? device.state_snapshot?.instances?.[instance.instance_id]?.reported?.[property] : undefined

const formatBytes = (value: number) => {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

const formatTime = (value: string | null) => value
  ? new Date(value).toLocaleString('vi-VN', { hour12: false })
  : '—'

const formatClock = (value: string) => new Date(value).toLocaleTimeString('vi-VN', { hour12: false })
