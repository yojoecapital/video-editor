import type { Project } from '@shared/types'
import { assetOf, clipEnd, projectDuration, sourceTime } from '@shared/timeline'
import { volumeAt } from './audio'
import type { Compositor } from './compositor'
import { FrameCache } from './frame-cache'
import { MediaManager } from './media'
import { activeVideoClips, renderFrame } from './renderer'

const PREFETCH_FRAMES = 30
const PREFETCH_IDLE_MS = 250
const AUDIO_RESUME_TIMEOUT_MS = 1500
const AUDIO_LOOKAHEAD = 1.5

export interface PlayerDebug {
  time: number
  playing: boolean
  audioState: string
  liveNodes: number
  ticks: number
  /** Average milliseconds per tick spent in sync, React emit, and GPU render. */
  perf: { sync: number; emit: number; render: number }
  videos: Array<{ clipId: string; currentTime: number; paused: boolean; readyState: number; seeking: boolean }>
  audios: Array<{ clipId: string; currentTime: number; paused: boolean; readyState: number }>
}

/**
 * Drives preview. The master clock is performance.now() so playback never
 * depends on the audio device. Audio clips play through streaming <audio>
 * elements routed via per-clip GainNodes (volume keyframes + transitions),
 * kept in lock-step with the clock exactly like the <video> elements.
 * Paused, frames are rendered with exact seeks and served from a cache.
 */
export class Player {
  playing = false
  time = 0
  private audioCtx?: AudioContext
  private master?: GainNode
  /** Per audio element: the MediaElementSource (creatable only once) and its gain. */
  private audioGraph = new WeakMap<HTMLMediaElement, { src: MediaElementAudioSourceNode; gain: GainNode }>()
  private playingAudio = new Set<string>()
  /** Incremented by every play()/pause()/seek(); async work checks it before acting. */
  private playGen = 0
  private clockStart = 0
  private clockTl = 0
  private watchdog = 0
  private ticks = 0
  private lastTickAt = 0
  private perf = { sync: 0, emit: 0, render: 0, n: 0 }
  private renderBusy = false
  private renderQueued: number | null = null
  private renderLoop: Promise<void> | null = null
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
    if (!this.playing) void this.renderAt(this.time)
  }

  /* ---------------------------------- Audio ---------------------------------- */

  private ensureAudio(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: this.project.settings.sampleRate, latencyHint: 'interactive' })
      this.master = this.audioCtx.createGain()
      this.master.connect(this.audioCtx.destination)
    }
    return this.audioCtx
  }

  private async resumeAudio(gen: number): Promise<void> {
    const ctx = this.ensureAudio()
    if (ctx.state !== 'running') {
      await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, AUDIO_RESUME_TIMEOUT_MS))])
    }
    if (gen !== this.playGen) return
  }

  private graphFor(el: HTMLMediaElement): { src: MediaElementAudioSourceNode; gain: GainNode } {
    let g = this.audioGraph.get(el)
    if (!g) {
      const ctx = this.ensureAudio()
      const src = ctx.createMediaElementSource(el)
      const gain = ctx.createGain()
      src.connect(gain).connect(this.master!)
      g = { src, gain }
      this.audioGraph.set(el, g)
    }
    return g
  }

  /** Keep <audio> elements running in lock-step with the clock; gain follows keyframes/transitions. */
  private syncAudio(): void {
    const active = new Set<string>()
    const ctx = this.audioCtx
    for (const track of this.project.tracks) {
      if (track.kind !== 'audio' || track.muted) continue
      for (const clip of track.clips) {
        const asset = assetOf(this.project, clip)
        if (!asset) continue
        const end = clipEnd(clip)
        const isActive = this.time >= clip.start && this.time < end
        const upcoming = !isActive && clip.start > this.time && clip.start - this.time < AUDIO_LOOKAHEAD
        if (!isActive && !upcoming) continue
        const el = this.media.audioElement(clip.id, asset.id)
        if (!el) continue
        const { gain } = this.graphFor(el)
        const target = sourceTime(clip, asset, this.time)
        if (isActive) {
          active.add(clip.id)
          const rate = Math.min(16, Math.max(0.0625, clip.speed))
          if (el.playbackRate !== rate) el.playbackRate = rate
          if (Math.abs(el.currentTime - target) > 0.15 && !el.seeking) el.currentTime = target
          if (el.paused && el.readyState >= 2) void el.play().catch(() => undefined)
          const v = volumeAt(track, clip, this.time)
          if (ctx) gain.gain.setTargetAtTime(v, ctx.currentTime, 0.01)
          else gain.gain.value = v
        } else {
          const first = sourceTime(clip, asset, clip.start)
          if (!el.paused) el.pause()
          if (!el.seeking && Math.abs(el.currentTime - first) > 0.05 && el.readyState >= 1) el.currentTime = first
        }
      }
    }
    this.media.pauseAudioExcept(active)
    this.playingAudio = active
  }

  private stopAudio(): void {
    this.media.pauseAll()
    this.playingAudio.clear()
  }

  /* -------------------------------- Transport -------------------------------- */

  async play(from = this.time): Promise<void> {
    if (this.playing) return
    this.refreshProject()
    this.cancelPrefetch()
    const gen = ++this.playGen
    const duration = projectDuration(this.project)
    if (from >= duration) from = 0
    this.playing = true
    this.time = from
    this.emit()
    // Pre-roll video decoders to the start position before the clock starts.
    try {
      await renderFrame(this.comp, this.media, this.project, from, { seek: true, tolerance: 0.02 })
    } catch (err) {
      console.error('pre-roll failed', err)
    }
    if (gen !== this.playGen || !this.playing) return
    this.clockStart = performance.now()
    this.clockTl = from
    void this.resumeAudio(gen)
    this.lastTickAt = performance.now()
    // Timer-driven, not rAF: Chromium throttles rAF for occluded/unfocused
    // windows, which would stall the clock. Cap at 60 Hz or the project rate.
    clearInterval(this.watchdog)
    this.watchdog = window.setInterval(this.tick, Math.max(1000 / 60, 1000 / this.project.settings.fps))
  }

  pause(): void {
    if (!this.playing) return
    this.playGen++
    this.playing = false
    clearInterval(this.watchdog)
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
    this.ticks++
    this.lastTickAt = performance.now()
    this.time = this.clockTl + (performance.now() - this.clockStart) / 1000
    const duration = projectDuration(this.project)
    if (this.time >= duration) {
      this.time = duration
      this.pause()
      return
    }
    const t0 = performance.now()
    try {
      this.syncVideos()
      this.syncAudio()
    } catch (err) {
      // Never let a media-element hiccup kill the playback loop.
      console.error(`sync failed: ${(err as Error).name}: ${(err as Error).message}`)
    }
    const t1 = performance.now()
    this.emit()
    const t2 = performance.now()
    if (!this.renderBusy) {
      this.renderBusy = true
      const r0 = performance.now()
      renderFrame(this.comp, this.media, this.project, this.time, { seek: false, tolerance: 0.1 })
        .catch((err) => console.error('render failed', err))
        .finally(() => {
          this.renderBusy = false
          this.perf.render += performance.now() - r0
        })
    }
    this.perf.sync += t1 - t0
    this.perf.emit += t2 - t1
    this.perf.n++
  }

  /** Keep <video> elements running in lock-step with the clock. */
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
        const rate = Math.min(16, Math.max(0.0625, clip.speed))
        if (v.playbackRate !== rate) v.playbackRate = rate
        const drift = v.currentTime - target
        if (Math.abs(drift) > 0.15 && !v.seeking) v.currentTime = target
        if (v.paused && v.readyState >= 2) void v.play().catch(() => undefined)
      } else {
        // Pre-roll: park the decoder on the first frame the clip will show.
        const first = sourceTime(clip, asset, clip.start)
        if (!v.paused) v.pause()
        if (!v.seeking && Math.abs(v.currentTime - first) > 0.05 && v.readyState >= 1) v.currentTime = first
      }
    }
    this.media.pauseExcept(active)
  }

  /* ------------------------------ Paused render ------------------------------ */

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

  debug(): PlayerDebug {
    return {
      time: this.time,
      playing: this.playing,
      audioState: this.audioCtx?.state ?? 'none',
      liveNodes: this.media.debugAudios().filter((a) => !a.paused).length,
      ticks: this.ticks,
      perf: {
        sync: this.perf.n ? this.perf.sync / this.perf.n : 0,
        emit: this.perf.n ? this.perf.emit / this.perf.n : 0,
        render: this.perf.n ? this.perf.render / this.perf.n : 0,
      },
      videos: this.media.debugVideos(),
      audios: this.media.debugAudios(),
    }
  }

  dispose(): void {
    this.pause()
    this.cancelPrefetch()
    this.cache.dispose()
    void this.audioCtx?.close()
  }
}
