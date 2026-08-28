import { create } from 'zustand'
import { produce } from 'immer'
import type { Project } from '@shared/types'
import { createEmptyProject } from '@shared/schema'

const MAX_HISTORY = 200

interface ProjectState {
  project: Project
  /** Absolute path of the .yaml, or null while unsaved. */
  path: string | null
  cacheDir: string
  dirty: boolean
  /** Increments on every project change; used for cache invalidation. */
  version: number
  undoStack: Project[]
  redoStack: Project[]
  /** Snapshot captured by beginTransaction(), pushed on endTransaction(). */
  txBase: Project | null

  replace(project: Project, path: string | null, cacheDir: string, opts?: { dirty?: boolean }): void
  /** Mutate via immer; recorded in undo history unless inside a transaction or record:false. */
  update(fn: (draft: Project) => void, opts?: { record?: boolean }): void
  beginTransaction(): void
  endTransaction(): void
  cancelTransaction(): void
  undo(): void
  redo(): void
  markSaved(path: string, cacheDir: string): void
  setCacheDir(dir: string): void
}

export const useProject = create<ProjectState>((set, get) => ({
  project: createEmptyProject(),
  path: null,
  cacheDir: '',
  dirty: false,
  version: 0,
  undoStack: [],
  redoStack: [],
  txBase: null,

  replace(project, path, cacheDir, opts) {
    set((s) => ({ project, path, cacheDir, dirty: opts?.dirty ?? false, version: s.version + 1, undoStack: [], redoStack: [], txBase: null }))
  },

  update(fn, opts) {
    const s = get()
    const next = produce(s.project, fn)
    if (next === s.project) return
    const record = opts?.record !== false && s.txBase === null
    set({
      project: next,
      dirty: true,
      version: s.version + 1,
      undoStack: record ? [...s.undoStack.slice(-MAX_HISTORY + 1), s.project] : s.undoStack,
      redoStack: record ? [] : s.redoStack,
    })
  },

  beginTransaction() {
    const s = get()
    if (s.txBase === null) set({ txBase: s.project })
  },

  endTransaction() {
    const s = get()
    if (s.txBase === null) return
    if (s.txBase !== s.project) {
      set({ undoStack: [...s.undoStack.slice(-MAX_HISTORY + 1), s.txBase], redoStack: [], txBase: null })
    } else set({ txBase: null })
  },

  cancelTransaction() {
    const s = get()
    if (s.txBase === null) return
    set({ project: s.txBase, txBase: null, version: s.version + 1 })
  },

  undo() {
    const s = get()
    if (s.txBase !== null || s.undoStack.length === 0) return
    const prev = s.undoStack[s.undoStack.length - 1]
    set({
      project: prev,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, s.project],
      dirty: true,
      version: s.version + 1,
    })
  },

  redo() {
    const s = get()
    if (s.txBase !== null || s.redoStack.length === 0) return
    const next = s.redoStack[s.redoStack.length - 1]
    set({
      project: next,
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, s.project],
      dirty: true,
      version: s.version + 1,
    })
  },

  markSaved(path, cacheDir) {
    set({ path, cacheDir, dirty: false })
  },
  setCacheDir(dir) {
    set({ cacheDir: dir })
  },
}))
