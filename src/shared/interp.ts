import type { Clip, ClipProp, Easing, Keyframe } from './types'

export const PROP_DEFAULTS: Record<ClipProp, number> = {
  opacity: 1,
  scale: 1,
  x: 0,
  y: 0,
  rotation: 0,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
  volume: 1,
}

export const VIDEO_PROPS: ClipProp[] = [
  'opacity',
  'scale',
  'x',
  'y',
  'rotation',
  'cropLeft',
  'cropTop',
  'cropRight',
  'cropBottom',
]
export const AUDIO_PROPS: ClipProp[] = ['volume']

export function ease(t: number, easing: Easing): number {
  switch (easing) {
    case 'hold':
      return 0
    case 'easeIn':
      return t * t
    case 'easeOut':
      return 1 - (1 - t) * (1 - t)
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    default:
      return t
  }
}

/** Interpolate a keyframe list (sorted by time) at local time `t`. */
export function evalKeyframes(kfs: Keyframe[], t: number): number {
  if (kfs.length === 0) return NaN
  if (t <= kfs[0].time) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (t >= last.time) return last.value
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (t >= a.time && t < b.time) {
      const span = b.time - a.time
      const u = span <= 0 ? 1 : (t - a.time) / span
      return a.value + (b.value - a.value) * ease(u, a.easing)
    }
  }
  return last.value
}

/** Value of a clip property at clip-local time `t` (seconds from clip start). */
export function clipProp(clip: Clip, prop: ClipProp, t: number): number {
  const kfs = clip.keyframes[prop]
  if (kfs && kfs.length > 0) return evalKeyframes(kfs, t)
  const v = clip.props[prop]
  return v === undefined ? PROP_DEFAULTS[prop] : v
}

export function sortKeyframes(kfs: Keyframe[]): Keyframe[] {
  return [...kfs].sort((a, b) => a.time - b.time)
}

/** Insert or replace a keyframe at `time` (within a small epsilon). */
export function upsertKeyframe(kfs: Keyframe[], kf: Keyframe, eps = 1e-3): Keyframe[] {
  const out = kfs.filter((k) => Math.abs(k.time - kf.time) > eps)
  out.push(kf)
  return sortKeyframes(out)
}
