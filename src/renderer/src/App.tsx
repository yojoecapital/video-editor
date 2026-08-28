import { useEffect, useRef } from 'react'
import type { TrimMode } from '@shared/timeline'
import { projectDuration } from '@shared/timeline'
import { useProject } from './store/project'
import { useUi } from './store/ui'
import { getPlayer } from './engine/session'
import { addMarker, addTransitionToSelection, copySelection, deleteClips, paste, splitAt } from './actions'
import { checkRecovery, importFiles, newProject, openProject, requestClose, saveProject, startAutosave, updateTitle } from './lifecycle'
import MediaBin from './components/MediaBin'
import Preview from './components/Preview'
import Timeline from './components/Timeline'
import Inspector from './components/Inspector'
import { ExportDialog, RecoveryDialog, RelinkDialog, SettingsDialog } from './components/Dialogs'

const TRIM_MODES: Array<{ mode: TrimMode; label: string; key: string; hint: string }> = [
  { mode: 'normal', label: 'Select', key: 'V', hint: 'Move clips; trim edges' },
  { mode: 'ripple', label: 'Ripple', key: 'B', hint: 'Trim and close the gap' },
  { mode: 'roll', label: 'Roll', key: 'N', hint: 'Move the cut between two clips' },
  { mode: 'slip', label: 'Slip', key: 'Y', hint: 'Drag a clip to change its source range' },
  { mode: 'slide', label: 'Slide', key: 'U', hint: 'Drag a clip; neighbours absorb the move' },
]

function runMenu(action: string): void {
  const ui = useUi.getState()
  const store = useProject.getState()
  const player = getPlayer()
  switch (action) {
    case 'new':
      void newProject()
      break
    case 'open':
      void openProject()
      break
    case 'save':
      void saveProject(false)
      break
    case 'saveAs':
      void saveProject(true)
      break
    case 'import':
      void importFiles()
      break
    case 'settings':
      ui.openDialog({ kind: 'settings' })
      break
    case 'export':
      player?.pause()
      ui.openDialog({ kind: 'export' })
      break
    case 'undo':
      store.undo()
      break
    case 'redo':
      store.redo()
      break
    case 'cut':
      copySelection()
      deleteClips(ui.selection.clipIds)
      break
    case 'copy':
      copySelection()
      break
    case 'paste':
      paste(ui.playhead)
      break
    case 'delete':
      if (ui.selection.transitionId) {
        store.update((p) => {
          for (const t of p.tracks) t.transitions = t.transitions.filter((x) => x.id !== ui.selection.transitionId)
        })
        ui.clearSelection()
      } else deleteClips(ui.selection.clipIds)
      break
    case 'rippleDelete':
      deleteClips(ui.selection.clipIds, true)
      break
    case 'split':
      splitAt(ui.playhead, ui.selection.clipIds.length ? ui.selection.clipIds : undefined)
      break
    case 'marker':
      addMarker(ui.playhead)
      break
    case 'selectAll': {
      const ids: string[] = []
      for (const t of store.project.tracks) for (const c of t.clips) ids.push(c.id)
      ui.select({ clipIds: ids })
      break
    }
    case 'zoomIn':
      ui.setZoom(ui.pxPerSec * 1.5)
      break
    case 'zoomOut':
      ui.setZoom(ui.pxPerSec / 1.5)
      break
    case 'zoomFit': {
      const d = projectDuration(store.project)
      const w = window.innerWidth - 150 - 40
      ui.setZoom(d > 0 ? w / d : 60)
      break
    }
  }
}

export default function App(): JSX.Element {
  const dialog = useUi((s) => s.dialog)
  const status = useUi((s) => s.status)
  const trimMode = useUi((s) => s.trimMode)
  const snapping = useUi((s) => s.snapping)
  const dirty = useProject((s) => s.dirty)
  const name = useProject((s) => s.project.name)
  const canUndo = useProject((s) => s.undoStack.length > 0)
  const canRedo = useProject((s) => s.redoStack.length > 0)
  const shuttle = useRef(0)

  useEffect(() => {
    updateTitle()
    const offMenu = window.api.onMenu(runMenu)
    const offClose = window.api.onCloseRequested(() => void requestClose())
    const stopAutosave = startAutosave()
    void (async () => {
      const cacheDir = await window.api.project.scratchCacheDir()
      useProject.getState().setCacheDir(cacheDir)
      const params = new URLSearchParams(location.search)
      const smokeDir = params.get('smokeDir')
      if (smokeDir) {
        const { runSmoke } = await import('./smoke')
        // Give the preview canvas a frame to mount before driving it.
        setTimeout(() => void runSmoke(smokeDir, params.get('smokeOut') || `${smokeDir}/smoke-out.mp4`), 500)
        return
      }
      await checkRecovery()
    })()
    return () => {
      offMenu()
      offClose()
      stopAutosave()
    }
  }, [])

  useEffect(() => updateTitle(), [dirty, name])

  // Keyboard shortcuts (menu accelerators cover the Ctrl-combinations).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (useUi.getState().dialog.kind !== 'none') return
      const ui = useUi.getState()
      const player = getPlayer()
      const fps = useProject.getState().project.settings.fps
      const dur = projectDuration(useProject.getState().project)
      const stepTo = (t: number): void => {
        player?.pause()
        ui.setPlayhead(Math.max(0, Math.min(dur, Math.round(t * fps) / fps)))
      }
      if (e.ctrlKey || e.metaKey) return
      switch (e.code) {
        case 'Space':
          e.preventDefault()
          shuttle.current = 0
          player?.toggle()
          break
        case 'KeyK':
          shuttle.current = 0
          player?.pause()
          break
        case 'KeyL':
          if (player?.playing) stepTo(ui.playhead + 1)
          else void player?.play()
          break
        case 'KeyJ':
          player?.pause()
          stepTo(ui.playhead - 1)
          break
        case 'ArrowLeft':
          e.preventDefault()
          stepTo(ui.playhead - (e.shiftKey ? 10 : 1) / fps)
          break
        case 'ArrowRight':
          e.preventDefault()
          stepTo(ui.playhead + (e.shiftKey ? 10 : 1) / fps)
          break
        case 'Home':
          stepTo(0)
          break
        case 'End':
          stepTo(dur)
          break
        case 'KeyS':
          runMenu('split')
          break
        case 'KeyM':
          runMenu('marker')
          break
        case 'KeyT':
          addTransitionToSelection()
          break
        case 'Delete':
        case 'Backspace':
          runMenu(e.shiftKey ? 'rippleDelete' : 'delete')
          break
        case 'Escape':
          ui.clearSelection()
          break
        case 'KeyV':
          ui.setTrimMode('normal')
          break
        case 'KeyB':
          ui.setTrimMode('ripple')
          break
        case 'KeyN':
          ui.setTrimMode('roll')
          break
        case 'KeyY':
          ui.setTrimMode('slip')
          break
        case 'KeyU':
          ui.setTrimMode('slide')
          break
        case 'KeyG':
          ui.toggleSnapping()
          break
        case 'Equal':
        case 'NumpadAdd':
          runMenu('zoomIn')
          break
        case 'Minus':
        case 'NumpadSubtract':
          runMenu('zoomOut')
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app">
      <div className="toolbar">
        <span className="title">
          {name}
          {dirty ? ' •' : ''}
        </span>
        <div className="group">
          <button className="icon" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => runMenu('undo')}>
            ↶
          </button>
          <button className="icon" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => runMenu('redo')}>
            ↷
          </button>
        </div>
        <div className="group">
          {TRIM_MODES.map((m) => (
            <button key={m.mode} className={trimMode === m.mode ? 'active' : ''} title={`${m.hint} (${m.key})`} onClick={() => useUi.getState().setTrimMode(m.mode)}>
              {m.label}
            </button>
          ))}
        </div>
        <button className={snapping ? 'active' : ''} title="Snapping (G)" onClick={() => useUi.getState().toggleSnapping()}>
          Snap
        </button>
        <button title="Split at playhead (S)" onClick={() => runMenu('split')}>
          Split
        </button>
        <button title="Add transition at cut (T)" onClick={() => addTransitionToSelection()}>
          Transition
        </button>
        <span className="spacer" />
        <button onClick={() => runMenu('settings')}>Settings</button>
        <button className="primary" onClick={() => runMenu('export')}>
          Export
        </button>
      </div>
      <MediaBin />
      <Splitter axis="h" varName="--bin-w" area="hsplit1" sign={1} />
      <Preview />
      <Splitter axis="h" varName="--inspector-w" area="hsplit2" sign={-1} />
      <Inspector />
      <Splitter axis="v" varName="--timeline-h" area="vsplit" sign={-1} />
      <Timeline />
      {status && <div className="status-bar">{status}</div>}
      {dialog.kind === 'settings' && <SettingsDialog />}
      {dialog.kind === 'export' && <ExportDialog />}
      {dialog.kind === 'relink' && <RelinkDialog missing={dialog.missing} />}
      {dialog.kind === 'recovery' && <RecoveryDialog records={dialog.records} />}
    </div>
  )
}

/** Drag handle that resizes a CSS grid track via a custom property on .app. */
function Splitter({ axis, varName, area, sign }: { axis: 'h' | 'v'; varName: string; area: string; sign: 1 | -1 }): JSX.Element {
  const onPointerDown = (e: React.PointerEvent): void => {
    const app = (e.currentTarget as HTMLElement).parentElement!
    const startPos = axis === 'h' ? e.clientX : e.clientY
    const startVal = parseFloat(getComputedStyle(app).getPropertyValue(varName)) || (axis === 'h' ? 260 : 320)
    const move = (ev: PointerEvent): void => {
      const d = ((axis === 'h' ? ev.clientX : ev.clientY) - startPos) * sign
      app.style.setProperty(varName, `${Math.max(150, startVal + d)}px`)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div className={axis === 'h' ? 'splitter-h' : 'splitter-v'} style={{ gridArea: area }} onPointerDown={onPointerDown} />
}
