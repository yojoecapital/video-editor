import { SCHEMA_VERSION, type ExportSettings, type Project, type ProjectSettings } from './types'

export function newId(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return prefix ? `${prefix}_${rnd}` : rnd
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000,
  background: '#000000',
}

export const DEFAULT_EXPORT: ExportSettings = {
  container: 'mp4',
  videoCodec: 'libx264',
  crf: 20,
  preset: 'medium',
  audioCodec: 'aac',
  audioBitrateKbps: 192,
}

export function createEmptyProject(name = 'Untitled'): Project {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    settings: { ...DEFAULT_SETTINGS },
    export: { ...DEFAULT_EXPORT },
    assets: [],
    tracks: [
      { id: newId('v'), kind: 'video', name: 'V2', muted: false, locked: false, clips: [], transitions: [] },
      { id: newId('v'), kind: 'video', name: 'V1', muted: false, locked: false, clips: [], transitions: [] },
      { id: newId('a'), kind: 'audio', name: 'A1', muted: false, locked: false, clips: [], transitions: [] },
      { id: newId('a'), kind: 'audio', name: 'A2', muted: false, locked: false, clips: [], transitions: [] },
    ],
    markers: [],
  }
}

/**
 * Migrations are applied in order from the document's version up to
 * SCHEMA_VERSION. Each entry upgrades version N -> N+1 and must be a pure
 * function on a plain JSON object (the YAML has already been parsed).
 */
type Migration = (doc: any) => any
const MIGRATIONS: Record<number, Migration> = {
  // 0 -> 1: pre-release documents had no schemaVersion and no markers/export block.
  0: (doc) => ({
    ...doc,
    export: doc.export ?? { ...DEFAULT_EXPORT },
    markers: doc.markers ?? [],
    tracks: (doc.tracks ?? []).map((t: any) => ({ transitions: [], muted: false, locked: false, ...t })),
  }),
}

export interface MigrationResult {
  project: Project
  migratedFrom?: number
}

export function migrateProject(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== 'object') throw new Error('Project file is empty or not a mapping')
  let doc: any = raw
  const from = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 0
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `Project was saved by a newer version (schema ${from}, this app supports ${SCHEMA_VERSION})`,
    )
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v]
    if (!step) throw new Error(`No migration from schema ${v}`)
    doc = step(doc)
    doc.schemaVersion = v + 1
  }
  const project = normalise(doc)
  return { project, migratedFrom: from !== SCHEMA_VERSION ? from : undefined }
}

/** Fill in defaults for anything optional so the rest of the app can assume shape. */
export function normalise(doc: any): Project {
  const p: Project = {
    schemaVersion: SCHEMA_VERSION,
    name: String(doc.name ?? 'Untitled'),
    settings: { ...DEFAULT_SETTINGS, ...(doc.settings ?? {}) },
    export: { ...DEFAULT_EXPORT, ...(doc.export ?? {}) },
    assets: Array.isArray(doc.assets) ? doc.assets : [],
    tracks: Array.isArray(doc.tracks) ? doc.tracks : [],
    markers: Array.isArray(doc.markers) ? doc.markers : [],
  }
  for (const t of p.tracks) {
    t.clips ??= []
    t.transitions ??= []
    t.muted ??= false
    t.locked ??= false
    for (const c of t.clips) {
      c.props ??= {}
      c.keyframes ??= {}
      c.speed ??= 1
      c.inPoint ??= 0
    }
  }
  return p
}
