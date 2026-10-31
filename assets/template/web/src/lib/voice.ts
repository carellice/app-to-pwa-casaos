/** Records 16 kHz mono PCM, the format Whisper works on, and wraps it in a WAV container (VoiceRecorder). */
export class VoiceRecorder {
  static RATE = 16_000
  private chunks: Float32Array[] = []
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private stopResolve: ((wav: Blob) => void) | null = null
  onLevel: (level: number) => void = () => {}

  /** Resolves when [stop] is called or [maxSeconds] pass. */
  async record(maxSeconds = 120): Promise<Blob> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch {
      throw new Error('Per i vocali serve il permesso del microfono')
    }
    this.context = new AudioContext({ sampleRate: VoiceRecorder.RATE })
    const source = this.context.createMediaStreamSource(this.stream)
    const processor = this.context.createScriptProcessor(4096, 1, 1)
    this.chunks = []
    processor.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0))
      this.chunks.push(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v))
      this.onLevel(Math.min(1, peak))
      if (this.samples() >= VoiceRecorder.RATE * maxSeconds) this.stop()
    }
    source.connect(processor)
    processor.connect(this.context.destination)
    return new Promise((resolve) => { this.stopResolve = resolve })
  }

  private samples() {
    return this.chunks.reduce((acc, c) => acc + c.length, 0)
  }

  stop() {
    const resolve = this.stopResolve
    if (!resolve) return
    this.stopResolve = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.context?.close()
    this.onLevel(0)
    resolve(this.wav())
  }

  private wav(): Blob {
    const length = this.samples()
    const buffer = new ArrayBuffer(44 + length * 2)
    const view = new DataView(buffer)
    const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
    const rate = this.context?.sampleRate ?? VoiceRecorder.RATE
    text(0, 'RIFF')
    view.setUint32(4, 36 + length * 2, true)
    text(8, 'WAVE')
    text(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    text(36, 'data')
    view.setUint32(40, length * 2, true)
    let offset = 44
    for (const chunk of this.chunks) {
      for (const v of chunk) {
        view.setInt16(offset, Math.max(-1, Math.min(1, v)) * 0x7fff, true)
        offset += 2
      }
    }
    return new Blob([buffer], { type: 'audio/wav' })
  }

  /** Seconds of audio in a WAV produced by [record]. */
  static seconds(wav: Blob): number {
    return Math.max(0, Math.floor((wav.size - 44) / (VoiceRecorder.RATE * 2)))
  }
}
