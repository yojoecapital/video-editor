import type { Asset, LoadedProject, Project } from '@shared/types'
import { createEmptyProject } from '@shared/schema'
import { media } from './engine/session'
import { useProject } from './store/project'
import { useUi } from './store/ui'

const AUTOSAVE_INTERVAL_MS = 30_000
let lastAutosavedVersion = -1
let currentAutosavePath: string | undefined

export function cacheDirFor(projectPath: string): string {
  const dir = projectPath.slice(0, projectPath.lastIndexOf('/') + 1)
  const base = projectPath.slice(dir.length).replace(/\.ya?ml$/i, '')
  return `${dir}${base}.cache`
}

export function proxyOptions(): import('@shared/types').ProxyOptions {
  const { proxyMode, proxyMaxWidth } = useProject.getState().project.settings
  return { mode: proxyMode, maxWidth: proxyMaxWidth }
}

export function updateTitle(): void {
  const { project, dirty, path } = useProject.getState()
  const name = path ? path.split('/').pop() : project.name
  void window.api.project.setTitle(`${dirty ? '● ' : ''}${name} — Video Editor`)
}

/** Kick off proxy generation for every asset that doesn't have one yet. */
export async function prepareAllMedia(force = false): Promise<void> {
  const { project, cacheDir } = useProject.getState()
  const ui = useUi.getState()
  const todo = project.assets.filter((a) => force || !media.hasSource(a.id))
  if (todo.length === 0) return
  ui.setStatus(`Preparing ${todo.length} media file${todo.length > 1 ? 's' : ''}…`)
  let failures = 0
  // Two at a time keeps the machine responsive while still using several cores.
  const queue = [...todo]
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const a = queue.shift()!
      try {
        await media.prepare(a, cacheDir, proxyOptions())
      } catch (err) {
        failures++
        console.error('proxy failed', a.name, err)
      } finally {
        ui.setProxyProgress(a.id, 1)
      }
    }
  }
  await Promise.all([worker(), worker()])
  ui.setStatus(failures ? `${failures} media file(s) could not be prepared` : '')
}

export function loadIntoEditor(loaded: LoadedProject, opts: { dirty?: boolean; autosavePath?: string } = {}): void {
  media.dispose()
  useProject.getState().replace(loaded.project, loaded.path || null, loaded.cacheDir, { dirty: opts.dirty })
  useUi.getState().clearSelection()
  useUi.getState().setPlayhead(0)
  lastAutosavedVersion = useProject.getState().version
  currentAutosavePath = opts.autosavePath
  updateTitle()
  void prepareAllMedia()
  if (loaded.missing.length > 0) useUi.getState().openDialog({ kind: 'relink', missing: loaded.missing })
  if (loaded.migratedFrom !== undefined) useUi.getState().setStatus(`Project upgraded from schema v${loaded.migratedFrom}`)
}

/** Returns true if it is safe to discard the current document. */
export async function confirmDiscard(): Promise<boolean> {
  const s = useProject.getState()
  if (!s.dirty) return true
  const r = await window.api.dialogs.confirm({
    title: 'Unsaved changes',
    message: `Save changes to "${s.project.name}"?`,
    buttons: ['Save', "Don't Save", 'Cancel'],
  })
  if (r === 0) return saveProject(false)
  return r === 1
}

export async function newProject(): Promise<void> {
  if (!(await confirmDiscard())) return
  const cacheDir = await window.api.project.scratchCacheDir()
  loadIntoEditor({ project: createEmptyProject(), path: '', cacheDir, missing: [] })
}

export async function openProject(path?: string): Promise<void> {
  if (!(await confirmDiscard())) return
  const p = path ?? (await window.api.dialogs.openProject())
  if (!p) return
  try {
    const loaded = await window.api.project.load(p)
    loadIntoEditor(loaded)
  } catch (err) {
    await window.api.dialogs.error('Could not open project', (err as Error).message)
  }
}

export async function saveProject(saveAs: boolean): Promise<boolean> {
  const s = useProject.getState()
  let path = s.path
  if (saveAs || !path) {
    path = (await window.api.dialogs.saveProject(s.project.name)) ?? null
    if (!path) return false
    if (!/\.ya?ml$/i.test(path)) path += '.yaml'
  }
  try {
    const wasScratch = !s.path
    const name = path.split('/').pop()!.replace(/\.ya?ml$/i, '')
    const project: Project = { ...s.project, name }
    await window.api.project.save(project, path)
    const cacheDir = cacheDirFor(path)
    useProject.setState({ project })
    s.markSaved(path, cacheDir)
    if (currentAutosavePath) {
      await window.api.project.clearAutosave(currentAutosavePath)
      currentAutosavePath = undefined
    }
    lastAutosavedVersion = useProject.getState().version
    updateTitle()
    if (wasScratch) void prepareAllMedia(true)
    useUi.getState().setStatus(`Saved ${path}`)
    return true
  } catch (err) {
    await window.api.dialogs.error('Save failed', (err as Error).message)
    return false
  }
}

export async function importFiles(paths?: string[]): Promise<Asset[]> {
  const files = paths ?? (await window.api.dialogs.importMedia())
  if (files.length === 0) return []
  const added: Asset[] = []
  const errors: string[] = []
  for (const f of files) {
    try {
      added.push(await window.api.media.addAsset(f))
    } catch (err) {
      errors.push(`${f.split('/').pop()}: ${(err as Error).message}`)
    }
  }
  if (added.length) {
    useProject.getState().update((p) => {
      for (const a of added) if (!p.assets.some((x) => x.path === a.path)) p.assets.push(a)
    })
    updateTitle()
    void prepareAllMedia()
  }
  if (errors.length) await window.api.dialogs.error('Some files could not be imported', errors.join('\n'))
  return added
}

export function startAutosave(): () => void {
  const timer = window.setInterval(async () => {
    const s = useProject.getState()
    if (!s.dirty || s.version === lastAutosavedVersion || s.txBase !== null) return
    try {
      const rec = await window.api.project.autosave(s.project, s.path)
      currentAutosavePath = rec.autosavePath
      lastAutosavedVersion = s.version
    } catch (err) {
      console.error('autosave failed', err)
    }
  }, AUTOSAVE_INTERVAL_MS)
  return () => clearInterval(timer)
}

export async function checkRecovery(): Promise<void> {
  const records = await window.api.project.pendingRecoveries()
  if (records.length) useUi.getState().openDialog({ kind: 'recovery', records })
}

export async function requestClose(): Promise<void> {
  const running = await window.api.exporter.isRunning()
  if (running) {
    const r = await window.api.dialogs.confirm({ title: 'Export in progress', message: 'An export is still running. Quit anyway?', buttons: ['Quit', 'Cancel'] })
    if (r !== 0) return
  }
  if (await confirmDiscard()) {
    if (currentAutosavePath) await window.api.project.clearAutosave(currentAutosavePath).catch(() => undefined)
    await window.api.closeNow()
  }
}
