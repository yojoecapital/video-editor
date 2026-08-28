import type { Asset, Clip, ClipProp, Keyframe, Project, Track, TrackKind, TransitionType } from '@shared/types'
import { newId } from '@shared/schema'
import { clipProp, PROP_DEFAULTS, upsertKeyframe } from '@shared/interp'
import {
  applyTrim,
  clearRegion,
  clipEnd,
  findClip,
  MIN_CLIP_DURATION,
  pruneTransitions,
  rippleDelete,
  splitClipAt,
  sourceLength,
  type TrimEdge,
  type TrimMode,
} from '@shared/timeline'
import { useProject } from './store/project'
import { useUi } from './store/ui'

const update = (fn: (p: Project) => void, record = true): void => useProject.getState().update(fn, { record })

function firstTrack(p: Project, kind: TrackKind, preferId?: string): Track | undefined {
  const pref = preferId ? p.tracks.find((t) => t.id === preferId && t.kind === kind && !t.locked) : undefined
  return pref ?? p.tracks.find((t) => t.kind === kind && !t.locked)
}

function makeClip(asset: Asset, start: number): Clip {
  return {
    id: newId('c'),
    assetId: asset.id,
    start,
    duration: asset.kind === 'image' ? 5 : asset.duration,
    inPoint: 0,
    speed: 1,
    props: {},
    keyframes: {},
  }
}

/* --------------------------------- Insertion --------------------------------- */

export function insertAsset(assetId: string, trackId: string | undefined, time: number): string[] {
  const ids: string[] = []
  update((p) => {
    const asset = p.assets.find((a) => a.id === assetId)
    if (!asset) return
    const start = Math.max(0, time)
    const dropped = p.tracks.find((t) => t.id === trackId)
    if (asset.kind === 'audio') {
      const track = firstTrack(p, 'audio', dropped?.kind === 'audio' ? dropped.id : undefined)
      if (!track) return
      const clip = makeClip(asset, start)
      clearRegion(track, clip.start, clipEnd(clip))
      track.clips.push(clip)
      ids.push(clip.id)
      return
    }
    const vTrack = firstTrack(p, 'video', dropped?.kind === 'video' ? dropped.id : undefined)
    if (!vTrack) return
    const clip = makeClip(asset, start)
    clearRegion(vTrack, clip.start, clipEnd(clip))
    vTrack.clips.push(clip)
    ids.push(clip.id)
    if (asset.hasAudio) {
      const aTrack = firstTrack(p, 'audio')
      if (aTrack) {
        const aClip: Clip = { ...makeClip(asset, start), linkedClipId: clip.id }
        clip.linkedClipId = aClip.id
        clearRegion(aTrack, aClip.start, clipEnd(aClip))
        aTrack.clips.push(aClip)
        ids.push(aClip.id)
      }
    }
  })
  return ids
}

/* ---------------------------------- Moving ---------------------------------- */

export interface ClipMove {
  clipId: string
  start: number
  trackId: string
}

/** Relocate clips (overwrite mode). Runs without recording; wrap in a transaction. */
export function moveClips(moves: ClipMove[]): void {
  update((p) => {
    const lifted: Array<{ clip: Clip; move: ClipMove }> = []
    for (const m of moves) {
      const found = findClip(p, m.clipId)
      if (!found || found.track.locked) continue
      found.track.clips = found.track.clips.filter((c) => c.id !== m.clipId)
      lifted.push({ clip: found.clip, move: m })
    }
    for (const { clip, move } of lifted) {
      const track = p.tracks.find((t) => t.id === move.trackId)
      if (!track || track.locked) continue
      clip.start = Math.max(0, move.start)
      clearRegion(track, clip.start, clipEnd(clip))
      track.clips.push(clip)
    }
    for (const t of p.tracks) pruneTransitions(t)
  }, false)
}

/** Expand a selection to include linked partners. */
export function withLinked(p: Project, ids: string[]): string[] {
  const out = new Set(ids)
  for (const id of ids) {
    const f = findClip(p, id)
    if (f?.clip.linkedClipId) out.add(f.clip.linkedClipId)
  }
  return [...out]
}

/* --------------------------------- Trimming --------------------------------- */

export function trimClips(clipIds: string[], edge: TrimEdge, delta: number, mode: TrimMode): void {
  update((p) => {
    for (const id of clipIds) {
      const f = findClip(p, id)
      if (!f || f.track.locked) continue
      applyTrim(p, f.track, f.clip, edge, delta, mode)
    }
  }, false)
}

/* ------------------------------ Split / delete ------------------------------ */

export function splitAt(time: number, onlyIds?: string[]): void {
  update((p) => {
    for (const t of p.tracks) {
      if (t.locked) continue
      for (const c of [...t.clips]) {
        if (onlyIds && !onlyIds.includes(c.id)) continue
        if (time > c.start && time < clipEnd(c)) splitClipAt(t, c.id, time)
      }
    }
  })
}

export function deleteClips(ids: string[], ripple = false): void {
  update((p) => {
    const all = withLinked(p, ids)
    for (const id of all) {
      const f = findClip(p, id)
      if (!f || f.track.locked) continue
      if (ripple) rippleDelete(f.track, id)
      else {
        f.track.clips = f.track.clips.filter((c) => c.id !== id)
        pruneTransitions(f.track)
      }
    }
    for (const t of p.tracks) for (const c of t.clips) if (c.linkedClipId && all.includes(c.linkedClipId)) c.linkedClipId = undefined
  })
  useUi.getState().clearSelection()
}

export function unlinkClips(ids: string[]): void {
  update((p) => {
    for (const id of ids) {
      const f = findClip(p, id)
      if (!f) continue
      const partner = f.clip.linkedClipId ? findClip(p, f.clip.linkedClipId) : undefined
      if (partner) partner.clip.linkedClipId = undefined
      f.clip.linkedClipId = undefined
    }
  })
}

/* -------------------------------- Transitions -------------------------------- */

export function addTransition(trackId: string, outClipId: string | undefined, inClipId: string | undefined, type: TransitionType, duration = 1): string | undefined {
  let id: string | undefined
  update((p) => {
    const t = p.tracks.find((x) => x.id === trackId)
    if (!t) return
    // One transition per cut / clip edge.
    t.transitions = t.transitions.filter((tr) => !(tr.outClipId === outClipId && tr.inClipId === inClipId))
    const a = outClipId ? t.clips.find((c) => c.id === outClipId) : undefined
    const b = inClipId ? t.clips.find((c) => c.id === inClipId) : undefined
    const maxDur = Math.min(a ? a.duration : Infinity, b ? b.duration : Infinity)
    id = newId('t')
    t.transitions.push({ id, type, duration: Math.min(duration, a && b ? maxDur * 2 : maxDur), outClipId, inClipId })
    pruneTransitions(t)
  })
  return id
}

export function updateTransition(id: string, patch: Partial<{ type: TransitionType; duration: number }>): void {
  update((p) => {
    for (const t of p.tracks) {
      const tr = t.transitions.find((x) => x.id === id)
      if (tr) Object.assign(tr, patch)
    }
  })
}

export function removeTransition(id: string): void {
  update((p) => {
    for (const t of p.tracks) t.transitions = t.transitions.filter((x) => x.id !== id)
  })
}

/** Add a default transition at every cut between selected clips (or to the nearest neighbour). */
export function addTransitionToSelection(type?: TransitionType, duration = 1): void {
  const { selection } = useUi.getState()
  const p = useProject.getState().project
  for (const id of selection.clipIds) {
    const f = findClip(p, id)
    if (!f) continue
    const sorted = [...f.track.clips].sort((a, b) => a.start - b.start)
    const i = sorted.findIndex((c) => c.id === id)
    const next = sorted[i + 1]
    const prev = sorted[i - 1]
    const defaultType: TransitionType = f.track.kind === 'audio' ? 'crossfade' : 'crossDissolve'
    const t = type ?? defaultType
    if (next && Math.abs(next.start - clipEnd(f.clip)) < 1e-4 && !selection.clipIds.includes(next.id)) addTransition(f.track.id, id, next.id, t, duration)
    else if (prev && Math.abs(clipEnd(prev) - f.clip.start) < 1e-4) addTransition(f.track.id, prev.id, id, t, duration)
    else if (next && Math.abs(next.start - clipEnd(f.clip)) < 1e-4) addTransition(f.track.id, id, next.id, t, duration)
    else addTransition(f.track.id, undefined, id, f.track.kind === 'audio' ? 'fade' : 'fadeBlack', Math.min(duration, f.clip.duration))
  }
}

/* -------------------------------- Properties -------------------------------- */

/** Set a property; if it is animated, this writes/updates the keyframe at `time`. */
export function setClipProp(clipId: string, prop: ClipProp, value: number, time: number, record = true): void {
  update((p) => {
    const f = findClip(p, clipId)
    if (!f) return
    const kfs = f.clip.keyframes[prop]
    if (kfs && kfs.length > 0) {
      const local = Math.max(0, Math.min(f.clip.duration, time - f.clip.start))
      f.clip.keyframes[prop] = upsertKeyframe(kfs, { time: local, value, easing: nearestEasing(kfs, local) })
    } else f.clip.props[prop] = value
  }, record)
}

function nearestEasing(kfs: Keyframe[], t: number): Keyframe['easing'] {
  let best = kfs[0]
  for (const k of kfs) if (Math.abs(k.time - t) < Math.abs(best.time - t)) best = k
  return best?.easing ?? 'linear'
}

export function toggleKeyframe(clipId: string, prop: ClipProp, time: number): void {
  update((p) => {
    const f = findClip(p, clipId)
    if (!f) return
    const local = Math.max(0, Math.min(f.clip.duration, time - f.clip.start))
    const kfs = f.clip.keyframes[prop] ?? []
    const existing = kfs.find((k) => Math.abs(k.time - local) < 1e-3)
    if (existing) {
      const rest = kfs.filter((k) => k !== existing)
      if (rest.length === 0) {
        delete f.clip.keyframes[prop]
        f.clip.props[prop] = existing.value
      } else f.clip.keyframes[prop] = rest
    } else {
      const value = clipProp(f.clip, prop, local)
      f.clip.keyframes[prop] = upsertKeyframe(kfs, { time: local, value, easing: 'linear' })
    }
  })
}

export function clearKeyframes(clipId: string, prop: ClipProp, time: number): void {
  update((p) => {
    const f = findClip(p, clipId)
    if (!f) return
    const v = clipProp(f.clip, prop, time - f.clip.start)
    delete f.clip.keyframes[prop]
    f.clip.props[prop] = v
  })
}

export function setKeyframeEasing(clipId: string, prop: ClipProp, kfTime: number, easing: Keyframe['easing']): void {
  update((p) => {
    const f = findClip(p, clipId)
    const k = f?.clip.keyframes[prop]?.find((x) => Math.abs(x.time - kfTime) < 1e-6)
    if (k) k.easing = easing
  })
}

export function removeKeyframe(clipId: string, prop: ClipProp, kfTime: number): void {
  update((p) => {
    const f = findClip(p, clipId)
    if (!f) return
    const kfs = (f.clip.keyframes[prop] ?? []).filter((x) => Math.abs(x.time - kfTime) >= 1e-6)
    if (kfs.length === 0) {
      f.clip.props[prop] = f.clip.keyframes[prop]?.[0]?.value ?? PROP_DEFAULTS[prop]
      delete f.clip.keyframes[prop]
    } else f.clip.keyframes[prop] = kfs
  })
}

export function resetProp(clipId: string, prop: ClipProp): void {
  update((p) => {
    const f = findClip(p, clipId)
    if (!f) return
    delete f.clip.keyframes[prop]
    delete f.clip.props[prop]
  })
}

/** Change speed keeping the in-point; the timeline duration changes accordingly. */
export function setClipSpeed(clipId: string, speed: number): void {
  const s = Math.max(0.05, Math.min(16, speed))
  update((p) => {
    const f = findClip(p, clipId)
    if (!f) return
    const ids = withLinked(p, [clipId])
    for (const id of ids) {
      const g = findClip(p, id)
      if (!g) continue
      const src = sourceLength(g.clip)
      const newDur = Math.max(MIN_CLIP_DURATION, src / s)
      const scale = newDur / g.clip.duration
      g.clip.speed = s
      g.clip.duration = newDur
      for (const [k, list] of Object.entries(g.clip.keyframes)) if (list) g.clip.keyframes[k as ClipProp] = list.map((kf) => ({ ...kf, time: kf.time * scale }))
      clearRegion(g.track, g.clip.start, clipEnd(g.clip), g.clip.id)
    }
  })
}

/* --------------------------------- Clipboard --------------------------------- */

export function copySelection(): void {
  const p = useProject.getState().project
  const ids = withLinked(p, useUi.getState().selection.clipIds)
  const clips = ids.map((id) => findClip(p, id)?.clip).filter((c): c is Clip => !!c)
  if (clips.length === 0) return
  const t0 = Math.min(...clips.map((c) => c.start))
  useUi.getState().setClipboard(clips.map((c) => ({ ...c, start: c.start - t0 })))
}

export function paste(time: number): void {
  const { clipboard } = useUi.getState()
  if (clipboard.length === 0) return
  const newIds: string[] = []
  update((p) => {
    const idMap = new Map<string, string>()
    for (const c of clipboard) idMap.set(c.id, newId('c'))
    for (const c of clipboard) {
      const srcTrack = p.tracks.find((t) => t.clips.some((x) => x.id === c.id))
      const asset = p.assets.find((a) => a.id === c.assetId)
      if (!asset) continue
      const kind: TrackKind = srcTrack?.kind ?? (asset.kind === 'audio' ? 'audio' : 'video')
      const track = (srcTrack && !srcTrack.locked ? srcTrack : undefined) ?? firstTrack(p, kind)
      if (!track) continue
      const clip: Clip = {
        ...JSON.parse(JSON.stringify(c)),
        id: idMap.get(c.id)!,
        start: time + c.start,
        linkedClipId: c.linkedClipId ? idMap.get(c.linkedClipId) : undefined,
      }
      clearRegion(track, clip.start, clipEnd(clip))
      track.clips.push(clip)
      newIds.push(clip.id)
    }
  })
  useUi.getState().select({ clipIds: newIds })
}

/* ---------------------------------- Markers ---------------------------------- */

export function addMarker(time: number, label = ''): void {
  update((p) => {
    const existing = p.markers.find((m) => Math.abs(m.time - time) < 1e-3)
    if (existing) p.markers = p.markers.filter((m) => m !== existing)
    else p.markers.push({ id: newId('mk'), time, label, color: '#ffcc00' })
  })
}

/* ----------------------------------- Tracks ----------------------------------- */

export function addTrack(kind: TrackKind): void {
  update((p) => {
    const n = p.tracks.filter((t) => t.kind === kind).length + 1
    const track: Track = { id: newId(kind[0]), kind, name: `${kind === 'video' ? 'V' : 'A'}${n}`, muted: false, locked: false, clips: [], transitions: [] }
    if (kind === 'video') p.tracks.unshift(track)
    else p.tracks.push(track)
  })
}

export function removeTrack(id: string): void {
  update((p) => {
    p.tracks = p.tracks.filter((t) => t.id !== id)
  })
}

export function patchTrack(id: string, patch: Partial<Pick<Track, 'muted' | 'locked' | 'name'>>): void {
  update((p) => {
    const t = p.tracks.find((x) => x.id === id)
    if (t) Object.assign(t, patch)
  })
}

/* ----------------------------------- Assets ----------------------------------- */

export function removeAsset(assetId: string): void {
  update((p) => {
    p.assets = p.assets.filter((a) => a.id !== assetId)
    for (const t of p.tracks) {
      t.clips = t.clips.filter((c) => c.assetId !== assetId)
      pruneTransitions(t)
    }
  })
}

export function relinkAsset(assetId: string, newPath: string, probe: import('@shared/types').ProbeResult, fingerprint?: Asset['fingerprint']): void {
  update((p) => {
    const a = p.assets.find((x) => x.id === assetId)
    if (!a) return
    a.path = newPath
    a.name = newPath.split('/').pop() ?? a.name
    a.duration = probe.kind === 'image' ? a.duration : probe.duration
    a.width = probe.width
    a.height = probe.height
    a.fps = probe.fps
    a.hasAudio = probe.hasAudio
    a.hasVideo = probe.hasVideo
    a.kind = probe.kind
    a.fingerprint = fingerprint
  })
}
