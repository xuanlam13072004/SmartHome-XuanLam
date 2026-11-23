import { ApiError, sendCameraChunks, startCameraSource, stopCameraSource } from '../api'

/**
 * Webcam + microphone as the virtual camera "sensor" (camera contract §9).
 *
 * Encodes with WebCodecs (H.264 + AAC-LC, keyframe every 2 s) and streams the
 * encoded chunks to the Simulator backend, which plays the camera firmware
 * (packaging, 24/7 recording, MQTT). One page holds the webcam for one
 * virtual camera at a time; the session lives at module level so moving
 * between dashboard screens does not stop it. Closing the tab does.
 */

interface TrackProcessor<T> {
  readable: ReadableStream<T>
}
type TrackProcessorConstructor = new <T>(init: { track: MediaStreamTrack }) => TrackProcessor<T>

const processorConstructor = (): TrackProcessorConstructor | undefined =>
  (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorConstructor }).MediaStreamTrackProcessor

export type CaptureState = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

export interface CaptureSnapshot {
  state: CaptureState
  mac: string | null
  stream: MediaStream | null
  resolution: string | null
  framerate: number | null
  audio: boolean
  audioNote: string | null
  sentKbps: number
  error: string | null
}

interface PendingChunk {
  kind: 1 | 2
  keyframe: boolean
  timestampUs: number
  durationUs: number
  data: Uint8Array
}

const KEYFRAME_INTERVAL_US = 2_000_000
const SEND_INTERVAL_MS = 500
const MAX_QUEUE_BYTES = 32 * 1024 * 1024
const AAC_SAMPLE_RATES = [48000, 44100, 32000, 16000]

export const webcamCaptureSupported = (): boolean =>
  typeof window !== 'undefined'
  && 'VideoEncoder' in window
  && 'AudioEncoder' in window
  && Boolean(processorConstructor())
  && Boolean(navigator.mediaDevices?.getUserMedia)

const toBytes = (source: AllowSharedBufferSource): Uint8Array => {
  const view = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source)
  return new Uint8Array(view) // copy: encoder buffers may be reused
}

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const randomSessionId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const encodeBatch = (chunks: PendingChunk[]): Uint8Array => {
  const size = chunks.reduce((sum, chunk) => sum + 20 + chunk.data.byteLength, 0)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let offset = 0
  for (const chunk of chunks) {
    view.setUint8(offset, chunk.kind)
    view.setUint8(offset + 1, chunk.keyframe ? 1 : 0)
    view.setFloat64(offset + 4, chunk.timestampUs)
    view.setUint32(offset + 12, Math.max(0, Math.round(chunk.durationUs)))
    view.setUint32(offset + 16, chunk.data.byteLength)
    out.set(chunk.data, offset + 20)
    offset += 20 + chunk.data.byteLength
  }
  return out
}

const levelFor = (width: number, height: number) => {
  const pixels = width * height
  if (pixels > 1280 * 720) return '28' // 4.0 for 1080p30
  if (pixels > 720 * 576) return '1F' // 3.1 for 720p30
  return '1E' // 3.0
}

const bitrateFor = (width: number, height: number) => {
  const pixels = width * height
  if (pixels > 1280 * 720) return 5_000_000
  if (pixels > 720 * 576) return 2_500_000
  return 1_200_000
}

class WebcamCapture {
  private snapshot: CaptureSnapshot = {
    state: 'idle', mac: null, stream: null, resolution: null, framerate: null,
    audio: false, audioNote: null, sentKbps: 0, error: null,
  }
  private readonly listeners = new Set<(snapshot: CaptureSnapshot) => void>()
  private sessionId = ''
  private videoEncoder: VideoEncoder | null = null
  private audioEncoder: AudioEncoder | null = null
  private readers: ReadableStreamDefaultReader<unknown>[] = []
  private queue: PendingChunk[] = []
  private queueBytes = 0
  private videoConfig: { codec: string; width: number; height: number; framerate: number } | null = null
  private videoDescription: Uint8Array | null = null
  private audioConfig: { sample_rate: number; channels: number; description?: string } | null | undefined
  private sourceStarted = false
  private startingSource = false
  private sending = false
  private lastSendAt = 0
  private lastKeyframeUs: number | null = null
  private sentBytesWindow: Array<{ at: number; bytes: number }> = []
  private generation = 0
  private force = false

  get current(): CaptureSnapshot {
    return this.snapshot
  }

  subscribe(listener: (snapshot: CaptureSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => { this.listeners.delete(listener) }
  }

  async start(mac: string, force = false): Promise<void> {
    if (!webcamCaptureSupported()) {
      throw new Error('Trình duyệt này chưa hỗ trợ WebCodecs và MediaStreamTrackProcessor. Hãy dùng Chrome hoặc Edge bản mới.')
    }
    if (this.snapshot.state === 'running' || this.snapshot.state === 'starting') await this.stop()
    const generation = ++this.generation
    this.force = force
    this.update({ state: 'starting', mac, error: null, audioNote: null, sentKbps: 0 })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
        audio: { channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 }, echoCancellation: true, noiseSuppression: true },
      })
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.resetPipeline()
      this.sessionId = randomSessionId()
      const videoTrack = stream.getVideoTracks()[0]
      if (!videoTrack) throw new Error('Không tìm thấy webcam.')
      videoTrack.addEventListener('ended', () => void this.stop('Webcam đã bị ngắt.'))
      await this.configureVideo(videoTrack)
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) this.runAudio(audioTrack, generation)
      else {
        this.audioConfig = null
        this.update({ audioNote: 'Không có micro; camera ảo ghi hình không tiếng.' })
      }
      this.runVideo(videoTrack, generation)
      this.update({ state: 'running', stream })
    } catch (error) {
      await this.teardown()
      const message = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Trình duyệt chưa được cấp quyền webcam/micro.'
        : error instanceof Error ? error.message : 'Không bật được webcam.'
      this.update({ state: 'error', error: message, stream: null })
      throw error
    }
  }

  async stop(reason?: string): Promise<void> {
    if (this.snapshot.state === 'idle') return
    this.generation += 1
    const mac = this.snapshot.mac
    const sessionId = this.sessionId
    const wasStarted = this.sourceStarted
    this.update({ state: 'stopping' })
    await this.teardown()
    if (mac && wasStarted) await stopCameraSource(mac, sessionId).catch(() => undefined)
    this.update({
      state: reason ? 'error' : 'idle', stream: null, resolution: null, framerate: null,
      audio: false, sentKbps: 0, error: reason || null, mac: reason ? mac : null,
    })
  }

  private async configureVideo(track: MediaStreamTrack) {
    const settings = track.getSettings()
    const width = Math.min(1920, (settings.width || 1280)) & ~1
    const height = Math.min(1080, (settings.height || 720)) & ~1
    const framerate = Math.min(30, settings.frameRate || 30)
    const level = levelFor(width, height)
    let chosen: VideoEncoderConfig | null = null
    for (const profile of ['42E0', '4D00', '6400']) {
      const config: VideoEncoderConfig = {
        codec: `avc1.${profile}${level}`,
        width,
        height,
        framerate,
        bitrate: bitrateFor(width, height),
        bitrateMode: 'variable',
        latencyMode: 'realtime',
        avc: { format: 'avc' },
      }
      const support = await VideoEncoder.isConfigSupported(config).catch(() => null)
      if (support?.supported) {
        chosen = config
        break
      }
    }
    if (!chosen) throw new Error(`Trình duyệt không mã hóa được H.264 ở ${width}x${height}.`)
    this.videoConfig = { codec: chosen.codec, width, height, framerate }
    this.videoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const description = metadata?.decoderConfig?.description
        if (description && !this.videoDescription) this.videoDescription = toBytes(description)
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        this.enqueue({ kind: 1, keyframe: chunk.type === 'key', timestampUs: chunk.timestamp, durationUs: chunk.duration || 1_000_000 / framerate, data })
        void this.pump()
      },
      error: (error) => void this.stop(`Bộ mã hóa video lỗi: ${error.message}`),
    })
    this.videoEncoder.configure(chosen)
    this.update({ resolution: `${width}x${height}`, framerate: Math.round(framerate) })
  }

  private runVideo(track: MediaStreamTrack, generation: number) {
    const Processor = processorConstructor()!
    const reader = new Processor<VideoFrame>({ track }).readable.getReader()
    this.readers.push(reader as ReadableStreamDefaultReader<unknown>)
    void (async () => {
      while (generation === this.generation) {
        const { value: frame, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
        if (done || !frame) break
        const encoder = this.videoEncoder
        if (!encoder || encoder.state !== 'configured' || encoder.encodeQueueSize > 8) {
          frame.close()
          continue
        }
        const keyFrame = this.lastKeyframeUs === null || frame.timestamp - this.lastKeyframeUs >= KEYFRAME_INTERVAL_US
        if (keyFrame) this.lastKeyframeUs = frame.timestamp
        encoder.encode(frame, { keyFrame })
        frame.close()
      }
    })()
  }

  private runAudio(track: MediaStreamTrack, generation: number) {
    const Processor = processorConstructor()!
    const reader = new Processor<AudioData>({ track }).readable.getReader()
    this.readers.push(reader as ReadableStreamDefaultReader<unknown>)
    void (async () => {
      while (generation === this.generation) {
        const { value: data, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
        if (done || !data) break
        if (this.audioConfig === undefined) await this.configureAudio(data)
        const encoder = this.audioEncoder
        if (encoder && encoder.state === 'configured') encoder.encode(data)
        data.close()
      }
    })()
  }

  private async configureAudio(sample: AudioData) {
    const sampleRate = sample.sampleRate
    const channels = Math.min(2, sample.numberOfChannels)
    const disable = (note: string) => {
      this.audioConfig = null
      this.update({ audio: false, audioNote: note })
    }
    if (!AAC_SAMPLE_RATES.includes(sampleRate)) {
      disable(`Micro dùng ${sampleRate} Hz, chưa hỗ trợ; camera ảo ghi hình không tiếng.`)
      return
    }
    const config: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 96_000 }
    const support = await AudioEncoder.isConfigSupported(config).catch(() => null)
    if (!support?.supported) {
      disable('Trình duyệt không mã hóa được AAC; camera ảo ghi hình không tiếng.')
      return
    }
    let description: string | undefined
    this.audioEncoder = new AudioEncoder({
      output: (chunk, metadata) => {
        const config = metadata?.decoderConfig?.description
        if (config && !description) {
          description = base64(toBytes(config))
          if (this.audioConfig) this.audioConfig.description = description
        }
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        this.enqueue({ kind: 2, keyframe: true, timestampUs: chunk.timestamp, durationUs: chunk.duration || (1024 / sampleRate) * 1_000_000, data })
      },
      error: () => disable('Bộ mã hóa âm thanh lỗi; tiếp tục ghi hình không tiếng.'),
    })
    this.audioEncoder.configure(config)
    this.audioConfig = { sample_rate: sampleRate, channels }
    this.update({ audio: true })
  }

  private enqueue(chunk: PendingChunk) {
    this.queue.push(chunk)
    this.queueBytes += chunk.data.byteLength
    if (this.queueBytes > MAX_QUEUE_BYTES) {
      // The backend is too slow or unreachable: drop and restart from a keyframe.
      this.queue = []
      this.queueBytes = 0
      this.lastKeyframeUs = null
    }
  }

  /** Sends queued chunks; driven by encoder output, so it keeps running in background tabs. */
  private async pump(): Promise<void> {
    const mac = this.snapshot.mac
    if (!mac || this.sending || this.startingSource) return
    if (!this.sourceStarted) {
      // Wait for the H.264 configuration and the audio decision.
      if (!this.videoDescription || !this.videoConfig || this.audioConfig === undefined) return
      if (this.audioConfig && !this.audioConfig.description) {
        // The first AAC packet carries the configuration; give it a moment.
        if (this.queue.filter((chunk) => chunk.kind === 2).length === 0) return
      }
      this.startingSource = true
      try {
        await startCameraSource(mac, {
          session_id: this.sessionId,
          force: this.force,
          video: { ...this.videoConfig, description: base64(this.videoDescription) },
          audio: this.audioConfig ? { codec: 'mp4a.40.2', ...this.audioConfig } : null,
        })
        this.sourceStarted = true
        this.lastSendAt = 0
      } catch (error) {
        this.startingSource = false
        const message = error instanceof ApiError && error.code === 'WEBCAM_IN_USE'
          ? 'Một camera ảo khác đang dùng webcam. Bấm "Chiếm webcam" để chuyển sang camera này.'
          : error instanceof Error ? error.message : 'Backend Simulator từ chối nguồn hình.'
        void this.stop(message)
        return
      }
      this.startingSource = false
    }
    const now = performance.now()
    if (now - this.lastSendAt < SEND_INTERVAL_MS || this.queue.length === 0) return
    this.sending = true
    this.lastSendAt = now
    const batch = this.queue
    this.queue = []
    this.queueBytes = 0
    const body = encodeBatch(batch)
    try {
      await sendCameraChunks(mac, this.sessionId, body)
      this.recordThroughput(body.byteLength)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'CAMERA_SOURCE_INACTIVE') {
        // The backend restarted or the watchdog fired: announce the source again
        // and restart from a keyframe.
        this.sourceStarted = false
        this.lastKeyframeUs = null
      }
    } finally {
      this.sending = false
    }
  }

  private recordThroughput(bytes: number) {
    const now = performance.now()
    this.sentBytesWindow.push({ at: now, bytes })
    this.sentBytesWindow = this.sentBytesWindow.filter((entry) => now - entry.at < 5000)
    const total = this.sentBytesWindow.reduce((sum, entry) => sum + entry.bytes, 0)
    const kbps = Math.round((total * 8) / 5 / 1000)
    if (Math.abs(kbps - this.snapshot.sentKbps) > 50) this.update({ sentKbps: kbps })
  }

  private resetPipeline() {
    this.queue = []
    this.queueBytes = 0
    this.videoDescription = null
    this.videoConfig = null
    this.audioConfig = undefined
    this.sourceStarted = false
    this.startingSource = false
    this.sending = false
    this.lastKeyframeUs = null
    this.sentBytesWindow = []
  }

  private async teardown() {
    for (const reader of this.readers) await reader.cancel().catch(() => undefined)
    this.readers = []
    for (const encoder of [this.videoEncoder, this.audioEncoder]) {
      if (encoder && encoder.state !== 'closed') {
        try { encoder.close() } catch { /* already closed */ }
      }
    }
    this.videoEncoder = null
    this.audioEncoder = null
    this.snapshot.stream?.getTracks().forEach((track) => track.stop())
    this.resetPipeline()
  }

  private update(patch: Partial<CaptureSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener(this.snapshot)
  }
}

export const webcamCapture = new WebcamCapture()
