import { useEffect, useState } from 'react'
import type { AudioCodec, Container, EncoderInfo, ExportProgress, VideoCodec } from '@shared/types'
import { projectDuration } from '@shared/timeline'
import { useProject } from '../store/project'
import { useUi } from '../store/ui'
import { relinkAsset } from '../actions'
import { media } from '../engine/session'
import { loadIntoEditor, prepareAllMedia } from '../lifecycle'

function Modal({ title, children, actions }: { title: string; children: React.ReactNode; actions: React.ReactNode }): JSX.Element {
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="modal">
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  )
}

/* ------------------------------ Project settings ------------------------------ */

const PRESETS = [
  { label: '1080p (1920×1080)', w: 1920, h: 1080 },
  { label: '4K UHD (3840×2160)', w: 3840, h: 2160 },
  { label: '720p (1280×720)', w: 1280, h: 720 },
  { label: 'Vertical 1080×1920', w: 1080, h: 1920 },
  { label: 'Square 1080×1080', w: 1080, h: 1080 },
]

export function SettingsDialog(): JSX.Element {
  const settings = useProject((s) => s.project.settings)
  const [draft, setDraft] = useState({ ...settings })
  const close = useUi((s) => s.closeDialog)
  const apply = (): void => {
    useProject.getState().update((p) => {
      p.settings = {
        ...draft,
        width: Math.max(16, Math.round(draft.width / 2) * 2),
        height: Math.max(16, Math.round(draft.height / 2) * 2),
        fps: Math.max(1, draft.fps),
      }
    })
    close()
  }
  return (
    <Modal
      title="Project Settings"
      actions={
        <>
          <button onClick={close}>Cancel</button>
          <button className="primary" onClick={apply}>
            Apply
          </button>
        </>
      }
    >
      <div className="field">
        <label>Preset</label>
        <select value="" onChange={(e) => {
          const p = PRESETS[Number(e.target.value)]
          if (p) setDraft({ ...draft, width: p.w, height: p.h })
        }}>
          <option value="">Choose…</option>
          {PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Width</label>
        <input type="number" value={draft.width} onChange={(e) => setDraft({ ...draft, width: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label>Height</label>
        <input type="number" value={draft.height} onChange={(e) => setDraft({ ...draft, height: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label>Frame rate</label>
        <select value={draft.fps} onChange={(e) => setDraft({ ...draft, fps: Number(e.target.value) })}>
          {[23.976, 24, 25, 29.97, 30, 50, 59.94, 60].map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Audio rate</label>
        <select value={draft.sampleRate} onChange={(e) => setDraft({ ...draft, sampleRate: Number(e.target.value) })}>
          <option value={44100}>44100 Hz</option>
          <option value={48000}>48000 Hz</option>
        </select>
      </div>
      <div className="field">
        <label>Background</label>
        <input type="text" value={draft.background} onChange={(e) => setDraft({ ...draft, background: e.target.value })} />
      </div>
    </Modal>
  )
}

/* ----------------------------------- Export ----------------------------------- */

const CONTAINERS: Container[] = ['mp4', 'mkv', 'mov', 'webm']
const AUDIO_CODECS: AudioCodec[] = ['aac', 'libopus', 'flac', 'pcm_s16le']

function codecsFor(container: Container, encoders: EncoderInfo[]): EncoderInfo[] {
  return encoders.filter((e) => {
    if (container === 'webm') return e.name === 'libvpx-vp9'
    return e.name !== 'libvpx-vp9'
  })
}

export function ExportDialog(): JSX.Element {
  const project = useProject((s) => s.project)
  const cacheDir = useProject((s) => s.cacheDir)
  const close = useUi((s) => s.closeDialog)
  const [encoders, setEncoders] = useState<EncoderInfo[]>([])
  const [draft, setDraft] = useState({ ...project.export })
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [outPath, setOutPath] = useState<string | null>(null)
  const duration = projectDuration(project)

  useEffect(() => {
    void window.api.exporter.listEncoders().then(setEncoders)
    return window.api.exporter.onProgress(setProgress)
  }, [])

  const available = codecsFor(draft.container, encoders)
  const validCodec = available.some((e) => e.name === draft.videoCodec && e.available)

  const start = async (): Promise<void> => {
    const codec = validCodec ? draft.videoCodec : (available.find((e) => e.available)?.name ?? 'libx264')
    const settings = { ...draft, videoCodec: codec as VideoCodec }
    useProject.getState().update((p) => {
      p.export = settings
    })
    const path = await window.api.dialogs.exportPath(project.name, settings.container)
    if (!path) return
    setOutPath(path)
    setProgress({ phase: 'preparing', frame: 0, totalFrames: 0, fps: 0 })
    try {
      await window.api.exporter.start({ project: { ...project, export: settings }, cacheDir, outputPath: path, rangeStart: 0, rangeEnd: duration })
    } catch (err) {
      setProgress({ phase: 'error', frame: 0, totalFrames: 0, fps: 0, message: (err as Error).message })
    }
  }

  const running = progress && !['done', 'error', 'cancelled'].includes(progress.phase)
  const pct = progress && progress.totalFrames > 0 ? (progress.frame / progress.totalFrames) * 100 : 0
  const hw = encoders.filter((e) => e.hardware && e.available).map((e) => e.name)

  return (
    <Modal
      title="Export"
      actions={
        running ? (
          <button onClick={() => void window.api.exporter.cancel()}>Cancel export</button>
        ) : progress?.phase === 'done' ? (
          <>
            <button onClick={() => outPath && void window.api.exporter.showItem(outPath)}>Show in folder</button>
            <button className="primary" onClick={close}>
              Close
            </button>
          </>
        ) : (
          <>
            <button onClick={close}>Close</button>
            <button className="primary" onClick={() => void start()} disabled={duration <= 0}>
              Export…
            </button>
          </>
        )
      }
    >
      {progress ? (
        <div>
          <div>
            {progress.phase === 'preparing' && 'Preparing sources (extracting audio, checking decoders)…'}
            {progress.phase === 'audio' && 'Mixing audio…'}
            {progress.phase === 'video' && `Rendering frame ${progress.frame} / ${progress.totalFrames} (${progress.fps.toFixed(1)} fps)`}
            {progress.phase === 'muxing' && 'Finishing encode…'}
            {progress.phase === 'done' && `Done: ${progress.message}`}
            {progress.phase === 'cancelled' && 'Cancelled.'}
            {progress.phase === 'error' && <span className="error">Export failed: {progress.message}</span>}
          </div>
          <div className="progress">
            <div style={{ width: `${progress.phase === 'done' ? 100 : pct}%` }} />
          </div>
          {progress.phase === 'error' && <button onClick={() => setProgress(null)}>Back</button>}
        </div>
      ) : (
        <>
          <div className="field">
            <label>Container</label>
            <select value={draft.container} onChange={(e) => setDraft({ ...draft, container: e.target.value as Container })}>
              {CONTAINERS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Video codec</label>
            <select value={validCodec ? draft.videoCodec : ''} onChange={(e) => setDraft({ ...draft, videoCodec: e.target.value as VideoCodec })}>
              {!validCodec && <option value="">Choose…</option>}
              {available.map((e) => (
                <option key={e.name} value={e.name} disabled={!e.available}>
                  {e.label}
                  {e.available ? '' : ' (unavailable)'}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Quality (CRF/QP)</label>
            <div className="inline">
              <input type="range" min={0} max={51} value={draft.crf} onChange={(e) => setDraft({ ...draft, crf: Number(e.target.value) })} />
              <span style={{ minWidth: 24 }}>{draft.crf}</span>
            </div>
          </div>
          <div className="field">
            <label>Bitrate (kbps)</label>
            <input
              type="number"
              placeholder="auto (use quality)"
              value={draft.bitrateKbps ?? ''}
              onChange={(e) => setDraft({ ...draft, bitrateKbps: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
          {(draft.videoCodec === 'libx264' || draft.videoCodec === 'libx265') && (
            <div className="field">
              <label>Preset</label>
              <select value={draft.preset} onChange={(e) => setDraft({ ...draft, preset: e.target.value })}>
                {['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label>Audio codec</label>
            <select value={draft.audioCodec} onChange={(e) => setDraft({ ...draft, audioCodec: e.target.value as AudioCodec })}>
              {AUDIO_CODECS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Audio bitrate</label>
            <input type="number" value={draft.audioBitrateKbps} onChange={(e) => setDraft({ ...draft, audioBitrateKbps: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>Output size</label>
            <div className="inline">
              <input type="number" placeholder={String(project.settings.width)} value={draft.width ?? ''} onChange={(e) => setDraft({ ...draft, width: e.target.value ? Number(e.target.value) : undefined })} />
              ×
              <input type="number" placeholder={String(project.settings.height)} value={draft.height ?? ''} onChange={(e) => setDraft({ ...draft, height: e.target.value ? Number(e.target.value) : undefined })} />
            </div>
          </div>
          <p className="hint">
            {duration.toFixed(1)}s · {Math.ceil(duration * project.settings.fps)} frames at {project.settings.fps} fps.
            {hw.length ? ` Hardware encoders detected: ${hw.join(', ')}.` : ' No hardware encoders detected; using software encoding.'}
          </p>
        </>
      )}
    </Modal>
  )
}

/* ----------------------------------- Relink ----------------------------------- */

export function RelinkDialog({ missing }: { missing: Array<{ assetId: string; name: string; lastPath: string }> }): JSX.Element {
  const [remaining, setRemaining] = useState(missing)
  const close = useUi((s) => s.closeDialog)

  const link = async (assetId: string, path: string): Promise<boolean> => {
    try {
      const probe = await window.api.media.probe(path)
      relinkAsset(assetId, path, probe)
      const a = useProject.getState().project.assets.find((x) => x.id === assetId)
      if (a) void media.prepare(a, useProject.getState().cacheDir)
      setRemaining((r) => r.filter((m) => m.assetId !== assetId))
      return true
    } catch (err) {
      await window.api.dialogs.error('Relink failed', (err as Error).message)
      return false
    }
  }

  const locate = async (m: { assetId: string; name: string }): Promise<void> => {
    const p = await window.api.dialogs.chooseFile(`Locate ${m.name}`)
    if (p) await link(m.assetId, p)
  }

  const searchFolder = async (): Promise<void> => {
    const dir = await window.api.dialogs.chooseFolder('Search folder for missing media')
    if (!dir) return
    for (const m of remaining) {
      const found = await window.api.media.searchForFile(dir, m.name)
      if (found) await link(m.assetId, found)
    }
  }

  useEffect(() => {
    if (remaining.length === 0) {
      close()
      void prepareAllMedia()
    }
  }, [remaining.length])

  return (
    <Modal
      title="Missing media"
      actions={
        <>
          <button onClick={() => void searchFolder()}>Search folder…</button>
          <button className="primary" onClick={close}>
            Skip for now
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginBottom: 8 }}>
        {remaining.length} file{remaining.length === 1 ? '' : 's'} could not be found. Clips stay on the timeline; relink to restore playback.
      </p>
      <div className="list">
        {remaining.map((m) => (
          <div key={m.assetId} className="list-row">
            <div className="grow">
              <div>{m.name}</div>
              <div className="hint" style={{ fontSize: 10 }}>{m.lastPath}</div>
            </div>
            <button onClick={() => void locate(m)}>Locate…</button>
          </div>
        ))}
      </div>
    </Modal>
  )
}

/* ---------------------------------- Recovery ---------------------------------- */

export function RecoveryDialog({ records }: { records: Array<{ projectPath: string | null; autosavePath: string; savedAt: number }> }): JSX.Element {
  const close = useUi((s) => s.closeDialog)
  const [list, setList] = useState(records)
  const recover = async (rec: (typeof records)[number]): Promise<void> => {
    try {
      const loaded = await window.api.project.loadAutosave(rec)
      loadIntoEditor(loaded, { dirty: true, autosavePath: rec.autosavePath })
      close()
    } catch (err) {
      await window.api.dialogs.error('Recovery failed', (err as Error).message)
    }
  }
  const discard = async (rec: (typeof records)[number]): Promise<void> => {
    await window.api.project.clearAutosave(rec.autosavePath)
    setList((l) => l.filter((x) => x !== rec))
  }
  useEffect(() => {
    if (list.length === 0) close()
  }, [list.length])
  return (
    <Modal
      title="Recover unsaved work?"
      actions={
        <button onClick={close}>Later</button>
      }
    >
      <p className="hint" style={{ marginBottom: 8 }}>
        The app did not shut down cleanly last time. Autosaved copies were found:
      </p>
      <div className="list">
        {list.map((r) => (
          <div key={r.autosavePath} className="list-row">
            <div className="grow">
              <div>{r.projectPath ? r.projectPath.split('/').pop() : 'Untitled project'}</div>
              <div className="hint" style={{ fontSize: 10 }}>
                {new Date(r.savedAt).toLocaleString()} · {r.projectPath ?? 'never saved'}
              </div>
            </div>
            <button onClick={() => void discard(r)}>Discard</button>
            <button className="primary" onClick={() => void recover(r)}>
              Recover
            </button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
