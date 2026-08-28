import type { Project } from '@shared/types'
import { assetOf, projectDuration, sourceTime } from '@shared/timeline'
import { scheduleTimeline } from './audio'
import type { Compositor } from './compositor'
import { FrameCache } from './frame-cache'
import { MediaManager } from './media'
import { activeVideoClips, renderFrame } from './renderer'

const PREFETCH_FRAMES = 30
const PREFETCH_IDLE_MS = 250

/**
 * Drives preview: an AudioContext clock during playback (video elements are
 * kept in sync with it), exact seeks + frame cache when paused.
 */
export class Player {
  playing = false
  time = 0
  private audioCtx?: AudioContext
  private master?: GainNode
  private nodes: AudioBufferSourceNode[] = []
  private startCtxTime = 0
  private startTlTime = 0
  private raf = 0
  private renderBusy = false
  private renderQueued: number | null = null
  private prefetchTimer = 0
  private prefetchGen = 0
  private listeners = new Set<(t: number, playing: boolean) => void>()
  readonly cache = new FrameCache(120)
  private projectVersion = -1
  private project: Project

  constructor(
    public comp: Compositor,
    public media: MediaManager,
    private getProject: () => { project: Project; version: number },
  ) {
    this.project = getProject().project
  }

  onTime(cb: (t: number, playing: boolean) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  private emit(): void {
    for (const l of this.listeners) l(this.time, this.playing)
  }

  private refreshProject(): void {
    const { project, version } = this.getProject()
    this.project = project
    if (version !== this.projectVersion) {
      this.projectVersion = version
      this.cache.invalidate(version)
      this.prefetchGen++
    }
  }

  /** Called by the UI whenever the project changes; re-renders the current frame. */
  projectChanged(): void {
    this.refreshProject()
    if (this.playing) {
      // Reschedule audio from the current position.
      const t = this.time
      this.stopAudio()
      this.startAudio(t)
    } else void this.renderAt(this.time)
  }

  private ensureAudio(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: this.project.settings.sampleRate, latencyHint: 'interactive' })
      this.master = this.audioCtx.createGain()
      this.master.connect(this.audioCtx.destination)
    }
    return this.audioCtx
  }

  private async startAudio(from: number): Promise<void> {
    const ctx = this.ensureAudio()
    if (ctx.state === 'suspended') await ctx.resume()
    const buffers = new Map<string, AudioBuffer>()
    const wanted = new Set<string>()
    for (const t of this.project.tracks)
      if (t.kind === 'audio' && !t.muted) for (const c of t.clips) if (c.start + c.duration > from) wanted.add(c.assetId)
    await Promise.all(
      [...wanted].map(async (id) => {
        const p = this.media.audioBuffer(id, ctx)
        if (p) buffers.set(id, await p.catch(() => undefined as unknown as AudioBuffer))
      }),
    )
    for (const [k, v] of buffers) if (!v) buffers.delete(k)
    if (!this.playing) return
    // Anchor the clock to the moment audio actually starts.
    const at = ctx.currentTime + 0.05
    this.startCtxTime = at
    this.startTlTime = from
    this.nodes = scheduleTimeline(ctx, this.master!, this.project, buffers, from, at)
  }

  private stopAudio(): void {
    for (const n of this.nodes) {
      try {
        n.stop()
      } catch {
        /* already stopped */
      }
    }
    this.nodes = []
  }

  async play(from = this.time): Promise<void> {
    if (this.playing) return
    this.refreshProject()
    this.cancelPrefetch()
    const duration = projectDuration(this.project)
    if (from >= duration) from = 0
    this.playing = true
    this.time = from
    this.emit()
    // Pre-roll video decoders to the start position before the clock starts.
    await renderFrame(this.comp, this.media, this.project, from, { seek: true, tolerance: 0.02 })
    if (!this.playing) return
    await this.startAudio(from)
    if (!this.playing) return
    this.raf = requestAnimationFrame(this.tick)
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    cancelAnimationFrame(this.raf)
    this.stopAudio()
    this.media.pauseAll()
    // Snap to a frame boundary so stepping is exact.
    const fps = this.project.settings.fps
    this.time = Math.round(this.time * fps) / fps
    this.emit()
    void this.renderAt(this.time)
  }

  toggle(): void {
    if (this.playing) this.pause()
    else void this.play()
  }

  seek(t: number): void {
    const wasPlaying = this.playing
    if (wasPlaying) this.pause()
    this.time = Math.max(0, t)
    this.emit()
    if (wasPlaying) void this.play(this.time)
    else void this.renderAt(this.time)
  }

  private tick = (): void => {
    if (!this.playing) return
    const ctx = this.audioCtx!
    const now = ctx.currentTime
    this.time = this.startTlTime + Math.max(0, now - this.startCtxTime)
    const duration = projectDuration(this.project)
    if (this.time >= duration) {
      this.time = duration
      this.pause()
      return
    }
    this.syncVideos()
    this.emit()
    if (!this.renderBusy) {
      this.renderBusy = true
      renderFrame(this.comp, this.media, this.project, this.time, { seek: false, tolerance: 0.1 }).finally(() => (this.renderBusy = false))
    }
    this.raf = requestAnimationFrame(this.tick)
  }

  /** Keep <video> elements running in lock-step with the audio clock. */
  private syncVideos(): void {
    const items = activeVideoClips(this.project, this.time, 1.5)
    const active = new Set<string>()
    for (const { clip, active: isActive } of items) {
      const asset = assetOf(this.project, clip)
      if (!asset || asset.kind !== 'video') continue
      const v = this.media.video(clip.id, asset.id)
      if (!v) continue
      const target = sourceTime(clip, asset, this.time)
      if (isActive) {
        active.add(clip.id)
        if (v.playbackRate !== clip.speed) v.playbackRate = Math.min(16, Math.max(0.0625, clip.speed))
        const drift = v.currentTime - target
        if (Math.abs(drift) > 0.12 && !v.seeking) v.currentTime = target
        if (v.paused && v.readyState >= 2) void v.play().catch(() => undefined)
      } else {
        // Pre-roll: park the decoder on the first frame the clip will show.
        if (!v.paused) v.pause()
        if (!v.seeking && Math.abs(v.currentTime - target) > 0.05 && v.readyState >= 1) v.currentTime = target
      }
    }
    this.media.pauseExcept(active)
  }

  /**
   * Paused render: serve from the frame cache when possible. Calls coalesce —
   * only the most recently requested time is rendered — and the returned
   * promise resolves once that latest frame is on screen.
   */
  renderAt(t: number): Promise<void> {
    this.renderQueued = t
    this.cancelPrefetch()
    if (!this.renderLoop) {
      this.renderLoop = (async () => {
        let lastFrame = 0
        while (this.renderQueued !== null && !this.playing) {
          const q = this.renderQueued
          this.renderQueued = null
          lastFrame = await this.renderOnce(q)
        }
        this.renderLoop = null
        if (!this.playing) this.schedulePrefetch(lastFrame)
      })()
    }
    return this.renderLoop
  }
  private renderLoop: Promise<void> | null = null

  private async renderOnce(t: number): Promise<number> {
    this.refreshProject()
    const fps = this.project.settings.fps
    const frame = Math.round(t * fps)
    const cached = this.cache.get(frame)
    // Let an in-flight prefetch draw finish so it can't paint over this frame.
    while (this.renderBusy) await new Promise((r) => setTimeout(r, 4))
    if (cached) {
      this.comp.drawBitmap(cached)
      return frame
    }
    this.renderBusy = true
    try {
      await renderFrame(this.comp, this.media, this.project, frame / fps, { seek: true, tolerance: 0.5 / fps })
      if (this.cache.version === this.projectVersion) {
        const bmp = await createImageBitmap(this.comp.canvas as HTMLCanvasElement)
        this.cache.set(frame, bmp)
      }
    } catch (err) {
      console.error(`render failed: ${(err as Error).name}: ${(err as Error).message}`, (err as Error).stack)
    } finally {
      this.renderBusy = false
    }
    return frame
  }

  private schedulePrefetch(frame: number): void {
    clearTimeout(this.prefetchTimer)
    const gen = ++this.prefetchGen
    this.prefetchTimer = window.setTimeout(() => void this.prefetch(frame, gen), PREFETCH_IDLE_MS)
  }

  private cancelPrefetch(): void {
    clearTimeout(this.prefetchTimer)
    this.prefetchGen++
  }

  /** While idle, composite upcoming frames into the cache so stepping is instant. */
  private async prefetch(fromFrame: number, gen: number): Promise<void> {
    const fps = this.project.settings.fps
    const total = Math.ceil(projectDuration(this.project) * fps)
    for (let f = fromFrame + 1; f <= Math.min(total, fromFrame + PREFETCH_FRAMES); f++) {
      if (gen !== this.prefetchGen || this.playing || this.renderBusy || this.renderLoop) return
      if (this.cache.has(f)) continue
      this.renderBusy = true
      try {
        await renderFrame(this.comp, this.media, this.project, f / fps, { seek: true, tolerance: 0.5 / fps })
        if (gen !== this.prefetchGen) break
        this.cache.set(f, await createImageBitmap(this.comp.canvas as HTMLCanvasElement))
      } catch {
        break
      } finally {
        this.renderBusy = false
      }
      // Put the real current frame back on screen.
      const cur = this.cache.get(fromFrame)
      if (cur) this.comp.drawBitmap(cur)
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  dispose(): void {
    this.pause()
    this.cancelPrefetch()
    this.cache.dispose()
    void this.audioCtx?.close()
  }
}
