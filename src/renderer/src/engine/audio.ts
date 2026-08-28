import type { Clip, Project, Track } from '@shared/types'
import { clipProp } from '@shared/interp'
import { clipEnd, transitionRange } from '@shared/timeline'

/** Gain contribution of audio transitions for a clip at timeline time `t`. */
export function transitionGain(track: Track, clip: Clip, t: number): number {
  let g = 1
  for (const tr of track.transitions) {
    if (tr.outClipId !== clip.id && tr.inClipId !== clip.id) continue
    const r = transitionRange(track, tr)
    if (!r || t < r.start || t > r.end) continue
    const p = r.end > r.start ? (t - r.start) / (r.end - r.start) : 1
    const isOut = tr.outClipId === clip.id
    if (tr.type === 'crossfade' && tr.outClipId && tr.inClipId) {
      g *= isOut ? Math.cos((p * Math.PI) / 2) : Math.sin((p * Math.PI) / 2)
    } else {
      // 'fade' (or crossfade with one side missing): linear in/out.
      g *= isOut ? 1 - p : p
    }
  }
  return g
}

export function volumeAt(track: Track, clip: Clip, t: number): number {
  const v = clipProp(clip, 'volume', t - clip.start)
  return Math.max(0, v) * transitionGain(track, clip, t)
}

const CURVE_HZ = 100

/**
 * Schedule every audible clip from timeline time `from` onward on `ctx`,
 * starting at context time `at`. Works identically for the live
 * AudioContext (preview) and an OfflineAudioContext (export).
 */
export function scheduleTimeline(
  ctx: BaseAudioContext,
  dest: AudioNode,
  project: Project,
  buffers: Map<string, AudioBuffer>,
  from: number,
  at: number,
  until = Infinity,
): AudioBufferSourceNode[] {
  const nodes: AudioBufferSourceNode[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'audio' || track.muted) continue
    for (const clip of track.clips) {
      const buf = buffers.get(clip.assetId)
      if (!buf) continue
      const end = Math.min(clipEnd(clip), until)
      if (end <= from) continue
      const startTl = Math.max(clip.start, from)
      const tlDuration = end - startTl
      if (tlDuration <= 0) continue
      const offset = clip.inPoint + (startTl - clip.start) * clip.speed
      if (offset >= buf.duration) continue
      const srcDuration = Math.min(tlDuration * clip.speed, buf.duration - offset)

      const src = ctx.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = clip.speed
      const gain = ctx.createGain()
      const when = at + (startTl - from)

      const n = Math.max(2, Math.ceil(tlDuration * CURVE_HZ))
      const curve = new Float32Array(n)
      let constant = true
      for (let i = 0; i < n; i++) {
        curve[i] = volumeAt(track, clip, startTl + (i / (n - 1)) * tlDuration)
        if (i > 0 && Math.abs(curve[i] - curve[0]) > 1e-6) constant = false
      }
      if (constant) gain.gain.value = curve[0]
      else {
        gain.gain.setValueAtTime(curve[0], when)
        gain.gain.setValueCurveAtTime(curve, when, tlDuration)
      }
      src.connect(gain).connect(dest)
      src.start(when, offset, srcDuration)
      nodes.push(src)
    }
  }
  return nodes
}

/** Encode an AudioBuffer as 16-bit PCM WAV. */
export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const bytesPerSample = 2
  const dataSize = frames * channels * bytesPerSample
  const ab = new ArrayBuffer(44 + dataSize)
  const dv = new DataView(ab)
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  dv.setUint32(4, 36 + dataSize, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, channels, true)
  dv.setUint32(24, buffer.sampleRate, true)
  dv.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true)
  dv.setUint16(32, channels * bytesPerSample, true)
  dv.setUint16(34, 16, true)
  str(36, 'data')
  dv.setUint32(40, dataSize, true)
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let o = 44
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]))
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      o += 2
    }
  return ab
}
