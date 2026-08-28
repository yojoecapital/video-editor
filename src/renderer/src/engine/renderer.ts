import type { Clip, Project, Track, VideoTransitionType } from '@shared/types'
import { clipProp } from '@shared/interp'
import { assetOf, clipAt, sourceTime, transitionRange } from '@shared/timeline'
import type { Compositor, LayerParams } from './compositor'
import { MediaManager, seekVideo, whenReady } from './media'

export interface RenderOptions {
  /** Seek video elements to the exact frame (paused/export) vs. use whatever frame is decoded (playback). */
  seek: boolean
  /** Seek tolerance in seconds. */
  tolerance: number
}

interface LayerOp {
  source: TexImageSource
  params: LayerParams
}

interface TrackOp {
  transition?: { type: VideoTransitionType; progress: number; a: LayerOp[]; b: LayerOp[] }
  layers: LayerOp[]
}

async function prepareClip(
  media: MediaManager,
  project: Project,
  clip: Clip,
  time: number,
  opts: RenderOptions,
  opacityMul = 1,
): Promise<LayerOp | undefined> {
  const asset = assetOf(project, clip)
  if (!asset) return undefined
  const local = time - clip.start
  const src = media.sources.get(asset.id)
  let source: TexImageSource | undefined
  let srcWidth = asset.width
  let srcHeight = asset.height
  if (asset.kind === 'image') {
    const bmpP = media.image(asset.id)
    if (!bmpP) return undefined
    const bmp = await bmpP.catch(() => undefined)
    if (!bmp) return undefined
    source = bmp
    srcWidth = bmp.width
    srcHeight = bmp.height
  } else if (asset.kind === 'video') {
    const v = media.video(clip.id, asset.id)
    if (!v) return undefined
    await whenReady(v)
    if (opts.seek) await seekVideo(v, sourceTime(clip, asset, time), opts.tolerance)
    if (v.readyState < 2) return undefined
    source = v
    srcWidth = v.videoWidth || src?.width || asset.width
    srcHeight = v.videoHeight || src?.height || asset.height
  } else return undefined

  // Aspect ratio comes from the (possibly proxy) frame, but the "fit" size
  // must match the original so preview and export line up.
  const params: LayerParams = {
    srcWidth: asset.width || srcWidth,
    srcHeight: asset.height || srcHeight,
    opacity: clipProp(clip, 'opacity', local) * opacityMul,
    scale: clipProp(clip, 'scale', local),
    x: clipProp(clip, 'x', local),
    y: clipProp(clip, 'y', local),
    rotation: clipProp(clip, 'rotation', local),
    cropLeft: clipProp(clip, 'cropLeft', local),
    cropTop: clipProp(clip, 'cropTop', local),
    cropRight: clipProp(clip, 'cropRight', local),
    cropBottom: clipProp(clip, 'cropBottom', local),
  }
  return { source, params }
}

async function prepareTrack(media: MediaManager, project: Project, track: Track, time: number, opts: RenderOptions): Promise<TrackOp> {
  for (const tr of track.transitions) {
    const r = transitionRange(track, tr)
    if (!r || time < r.start || time >= r.end) continue
    const p = (time - r.start) / Math.max(1e-6, r.end - r.start)
    const a = tr.outClipId ? track.clips.find((c) => c.id === tr.outClipId) : undefined
    const b = tr.inClipId ? track.clips.find((c) => c.id === tr.inClipId) : undefined
    if (a && b) {
      const [la, lb] = await Promise.all([prepareClip(media, project, a, time, opts), prepareClip(media, project, b, time, opts)])
      return {
        transition: { type: tr.type as VideoTransitionType, progress: p, a: la ? [la] : [], b: lb ? [lb] : [] },
        layers: [],
      }
    }
    // Single-sided: fade in / fade out via opacity.
    const clip = a ?? b
    if (clip) {
      const l = await prepareClip(media, project, clip, time, opts, a ? 1 - p : p)
      return { layers: l ? [l] : [] }
    }
  }
  const clip = clipAt(track, time)
  if (!clip) return { layers: [] }
  const l = await prepareClip(media, project, clip, time, opts)
  return { layers: l ? [l] : [] }
}

/**
 * Composite the timeline at `time` onto the compositor's canvas. Media is
 * prepared (decoded/seeked) concurrently for every visible layer first, then
 * drawn bottom track to top in one synchronous pass.
 */
export async function renderFrame(comp: Compositor, media: MediaManager, project: Project, time: number, opts: RenderOptions): Promise<void> {
  const tracks = project.tracks.filter((t) => t.kind === 'video' && !t.muted).reverse()
  const ops = await Promise.all(tracks.map((t) => prepareTrack(media, project, t, time, opts)))
  comp.begin(project.settings.background)
  for (const op of ops) {
    if (op.transition) {
      comp.beginTarget('A')
      for (const l of op.transition.a) comp.drawLayer(l.source, l.params)
      comp.beginTarget('B')
      for (const l of op.transition.b) comp.drawLayer(l.source, l.params)
      comp.endTarget()
      comp.drawTransition(op.transition.type, op.transition.progress)
    }
    for (const l of op.layers) comp.drawLayer(l.source, l.params)
  }
}

/** Clips (and the source times) that are visible or about to be, used for playback pre-roll. */
export function activeVideoClips(project: Project, time: number, lookahead: number): Array<{ clip: Clip; active: boolean }> {
  const out: Array<{ clip: Clip; active: boolean }> = []
  for (const t of project.tracks) {
    if (t.kind !== 'video' || t.muted) continue
    for (const c of t.clips) {
      const end = c.start + c.duration
      let start = c.start
      let stop = end
      for (const tr of t.transitions) {
        const r = transitionRange(t, tr)
        if (!r) continue
        if (tr.outClipId === c.id) stop = Math.max(stop, r.end)
        if (tr.inClipId === c.id) start = Math.min(start, r.start)
      }
      if (time >= start && time < stop) out.push({ clip: c, active: true })
      else if (start > time && start - time < lookahead) out.push({ clip: c, active: false })
    }
  }
  return out
}
