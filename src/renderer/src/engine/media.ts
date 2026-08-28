import type { Asset } from '@shared/types'

export interface MediaSource {
  videoUrl?: string
  audioUrl?: string
  imageUrl?: string
  thumbnail?: string
  width: number
  height: number
}

/**
 * Owns every decoder-backed object the compositor needs: one <video> per
 * timeline clip (so cuts and transitions can pre-roll independently), decoded
 * images, and decoded AudioBuffers for the mixer. In the editor this points at
 * proxies; the export renderer points it at the originals.
 */
export class MediaManager {
  readonly sources = new Map<string, MediaSource>()
  private videos = new Map<string, HTMLVideoElement>()
  private images = new Map<string, Promise<ImageBitmap>>()
  private audio = new Map<string, Promise<AudioBuffer>>()
  private pending = new Map<string, Promise<MediaSource>>()
  private listeners = new Set<() => void>()

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  private emit(): void {
    for (const l of this.listeners) l()
  }

  setSource(assetId: string, src: MediaSource): void {
    this.sources.set(assetId, src)
    this.images.delete(assetId)
    this.audio.delete(assetId)
    for (const [clipId, v] of this.videos) {
      if (v.dataset.assetId === assetId) {
        v.src = ''
        this.videos.delete(clipId)
      }
    }
    this.emit()
  }

  hasSource(assetId: string): boolean {
    return this.sources.has(assetId)
  }

  /** Generate (or reuse) proxies for an asset and register them. */
  prepare(asset: Asset, cacheDir: string): Promise<MediaSource> {
    const existing = this.pending.get(asset.id)
    if (existing) return existing
    const p = window.api.media
      .proxy(asset, cacheDir)
      .then((info) => {
        const url = window.api.media.url
        const src: MediaSource = {
          width: info.width,
          height: info.height,
          thumbnail: info.thumbnail ? url(info.thumbnail) : undefined,
          videoUrl: asset.kind === 'video' ? url(info.path) : undefined,
          imageUrl: asset.kind === 'image' ? url(info.path) : undefined,
          audioUrl: info.audioPath ? url(info.audioPath) : undefined,
        }
        this.setSource(asset.id, src)
        return src
      })
      .finally(() => this.pending.delete(asset.id))
    this.pending.set(asset.id, p)
    return p
  }

  video(clipId: string, assetId: string): HTMLVideoElement | undefined {
    const src = this.sources.get(assetId)
    if (!src?.videoUrl) return undefined
    let v = this.videos.get(clipId)
    if (!v) {
      v = document.createElement('video')
      v.crossOrigin = 'anonymous'
      v.muted = true
      v.preload = 'auto'
      v.playsInline = true
      v.dataset.assetId = assetId
      v.src = src.videoUrl
      v.load()
      this.videos.set(clipId, v)
    }
    return v
  }

  releaseClip(clipId: string): void {
    const v = this.videos.get(clipId)
    if (v) {
      v.pause()
      v.removeAttribute('src')
      v.load()
      this.videos.delete(clipId)
    }
  }

  /** Drop video elements for clips that no longer exist. */
  retain(clipIds: Set<string>): void {
    for (const id of [...this.videos.keys()]) if (!clipIds.has(id)) this.releaseClip(id)
  }

  image(assetId: string): Promise<ImageBitmap> | undefined {
    const src = this.sources.get(assetId)
    if (!src?.imageUrl) return undefined
    let p = this.images.get(assetId)
    if (!p) {
      p = fetch(src.imageUrl)
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b))
      this.images.set(assetId, p)
    }
    return p
  }

  audioBuffer(assetId: string, ctx: BaseAudioContext): Promise<AudioBuffer> | undefined {
    const src = this.sources.get(assetId)
    if (!src?.audioUrl) return undefined
    let p = this.audio.get(assetId)
    if (!p) {
      p = fetch(src.audioUrl)
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx.decodeAudioData(ab))
      this.audio.set(assetId, p)
    }
    return p
  }

  pauseAll(): void {
    for (const v of this.videos.values()) if (!v.paused) v.pause()
  }

  pauseExcept(clipIds: Set<string>): void {
    for (const [id, v] of this.videos) if (!clipIds.has(id) && !v.paused) v.pause()
  }

  dispose(): void {
    for (const id of [...this.videos.keys()]) this.releaseClip(id)
    this.images.clear()
    this.audio.clear()
  }
}

/** Seek a video and resolve once a frame at that time is available. */
export function seekVideo(v: HTMLVideoElement, time: number, tolerance: number): Promise<void> {
  const target = Math.max(0, Math.min(time, isFinite(v.duration) ? Math.max(0, v.duration - 0.001) : time))
  if (v.readyState >= 2 && Math.abs(v.currentTime - target) <= tolerance && !v.seeking) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      v.removeEventListener('seeked', finish)
      v.removeEventListener('error', finish)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, 2000)
    v.addEventListener('seeked', finish)
    v.addEventListener('error', finish)
    if (v.readyState === 0) {
      v.addEventListener('loadedmetadata', () => (v.currentTime = target), { once: true })
    } else v.currentTime = target
  })
}

/** Wait until the element has enough data to render (or times out). */
export function whenReady(v: HTMLVideoElement): Promise<void> {
  if (v.readyState >= 2) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 3000)
    v.addEventListener(
      'loadeddata',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}
