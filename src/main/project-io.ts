import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { app } from 'electron'
import type { Asset, LoadedProject, MissingAsset, Project } from '@shared/types'
import { migrateProject } from '@shared/schema'

/** Cache/proxy directory that lives next to the project file. */
export function cacheDirFor(projectPath: string): string {
  const base = path.basename(projectPath).replace(/\.ya?ml$/i, '')
  return path.join(path.dirname(projectPath), `${base}.cache`)
}

/** Cache directory for a project that has never been saved. */
export function scratchCacheDir(): string {
  return path.join(app.getPath('userData'), 'scratch-cache')
}

export async function saveProject(project: Project, projectPath: string): Promise<void> {
  const dir = path.dirname(projectPath)
  const doc: Project = {
    ...project,
    assets: project.assets.map((a) => ({ ...a, relPath: path.relative(dir, a.path) })),
  }
  const text = YAML.stringify(doc, { lineWidth: 0 })
  const tmp = `${projectPath}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, projectPath)
  await fs.mkdir(cacheDirFor(projectPath), { recursive: true })
}

export async function fingerprintOf(file: string): Promise<Asset['fingerprint'] | undefined> {
  try {
    const st = await fs.stat(file)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * Locate an asset: absolute path first, then relative to the project file, then
 * by file name in the project directory tree (shallow).
 */
async function locateAsset(asset: Asset, projectDir: string): Promise<string | undefined> {
  if (existsSync(asset.path)) return asset.path
  if (asset.relPath) {
    const rel = path.resolve(projectDir, asset.relPath)
    if (existsSync(rel)) return rel
  }
  const byName = path.join(projectDir, path.basename(asset.path))
  if (existsSync(byName)) return byName
  return undefined
}

export async function loadProject(projectPath: string): Promise<LoadedProject> {
  const text = await fs.readFile(projectPath, 'utf8')
  const raw = YAML.parse(text)
  const { project, migratedFrom } = migrateProject(raw)
  const projectDir = path.dirname(projectPath)
  const missing: MissingAsset[] = []
  for (const a of project.assets) {
    const found = await locateAsset(a, projectDir)
    if (found) a.path = found
    else missing.push({ assetId: a.id, name: a.name, lastPath: a.path })
  }
  const cacheDir = cacheDirFor(projectPath)
  await fs.mkdir(cacheDir, { recursive: true })
  return { project, path: projectPath, cacheDir, missing, migratedFrom }
}

/** Recursively search `root` for a file with the given name (bounded depth). */
export async function searchForFile(root: string, fileName: string, maxDepth = 6): Promise<string | undefined> {
  const queue: Array<[string, number]> = [[root, 0]]
  while (queue.length) {
    const [dir, depth] = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isFile() && e.name === fileName) return full
      if (e.isDirectory() && depth < maxDepth && !e.name.startsWith('.') && e.name !== 'node_modules') queue.push([full, depth + 1])
    }
  }
  return undefined
}

/* ---------------------------------- Autosave ---------------------------------- */

export interface AutosaveRecord {
  /** Original project path, or null if it was never saved. */
  projectPath: string | null
  autosavePath: string
  savedAt: number
}

function autosaveIndexPath(): string {
  return path.join(app.getPath('userData'), 'autosave-index.json')
}

async function readIndex(): Promise<AutosaveRecord[]> {
  try {
    return JSON.parse(await fs.readFile(autosaveIndexPath(), 'utf8'))
  } catch {
    return []
  }
}

async function writeIndex(list: AutosaveRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(autosaveIndexPath()), { recursive: true })
  await fs.writeFile(autosaveIndexPath(), JSON.stringify(list, null, 2))
}

export async function writeAutosave(project: Project, projectPath: string | null): Promise<AutosaveRecord> {
  const dir = projectPath ? cacheDirFor(projectPath) : path.join(app.getPath('userData'), 'autosave')
  await fs.mkdir(dir, { recursive: true })
  const autosavePath = path.join(dir, projectPath ? 'autosave.yaml' : `untitled-${process.pid}.yaml`)
  const doc = projectPath
    ? { ...project, assets: project.assets.map((a) => ({ ...a, relPath: path.relative(path.dirname(projectPath), a.path) })) }
    : project
  const tmp = `${autosavePath}.tmp`
  await fs.writeFile(tmp, YAML.stringify(doc, { lineWidth: 0 }), 'utf8')
  await fs.rename(tmp, autosavePath)
  const rec: AutosaveRecord = { projectPath, autosavePath, savedAt: Date.now() }
  const list = (await readIndex()).filter((r) => r.autosavePath !== autosavePath)
  list.push(rec)
  await writeIndex(list)
  return rec
}

/** Remove the autosave for a path once the user has saved cleanly (or discarded). */
export async function clearAutosave(autosavePath: string): Promise<void> {
  await fs.rm(autosavePath, { force: true })
  await writeIndex((await readIndex()).filter((r) => r.autosavePath !== autosavePath))
}

/** Autosaves that still exist and are newer than their project file: crash-recovery candidates. */
export async function pendingRecoveries(): Promise<AutosaveRecord[]> {
  const list = await readIndex()
  const out: AutosaveRecord[] = []
  for (const r of list) {
    if (!existsSync(r.autosavePath)) continue
    if (r.projectPath) {
      try {
        const st = await fs.stat(r.projectPath)
        if (st.mtimeMs >= r.savedAt) continue
      } catch {
        /* project file gone: still offer */
      }
    }
    out.push(r)
  }
  await writeIndex(out)
  return out
}

export async function loadAutosave(rec: AutosaveRecord): Promise<LoadedProject> {
  const loaded = await loadProject(rec.autosavePath)
  const cacheDir = rec.projectPath ? cacheDirFor(rec.projectPath) : scratchCacheDir()
  await fs.mkdir(cacheDir, { recursive: true })
  return { ...loaded, path: rec.projectPath ?? '', cacheDir }
}
