import type { Asset, Clip, Marker, Project, Track, Transition } from './types'
import { newId } from './schema'

export const MIN_CLIP_DURATION = 1 / 60

export const clipEnd = (c: Clip): number => c.start + c.duration
/** Amount of source material consumed by the clip, in source seconds. */
export const sourceLength = (c: Clip): number => c.duration * c.speed
export const sourceOut = (c: Clip): number => c.inPoint + sourceLength(c)

export function sortedClips(track: Track): Clip[] {
  return [...track.clips].sort((a, b) => a.start - b.start)
}

export function findTrack(project: Project, clipId: string): Track | undefined {
  return project.tracks.find((t) => t.clips.some((c) => c.id === clipId))
}

export function findClip(project: Project, clipId: string): { track: Track; clip: Clip } | undefined {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return undefined
}

export function assetOf(project: Project, clip: Clip): Asset | undefined {
  return project.assets.find((a) => a.id === clip.assetId)
}

export function clipAt(track: Track, time: number): Clip | undefined {
  return track.clips.find((c) => time >= c.start && time < clipEnd(c))
}

export function projectDuration(project: Project): number {
  let end = 0
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c))
  return end
}

/** Convert timeline time to source time for a clip (clamped to the asset). */
export function sourceTime(clip: Clip, asset: Asset | undefined, timelineTime: number): number {
  const local = timelineTime - clip.start
  let s = clip.inPoint + local * clip.speed
  if (asset && asset.kind !== 'image') s = Math.min(Math.max(0, s), Math.max(0, asset.duration - 1e-3))
  return s
}

/** Max timeline duration this clip can have given its in-point and asset length. */
export function maxDuration(clip: Clip, asset: Asset | undefined): number {
  if (!asset || asset.kind === 'image') return Infinity
  return Math.max(MIN_CLIP_DURATION, (asset.duration - clip.inPoint) / clip.speed)
}

/* ---------------------------------- Snapping ---------------------------------- */

export interface SnapOptions {
  playhead: number
  markers: Marker[]
  /** Clip ids to exclude (the ones being dragged). */
  exclude?: Set<string>
  /** Snap radius in seconds. */
  threshold: number
}

export function snapPoints(project: Project, opts: SnapOptions): number[] {
  const pts: number[] = [0, opts.playhead]
  for (const m of opts.markers) pts.push(m.time)
  for (const t of project.tracks)
    for (const c of t.clips) {
      if (opts.exclude?.has(c.id)) continue
      pts.push(c.start, clipEnd(c))
    }
  return pts
}

/** Return a snapped time, or the input if nothing is within threshold. */
export function snapTime(time: number, points: number[], threshold: number): { time: number; snapped: boolean } {
  let best = time
  let bestDist = threshold
  for (const p of points) {
    const d = Math.abs(p - time)
    if (d < bestDist) {
      bestDist = d
      best = p
    }
  }
  return { time: best, snapped: best !== time }
}

/* ------------------------------ Overlap handling ------------------------------ */

/**
 * Overwrite semantics: any clip on `track` overlapping [start, end) other than
 * `keepId` is trimmed or split so the region becomes free.
 */
export function clearRegion(track: Track, start: number, end: number, keepId?: string): void {
  const out: Clip[] = []
  for (const c of track.clips) {
    if (c.id === keepId) {
      out.push(c)
      continue
    }
    const cs = c.start
    const ce = clipEnd(c)
    if (ce <= start || cs >= end) {
      out.push(c)
      continue
    }
    if (cs < start && ce > end) {
      // Split around the region.
      const left: Clip = { ...c, duration: start - cs }
      const right: Clip = {
        ...c,
        id: newId('c'),
        start: end,
        duration: ce - end,
        inPoint: c.inPoint + (end - cs) * c.speed,
        keyframes: shiftKeyframes(c.keyframes, -(end - cs)),
        linkedClipId: undefined,
      }
      out.push(left, right)
    } else if (cs < start) {
      out.push({ ...c, duration: start - cs })
    } else if (ce > end) {
      const cut = end - cs
      out.push({
        ...c,
        start: end,
        duration: ce - end,
        inPoint: c.inPoint + cut * c.speed,
        keyframes: shiftKeyframes(c.keyframes, -cut),
      })
    }
    // Fully covered clips are dropped.
  }
  track.clips = out.filter((c) => c.duration >= MIN_CLIP_DURATION)
  pruneTransitions(track)
}

export function shiftKeyframes(kfs: Clip['keyframes'], delta: number): Clip['keyframes'] {
  const out: Clip['keyframes'] = {}
  for (const [k, list] of Object.entries(kfs)) {
    if (!list) continue
    out[k as keyof Clip['keyframes']] = list.map((kf) => ({ ...kf, time: kf.time + delta }))
  }
  return out
}

/** Drop transitions whose clips no longer exist or are no longer adjacent. */
export function pruneTransitions(track: Track): void {
  track.transitions = track.transitions.filter((tr) => transitionValid(track, tr))
}

export function transitionValid(track: Track, tr: Transition): boolean {
  const a = tr.outClipId ? track.clips.find((c) => c.id === tr.outClipId) : undefined
  const b = tr.inClipId ? track.clips.find((c) => c.id === tr.inClipId) : undefined
  if (tr.outClipId && !a) return false
  if (tr.inClipId && !b) return false
  if (a && b) return Math.abs(clipEnd(a) - b.start) < 1e-4
  return !!(a || b)
}

/** Timeline interval covered by a transition. */
export function transitionRange(track: Track, tr: Transition): { start: number; end: number } | undefined {
  const a = tr.outClipId ? track.clips.find((c) => c.id === tr.outClipId) : undefined
  const b = tr.inClipId ? track.clips.find((c) => c.id === tr.inClipId) : undefined
  if (a && b) {
    const cut = clipEnd(a)
    const half = tr.duration / 2
    return { start: cut - half, end: cut + half }
  }
  if (a) return { start: clipEnd(a) - tr.duration, end: clipEnd(a) }
  if (b) return { start: b.start, end: b.start + tr.duration }
  return undefined
}

/* ---------------------------------- Editing ---------------------------------- */

export function splitClipAt(track: Track, clipId: string, time: number): Clip | undefined {
  const c = track.clips.find((x) => x.id === clipId)
  if (!c) return undefined
  const local = time - c.start
  if (local <= MIN_CLIP_DURATION || c.duration - local <= MIN_CLIP_DURATION) return undefined
  const right: Clip = {
    ...c,
    id: newId('c'),
    start: time,
    duration: c.duration - local,
    inPoint: c.inPoint + local * c.speed,
    keyframes: shiftKeyframes(c.keyframes, -local),
    linkedClipId: undefined,
  }
  c.duration = local
  track.clips.push(right)
  pruneTransitions(track)
  return right
}

export type TrimMode = 'normal' | 'ripple' | 'roll' | 'slip' | 'slide'
export type TrimEdge = 'in' | 'out'

/**
 * Apply a trim to `clip` on `track`. `delta` is the time change in seconds
 * applied to the given edge (positive = later). Returns nothing; mutates track.
 */
export function applyTrim(
  project: Project,
  track: Track,
  clip: Clip,
  edge: TrimEdge,
  delta: number,
  mode: TrimMode,
): void {
  const asset = assetOf(project, clip)
  const clips = sortedClips(track)
  const idx = clips.findIndex((c) => c.id === clip.id)
  const prev = clips[idx - 1]
  const next = clips[idx + 1]

  const limitIn = (d: number): number => {
    // Moving the in-point later shrinks the clip; earlier grows it (needs source before inPoint).
    const maxLater = clip.duration - MIN_CLIP_DURATION
    const maxEarlier = asset && asset.kind !== 'image' ? clip.inPoint / clip.speed : Infinity
    return Math.max(-maxEarlier, Math.min(maxLater, d))
  }
  const limitOut = (d: number): number => {
    const maxLater = maxDuration(clip, asset) - clip.duration
    const maxEarlier = clip.duration - MIN_CLIP_DURATION
    return Math.max(-maxEarlier, Math.min(maxLater, d))
  }

  switch (mode) {
    case 'normal': {
      if (edge === 'in') {
        let d = limitIn(delta)
        if (prev && d < 0) d = Math.max(d, clipEnd(prev) - clip.start)
        clip.start += d
        clip.duration -= d
        clip.inPoint += d * clip.speed
        clip.keyframes = shiftKeyframes(clip.keyframes, -d)
      } else {
        let d = limitOut(delta)
        if (next && d > 0) d = Math.min(d, next.start - clipEnd(clip))
        clip.duration += d
      }
      break
    }
    case 'ripple': {
      // Like normal, but everything after the edit point shifts to close/open the gap.
      const before = clipEnd(clip)
      if (edge === 'in') {
        const d = limitIn(delta)
        clip.duration -= d
        clip.inPoint += d * clip.speed
        clip.keyframes = shiftKeyframes(clip.keyframes, -d)
        // Clip keeps its start; later clips shift by -d.
        for (const c of track.clips) if (c.id !== clip.id && c.start >= before - 1e-6) c.start -= d
      } else {
        const d = limitOut(delta)
        clip.duration += d
        for (const c of track.clips) if (c.id !== clip.id && c.start >= before - 1e-6) c.start += d
      }
      break
    }
    case 'roll': {
      // Move the cut between this clip and its neighbour, keeping total length.
      if (edge === 'out' && next) {
        const nextAsset = assetOf(project, next)
        let d = limitOut(delta)
        const nextMaxEarlier = nextAsset && nextAsset.kind !== 'image' ? next.inPoint / next.speed : Infinity
        d = Math.max(-nextMaxEarlier, Math.min(next.duration - MIN_CLIP_DURATION, d))
        clip.duration += d
        next.start += d
        next.duration -= d
        next.inPoint += d * next.speed
        next.keyframes = shiftKeyframes(next.keyframes, -d)
      } else if (edge === 'in' && prev) {
        const prevAsset = assetOf(project, prev)
        let d = limitIn(delta)
        d = Math.max(-(prev.duration - MIN_CLIP_DURATION), Math.min(maxDuration(prev, prevAsset) - prev.duration, d))
        clip.start += d
        clip.duration -= d
        clip.inPoint += d * clip.speed
        clip.keyframes = shiftKeyframes(clip.keyframes, -d)
        prev.duration += d
      } else {
        applyTrim(project, track, clip, edge, delta, 'normal')
      }
      break
    }
    case 'slip': {
      // Change which part of the source is shown, keeping position and duration.
      if (!asset || asset.kind === 'image') return
      const maxIn = asset.duration - sourceLength(clip)
      clip.inPoint = Math.max(0, Math.min(maxIn, clip.inPoint - delta * clip.speed))
      break
    }
    case 'slide': {
      // Move the clip in time; neighbours absorb the change so the total stays fixed.
      let d = delta
      if (prev) d = Math.max(d, -(prev.duration - MIN_CLIP_DURATION))
      if (next) {
        const nextAsset = assetOf(project, next)
        d = Math.min(d, next.duration - MIN_CLIP_DURATION)
        const nextMaxEarlier = nextAsset && nextAsset.kind !== 'image' ? next.inPoint / next.speed : Infinity
        d = Math.max(d, -nextMaxEarlier)
      }
      if (prev) {
        const prevAsset = assetOf(project, prev)
        d = Math.min(d, maxDuration(prev, prevAsset) - prev.duration)
      }
      clip.start += d
      if (prev) prev.duration += d
      if (next) {
        next.start += d
        next.duration -= d
        next.inPoint += d * next.speed
        next.keyframes = shiftKeyframes(next.keyframes, -d)
      }
      break
    }
  }
  pruneTransitions(track)
}

/** Remove a clip and (ripple) close the gap it leaves. */
export function rippleDelete(track: Track, clipId: string): void {
  const c = track.clips.find((x) => x.id === clipId)
  if (!c) return
  const start = c.start
  const len = c.duration
  track.clips = track.clips.filter((x) => x.id !== clipId)
  for (const x of track.clips) if (x.start >= start + len - 1e-6) x.start -= len
  pruneTransitions(track)
}

export function formatTimecode(seconds: number, fps: number): string {
  const s = Math.max(0, seconds)
  const totalFrames = Math.round(s * fps)
  const f = totalFrames % Math.round(fps)
  const totalSec = Math.floor(totalFrames / Math.round(fps))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const sec = totalSec % 60
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}:${pad(f)}`
}
