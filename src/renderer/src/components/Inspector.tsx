import { useEffect, useState } from 'react'
import type { Clip, ClipProp, Easing, Track, TransitionType } from '@shared/types'
import { AUDIO_PROPS, clipProp, VIDEO_PROPS } from '@shared/interp'
import { clipEnd, findClip, formatTimecode } from '@shared/timeline'
import { useProject } from '../store/project'
import { useUi } from '../store/ui'
import {
  addTransitionToSelection,
  clearKeyframes,
  removeKeyframe,
  removeTransition,
  resetProp,
  setClipProp,
  setClipSpeed,
  setKeyframeEasing,
  toggleKeyframe,
  unlinkClips,
  updateTransition,
} from '../actions'
import { relinkAsset } from '../actions'
import { media } from '../engine/session'

const PROP_META: Record<ClipProp, { label: string; min: number; max: number; step: number; unit?: string }> = {
  opacity: { label: 'Opacity', min: 0, max: 1, step: 0.01 },
  scale: { label: 'Scale', min: 0, max: 4, step: 0.01 },
  x: { label: 'Position X', min: -2000, max: 2000, step: 1, unit: 'px' },
  y: { label: 'Position Y', min: -2000, max: 2000, step: 1, unit: 'px' },
  rotation: { label: 'Rotation', min: -180, max: 180, step: 0.5, unit: '°' },
  cropLeft: { label: 'Crop left', min: 0, max: 0.95, step: 0.005 },
  cropTop: { label: 'Crop top', min: 0, max: 0.95, step: 0.005 },
  cropRight: { label: 'Crop right', min: 0, max: 0.95, step: 0.005 },
  cropBottom: { label: 'Crop bottom', min: 0, max: 0.95, step: 0.005 },
  volume: { label: 'Volume', min: 0, max: 2, step: 0.01 },
}

const VIDEO_TRANSITIONS: TransitionType[] = ['crossDissolve', 'fadeBlack', 'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown', 'slideLeft', 'slideRight']
const AUDIO_TRANSITIONS: TransitionType[] = ['crossfade', 'fade']
const EASINGS: Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']

function PropRow({ clip, prop, time }: { clip: Clip; prop: ClipProp; time: number }): JSX.Element {
  const meta = PROP_META[prop]
  const local = Math.max(0, Math.min(clip.duration, time - clip.start))
  const kfs = clip.keyframes[prop]
  const animated = !!kfs && kfs.length > 0
  const onKf = animated && kfs.some((k) => Math.abs(k.time - local) < 1e-3)
  const value = clipProp(clip, prop, local)
  const [draft, setDraft] = useState<string | null>(null)
  const canvas = useProject((s) => s.project.settings)
  const min = prop === 'x' ? -canvas.width : prop === 'y' ? -canvas.height : meta.min
  const max = prop === 'x' ? canvas.width : prop === 'y' ? canvas.height : meta.max

  const commit = (v: number, record = true): void => setClipProp(clip.id, prop, v, time, record)

  return (
    <>
      <div className="prop-row">
        <button
          className={`kf-btn ${animated ? 'animated' : ''} ${onKf ? 'on' : ''}`}
          title={animated ? (onKf ? 'Remove keyframe here' : 'Add keyframe here') : 'Enable keyframes'}
          onClick={() => toggleKeyframe(clip.id, prop, time)}
        >
          ◆
        </button>
        <label onDoubleClick={() => resetProp(clip.id, prop)} title="Double-click to reset">
          {meta.label}
        </label>
        <input
          type="range"
          min={min}
          max={max}
          step={meta.step}
          value={value}
          onPointerDown={() => useProject.getState().beginTransaction()}
          onPointerUp={() => useProject.getState().endTransaction()}
          onChange={(e) => commit(Number(e.target.value), false)}
        />
        <input
          type="number"
          step={meta.step}
          value={draft ?? (Math.round(value * 1000) / 1000).toString()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null && !Number.isNaN(Number(draft))) commit(Number(draft))
            setDraft(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
        />
      </div>
      {animated && (
        <div className="kf-list">
          {kfs!.map((k) => (
            <div key={k.time}>
              <span
                style={{ cursor: 'pointer', color: Math.abs(k.time - local) < 1e-3 ? 'var(--accent-2)' : undefined }}
                onClick={() => useUi.getState().setPlayhead(clip.start + k.time)}
              >
                {k.time.toFixed(2)}s
              </span>
              <span>= {Math.round(k.value * 1000) / 1000}</span>
              <select value={k.easing} onChange={(e) => setKeyframeEasing(clip.id, prop, k.time, e.target.value as Easing)}>
                {EASINGS.map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
              <button className="icon" style={{ padding: '0 5px' }} onClick={() => removeKeyframe(clip.id, prop, k.time)}>
                ×
              </button>
            </div>
          ))}
          <div>
            <button style={{ fontSize: 10 }} onClick={() => clearKeyframes(clip.id, prop, time)}>
              Remove animation
            </button>
          </div>
        </div>
      )}
    </>
  )
}

function ClipInspector({ clip, track }: { clip: Clip; track: Track }): JSX.Element {
  const time = useUi((s) => s.playhead)
  const asset = useProject((s) => s.project.assets.find((a) => a.id === clip.assetId))
  const fps = useProject((s) => s.project.settings.fps)
  const props = track.kind === 'video' ? VIDEO_PROPS : AUDIO_PROPS
  const [speedDraft, setSpeedDraft] = useState<string | null>(null)
  const inside = time >= clip.start && time <= clipEnd(clip)

  return (
    <>
      <div className="inspector-section">
        <h3>Clip</h3>
        <div className="field">
          <label>Source</label>
          <span title={asset?.path}>{asset?.name ?? 'missing'}</span>
        </div>
        <div className="field">
          <label>Start</label>
          <span className="timecode" style={{ fontSize: 12, minWidth: 0 }}>
            {formatTimecode(clip.start, fps)}
          </span>
        </div>
        <div className="field">
          <label>Duration</label>
          <span className="timecode" style={{ fontSize: 12, minWidth: 0 }}>
            {formatTimecode(clip.duration, fps)}
          </span>
        </div>
        {asset?.kind !== 'image' && (
          <div className="field">
            <label>In point</label>
            <span className="timecode" style={{ fontSize: 12, minWidth: 0 }}>
              {formatTimecode(clip.inPoint, fps)}
            </span>
          </div>
        )}
        {asset?.kind !== 'image' && (
          <div className="field">
            <label>Speed</label>
            <div className="inline">
              <input
                type="number"
                min={0.05}
                max={16}
                step={0.05}
                value={speedDraft ?? clip.speed}
                onChange={(e) => setSpeedDraft(e.target.value)}
                onBlur={() => {
                  if (speedDraft !== null && Number(speedDraft) > 0) setClipSpeed(clip.id, Number(speedDraft))
                  setSpeedDraft(null)
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              {[0.5, 1, 2].map((s) => (
                <button key={s} className="icon" onClick={() => setClipSpeed(clip.id, s)}>
                  ×{s}
                </button>
              ))}
            </div>
          </div>
        )}
        {clip.linkedClipId && (
          <div className="field">
            <label>Linked</label>
            <button onClick={() => unlinkClips([clip.id])}>Unlink audio/video</button>
          </div>
        )}
        <div className="field">
          <label>Transition</label>
          <button onClick={() => addTransitionToSelection()}>Add at cut / fade</button>
        </div>
      </div>
      <div className="inspector-section">
        <h3>{track.kind === 'video' ? 'Transform & Crop' : 'Audio'}</h3>
        {!inside && <div className="hint" style={{ marginBottom: 6 }}>Playhead is outside this clip; keyframes are written at the nearest edge.</div>}
        {props.map((p) => (
          <PropRow key={p} clip={clip} prop={p} time={time} />
        ))}
      </div>
    </>
  )
}

function TransitionInspector({ id }: { id: string }): JSX.Element | null {
  const found = useProject((s) => {
    for (const t of s.project.tracks) {
      const tr = t.transitions.find((x) => x.id === id)
      if (tr) return { tr, track: t }
    }
    return undefined
  })
  if (!found) return null
  const { tr, track } = found
  const types = track.kind === 'audio' ? AUDIO_TRANSITIONS : VIDEO_TRANSITIONS
  return (
    <div className="inspector-section">
      <h3>Transition</h3>
      <div className="field">
        <label>Type</label>
        <select value={tr.type} onChange={(e) => updateTransition(tr.id, { type: e.target.value as TransitionType })}>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Duration</label>
        <div className="inline">
          <input
            type="range"
            min={0.1}
            max={5}
            step={0.05}
            value={tr.duration}
            onPointerDown={() => useProject.getState().beginTransaction()}
            onPointerUp={() => useProject.getState().endTransaction()}
            onChange={(e) => updateTransition(tr.id, { duration: Number(e.target.value) })}
          />
          <span style={{ minWidth: 40 }}>{tr.duration.toFixed(2)}s</span>
        </div>
      </div>
      <div className="field">
        <label>Between</label>
        <span className="hint">
          {tr.outClipId ? 'clip' : 'start'} → {tr.inClipId ? 'clip' : 'end'}
        </span>
      </div>
      <button
        onClick={() => {
          removeTransition(tr.id)
          useUi.getState().clearSelection()
        }}
      >
        Remove transition
      </button>
    </div>
  )
}

function AssetInspector({ assetId }: { assetId: string }): JSX.Element | null {
  const asset = useProject((s) => s.project.assets.find((a) => a.id === assetId))
  const [exists, setExists] = useState(true)
  useEffect(() => {
    if (asset) void window.api.media.fileExists(asset.path).then(setExists)
  }, [asset?.path])
  if (!asset) return null
  const relink = async (): Promise<void> => {
    const p = await window.api.dialogs.chooseFile(`Locate ${asset.name}`)
    if (!p) return
    try {
      const probe = await window.api.media.probe(p)
      relinkAsset(asset.id, p, probe)
      const a = useProject.getState().project.assets.find((x) => x.id === asset.id)!
      await media.prepare(a, useProject.getState().cacheDir)
    } catch (err) {
      await window.api.dialogs.error('Relink failed', (err as Error).message)
    }
  }
  return (
    <div className="inspector-section">
      <h3>Media</h3>
      <div className="field">
        <label>Name</label>
        <span>{asset.name}</span>
      </div>
      <div className="field">
        <label>Path</label>
        <span className={exists ? 'hint' : 'error'} style={{ wordBreak: 'break-all', userSelect: 'text' }}>
          {asset.path}
          {!exists && ' (missing)'}
        </span>
      </div>
      <div className="field">
        <label>Type</label>
        <span>
          {asset.kind}
          {asset.hasVideo ? ` · ${asset.width}×${asset.height}` : ''}
          {asset.fps ? ` @ ${Math.round(asset.fps * 100) / 100}fps` : ''}
          {asset.hasAudio ? ` · ${asset.channels ?? 2}ch ${asset.sampleRate ?? ''}Hz` : ''}
        </span>
      </div>
      <div className="field">
        <label>Duration</label>
        <span>{asset.duration.toFixed(2)}s</span>
      </div>
      <button onClick={() => void relink()}>Relink…</button>
    </div>
  )
}

export default function Inspector(): JSX.Element {
  const selection = useUi((s) => s.selection)
  const found = useProject((s) => (selection.clipIds[0] ? findClip(s.project, selection.clipIds[0]) : undefined))
  return (
    <div className="panel inspector">
      <div className="panel-header">Inspector</div>
      <div className="panel-body">
        {selection.transitionId ? (
          <TransitionInspector id={selection.transitionId} />
        ) : found ? (
          <ClipInspector key={found.clip.id} clip={found.clip} track={found.track} />
        ) : selection.assetId ? (
          <AssetInspector assetId={selection.assetId} />
        ) : (
          <div className="inspector-empty">Select a clip, transition or media item.</div>
        )}
        {selection.clipIds.length > 1 && <div className="hint" style={{ padding: 10 }}>{selection.clipIds.length} clips selected — showing the first.</div>}
      </div>
    </div>
  )
}
