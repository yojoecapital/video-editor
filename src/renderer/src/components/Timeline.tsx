import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from 'react'
import type { Clip, Track, Transition } from '@shared/types'
import { clipEnd, formatTimecode, projectDuration, snapPoints, snapTime, transitionRange } from '@shared/timeline'
import { media } from '../engine/session'
import { useProject } from '../store/project'
import { useUi } from '../store/ui'
import { addTrack, insertAsset, moveClips, patchTrack, removeTrack, trimClips, withLinked, type ClipMove } from '../actions'
import { ASSET_MIME } from './MediaBin'

const TRACK_H = 56
const HEADER_W = 150
const SNAP_PX = 8

/* ---------------------------------- Ruler ---------------------------------- */

function pickTickInterval(pxPerSec: number, fps: number): { major: number; minor: number } {
  const candidates = [1 / fps, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  for (const c of candidates) if (c * pxPerSec >= 80) return { major: c, minor: c / (c >= 1 ? 5 : 2) }
  return { major: 600, minor: 120 }
}

function Ruler({ width, scrollX }: { width: number; scrollX: number }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const pxPerSec = useUi((s) => s.pxPerSec)
  const playhead = useUi((s) => s.playhead)
  const fps = useProject((s) => s.project.settings.fps)
  const markers = useProject((s) => s.project.markers)

  useLayoutEffect(() => {
    const c = ref.current!
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = 30 * dpr
    c.style.width = `${width}px`
    c.style.height = '30px'
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, 30)
    const { major, minor } = pickTickInterval(pxPerSec, fps)
    const t0 = scrollX / pxPerSec
    const t1 = (scrollX + width) / pxPerSec
    g.strokeStyle = '#4a4a55'
    g.fillStyle = '#9a9aa6'
    g.font = '10px system-ui'
    g.beginPath()
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(t * pxPerSec - scrollX) + 0.5
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
      g.moveTo(x, isMajor ? 14 : 22)
      g.lineTo(x, 30)
      if (isMajor) g.fillText(formatTimecode(t, fps), x + 3, 11)
    }
    g.stroke()
    for (const m of markers) {
      const x = m.time * pxPerSec - scrollX
      if (x < -10 || x > width + 10) continue
      g.fillStyle = m.color
      g.beginPath()
      g.moveTo(x - 5, 0)
      g.lineTo(x + 5, 0)
      g.lineTo(x, 8)
      g.closePath()
      g.fill()
    }
    const px = playhead * pxPerSec - scrollX
    g.fillStyle = '#ff5b6b'
    g.beginPath()
    g.moveTo(px - 6, 0)
    g.lineTo(px + 6, 0)
    g.lineTo(px, 10)
    g.closePath()
    g.fill()
    g.fillRect(px - 0.5, 0, 1, 30)
  }, [width, scrollX, pxPerSec, playhead, fps, markers])

  return <canvas ref={ref} />
}

/* ----------------------------------- Clip ----------------------------------- */

interface DragState {
  kind: 'move' | 'trim-in' | 'trim-out'
  clipIds: string[]
  startX: number
  startY: number
  origin: Map<string, { start: number; trackId: string }>
  moved: boolean
  primaryId: string
  primaryStart: number
  primaryEnd: number
}

function ClipView({
  clip,
  track,
  onPointerDown,
}: {
  clip: Clip
  track: Track
  onPointerDown: (e: RPointerEvent, clip: Clip, kind: DragState['kind']) => void
}): JSX.Element {
  const pxPerSec = useUi((s) => s.pxPerSec)
  const selected = useUi((s) => s.selection.clipIds.includes(clip.id))
  const asset = useProject((s) => s.project.assets.find((a) => a.id === clip.assetId))
  const [, force] = useState(0)
  useEffect(() => media.onChange(() => force((n) => n + 1)), [])
  const thumb = media.sources.get(clip.assetId)?.thumbnail
  const kind = track.kind === 'audio' ? 'audio' : asset?.kind === 'image' ? 'image' : 'video'
  const kfTimes = useMemo(() => {
    const set = new Set<number>()
    for (const list of Object.values(clip.keyframes)) for (const k of list ?? []) set.add(k.time)
    return [...set]
  }, [clip.keyframes])
  const w = clip.duration * pxPerSec

  return (
    <div
      className={`clip ${selected ? 'selected' : ''} ${track.muted ? 'muted' : ''}`}
      style={{ left: clip.start * pxPerSec, width: Math.max(2, w), ['--c1' as string]: `var(--${kind})`, ['--c2' as string]: `var(--${kind}-2)` }}
      onPointerDown={(e) => onPointerDown(e, clip, 'move')}
      title={`${asset?.name ?? '?'}\n${formatTimecode(clip.start, 30)} → ${formatTimecode(clipEnd(clip), 30)}${clip.speed !== 1 ? `\nspeed ×${clip.speed}` : ''}`}
    >
      {thumb && kind !== 'audio' && w > 40 && <div className="clip-thumb" style={{ backgroundImage: `url("${thumb}")` }} />}
      <div className="clip-label">
        {asset?.name ?? 'missing'}
        {clip.speed !== 1 ? ` ×${clip.speed}` : ''}
        {clip.linkedClipId ? ' ⛓' : ''}
      </div>
      {kfTimes.map((t) => (
        <div key={t} className="clip-kf" style={{ left: t * pxPerSec }} />
      ))}
      <div className="handle in" onPointerDown={(e) => onPointerDown(e, clip, 'trim-in')} />
      <div className="handle out" onPointerDown={(e) => onPointerDown(e, clip, 'trim-out')} />
    </div>
  )
}

function TransitionView({ track, tr }: { track: Track; tr: Transition }): JSX.Element | null {
  const pxPerSec = useUi((s) => s.pxPerSec)
  const selected = useUi((s) => s.selection.transitionId === tr.id)
  const r = transitionRange(track, tr)
  if (!r) return null
  return (
    <div
      className={`transition ${selected ? 'selected' : ''}`}
      style={{ left: r.start * pxPerSec, width: Math.max(6, (r.end - r.start) * pxPerSec) }}
      onPointerDown={(e) => {
        e.stopPropagation()
        useUi.getState().select({ clipIds: [], transitionId: tr.id })
      }}
      title={`${tr.type} (${tr.duration.toFixed(2)}s)`}
    >
      {tr.type}
    </div>
  )
}

/* --------------------------------- Timeline --------------------------------- */

export default function Timeline(): JSX.Element {
  const tracks = useProject((s) => s.project.tracks)
  const markers = useProject((s) => s.project.markers)
  const fps = useProject((s) => s.project.settings.fps)
  const duration = useProject((s) => projectDuration(s.project))
  const pxPerSec = useUi((s) => s.pxPerSec)
  const playhead = useUi((s) => s.playhead)
  const playing = useUi((s) => s.playing)
  const snapLine = useUi((s) => s.snapLine)
  const trimMode = useUi((s) => s.trimMode)
  const snapping = useUi((s) => s.snapping)

  const scrollRef = useRef<HTMLDivElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)
  const [scrollX, setScrollX] = useState(0)
  const [viewW, setViewW] = useState(800)
  const dragRef = useRef<DragState | null>(null)
  const [ghost, setGhost] = useState<{ trackId: string; start: number; duration: number } | null>(null)
  const scrubbing = useRef(false)

  const contentW = Math.max(viewW, (duration + 60) * pxPerSec)

  useEffect(() => {
    const el = scrollRef.current!
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    setViewW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Follow the playhead during playback.
  useEffect(() => {
    if (!playing) return
    const el = scrollRef.current!
    const px = playhead * pxPerSec
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, px - 40)
  }, [playhead, playing, pxPerSec])

  const timeAt = useCallback(
    (clientX: number): number => {
      const el = scrollRef.current!
      const rect = el.getBoundingClientRect()
      return Math.max(0, (clientX - rect.left + el.scrollLeft) / pxPerSec)
    },
    [pxPerSec],
  )
  const trackAt = useCallback(
    (clientY: number): Track | undefined => {
      const el = scrollRef.current!
      const rect = el.getBoundingClientRect()
      const idx = Math.floor((clientY - rect.top + el.scrollTop) / TRACK_H)
      return tracks[idx]
    },
    [tracks],
  )

  /* ---- Zoom / pan ---- */
  const onWheel = (e: React.WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const el = scrollRef.current!
      const t = timeAt(e.clientX)
      const factor = Math.exp(-e.deltaY * 0.002)
      const next = Math.min(2000, Math.max(2, pxPerSec * factor))
      useUi.getState().setZoom(next)
      requestAnimationFrame(() => {
        el.scrollLeft = t * next - (e.clientX - el.getBoundingClientRect().left)
      })
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      scrollRef.current!.scrollLeft += e.deltaX || e.deltaY
    }
  }

  /* ---- Scrubbing on the ruler / empty track area ---- */
  const beginScrub = (e: RPointerEvent): void => {
    scrubbing.current = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    useUi.getState().setPlayhead(Math.round(timeAt(e.clientX) * fps) / fps)
  }
  const moveScrub = (e: RPointerEvent): void => {
    if (!scrubbing.current) return
    useUi.getState().setPlayhead(Math.round(timeAt(e.clientX) * fps) / fps)
  }
  const endScrub = (): void => {
    scrubbing.current = false
  }

  /* ---- Clip dragging: move / trim / slip / slide ---- */
  const onClipPointerDown = (e: RPointerEvent, clip: Clip, kind: DragState['kind']): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    const ui = useUi.getState()
    const project = useProject.getState().project
    const track = tracks.find((t) => t.clips.some((c) => c.id === clip.id))
    if (track?.locked) return
    let ids = ui.selection.clipIds
    if (!ids.includes(clip.id)) {
      ui.selectClip(clip.id, e.shiftKey)
      ids = useUi.getState().selection.clipIds
    } else if (e.shiftKey) {
      ui.selectClip(clip.id, true)
      return
    }
    if (kind !== 'move') ids = [clip.id]
    ids = withLinked(project, ids)
    const origin = new Map<string, { start: number; trackId: string }>()
    for (const id of ids) {
      const t = project.tracks.find((x) => x.clips.some((c) => c.id === id))
      const c = t?.clips.find((x) => x.id === id)
      if (t && c) origin.set(id, { start: c.start, trackId: t.id })
    }
    dragRef.current = {
      kind,
      clipIds: ids,
      startX: e.clientX,
      startY: e.clientY,
      origin,
      moved: false,
      primaryId: clip.id,
      primaryStart: clip.start,
      primaryEnd: clipEnd(clip),
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: RPointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX
    if (!d.moved) {
      if (Math.abs(dx) < 3 && Math.abs(e.clientY - d.startY) < 3) return
      d.moved = true
      useProject.getState().beginTransaction()
    }
    const store = useProject.getState()
    // Re-apply from the transaction base each move so clamping never accumulates.
    store.cancelTransaction()
    store.beginTransaction()
    const project = useProject.getState().project
    const ui = useUi.getState()
    let delta = dx / pxPerSec
    const points = ui.snapping
      ? snapPoints(project, { playhead: ui.playhead, markers: project.markers, exclude: new Set(d.clipIds), threshold: SNAP_PX / pxPerSec })
      : []
    const thr = SNAP_PX / pxPerSec
    let snapAt: number | null = null

    if (d.kind === 'move') {
      const mode = ui.trimMode
      if (mode === 'slip' || mode === 'slide') {
        trimClips([d.primaryId], 'in', delta, mode)
        return
      }
      // Snap either edge of the primary clip.
      const s1 = snapTime(d.primaryStart + delta, points, thr)
      const s2 = snapTime(d.primaryEnd + delta, points, thr)
      if (s1.snapped) {
        delta = s1.time - d.primaryStart
        snapAt = s1.time
      } else if (s2.snapped) {
        delta = s2.time - d.primaryEnd
        snapAt = s2.time
      }
      const minStart = Math.min(...[...d.origin.values()].map((o) => o.start))
      delta = Math.max(-minStart, delta)
      const target = trackAt(e.clientY)
      const primaryOrigin = d.origin.get(d.primaryId)!
      const primaryTrack = project.tracks.find((t) => t.id === primaryOrigin.trackId)!
      const trackShift = target && target.kind === primaryTrack.kind ? project.tracks.indexOf(target) - project.tracks.indexOf(primaryTrack) : 0
      const moves: ClipMove[] = []
      for (const [id, o] of d.origin) {
        const fromIdx = project.tracks.findIndex((t) => t.id === o.trackId)
        const fromTrack = project.tracks[fromIdx]
        let toTrack = project.tracks[fromIdx + trackShift]
        if (!toTrack || toTrack.kind !== fromTrack.kind || toTrack.locked) toTrack = fromTrack
        moves.push({ clipId: id, start: o.start + delta, trackId: toTrack.id })
      }
      moveClips(moves)
    } else {
      const edge = d.kind === 'trim-in' ? 'in' : 'out'
      const edgeTime = edge === 'in' ? d.primaryStart : d.primaryEnd
      const s = snapTime(edgeTime + delta, points, thr)
      if (s.snapped) {
        delta = s.time - edgeTime
        snapAt = s.time
      }
      trimClips(d.clipIds, edge, delta, ui.trimMode === 'slip' || ui.trimMode === 'slide' ? 'normal' : ui.trimMode)
    }
    ui.setSnapLine(snapAt)
  }

  const onPointerUp = (): void => {
    const d = dragRef.current
    dragRef.current = null
    useUi.getState().setSnapLine(null)
    if (d?.moved) useProject.getState().endTransaction()
  }

  /* ---- Drops from the media bin ---- */
  const onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer.types.includes(ASSET_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const track = trackAt(e.clientY)
    let t = timeAt(e.clientX)
    if (snapping) {
      const project = useProject.getState().project
      t = snapTime(t, snapPoints(project, { playhead, markers, threshold: SNAP_PX / pxPerSec }), SNAP_PX / pxPerSec).time
    }
    setGhost(track ? { trackId: track.id, start: t, duration: 3 } : null)
  }
  const onDrop = (e: DragEvent): void => {
    const assetId = e.dataTransfer.getData(ASSET_MIME)
    setGhost(null)
    if (!assetId) return
    e.preventDefault()
    const ids = insertAsset(assetId, ghost?.trackId ?? trackAt(e.clientY)?.id, ghost?.start ?? timeAt(e.clientX))
    useUi.getState().select({ clipIds: ids })
  }

  const trackStyle = { ['--track-h' as string]: `${TRACK_H}px` }

  return (
    <div className="timeline" style={trackStyle}>
      <div className="tl-corner">
        <button className="icon" title="Add video track" onClick={() => addTrack('video')}>
          +V
        </button>
        <button className="icon" title="Add audio track" onClick={() => addTrack('audio')}>
          +A
        </button>
        <span className="hint" style={{ marginLeft: 'auto', fontSize: 10 }}>
          {trimMode}
        </span>
      </div>
      <div className="tl-ruler" onPointerDown={beginScrub} onPointerMove={moveScrub} onPointerUp={endScrub} onWheel={onWheel}>
        <Ruler width={viewW} scrollX={scrollX} />
      </div>
      <div className="tl-headers" ref={headersRef}>
        {tracks.map((t) => (
          <div key={t.id} className={`tl-header ${t.kind}`}>
            <span className="name" title="Double-click to rename" onDoubleClick={() => {
              const name = prompt('Track name', t.name)
              if (name) patchTrack(t.id, { name })
            }}>
              {t.name}
            </span>
            <button className={t.muted ? 'on' : ''} title="Mute / hide" onClick={() => patchTrack(t.id, { muted: !t.muted })}>
              M
            </button>
            <button className={t.locked ? 'on' : ''} title="Lock" onClick={() => patchTrack(t.id, { locked: !t.locked })}>
              L
            </button>
            <button title="Remove track" onClick={() => tracks.length > 1 && removeTrack(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div
        className={`tl-scroll ${ghost ? 'drop-active' : ''}`}
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          setScrollX(el.scrollLeft)
          useUi.getState().setScrollX(el.scrollLeft)
          if (headersRef.current) headersRef.current.scrollTop = el.scrollTop
        }}
        onWheel={onWheel}
        onDragOver={onDragOver}
        onDragLeave={() => setGhost(null)}
        onDrop={onDrop}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('tl-track')) {
            useUi.getState().clearSelection()
            beginScrub(e)
          }
        }}
        onPointerMove={(e) => {
          moveScrub(e)
          onPointerMove(e)
        }}
        onPointerUp={() => {
          endScrub()
          onPointerUp()
        }}
        onPointerCancel={onPointerUp}
      >
        <div className="tl-content" style={{ width: contentW, height: tracks.length * TRACK_H }}>
          {tracks.map((t) => (
            <div key={t.id} className={`tl-track ${t.locked ? 'locked' : ''} ${ghost?.trackId === t.id ? 'drop-hover' : ''}`}>
              {t.clips.map((c) => (
                <ClipView key={c.id} clip={c} track={t} onPointerDown={onClipPointerDown} />
              ))}
              {t.transitions.map((tr) => (
                <TransitionView key={tr.id} track={t} tr={tr} />
              ))}
              {ghost?.trackId === t.id && <div className="tl-drop-ghost" style={{ left: ghost.start * pxPerSec, width: ghost.duration * pxPerSec }} />}
            </div>
          ))}
          {markers.map((m) => (
            <div key={m.id} className="tl-marker" style={{ left: m.time * pxPerSec, ['--marker' as string]: m.color }} title={m.label} />
          ))}
          {snapLine !== null && <div className="tl-snapline" style={{ left: snapLine * pxPerSec }} />}
          <div className="tl-playhead" style={{ left: playhead * pxPerSec }} />
        </div>
      </div>
    </div>
  )
}

export { HEADER_W, TRACK_H }
