import { create } from 'zustand'
import type { TrimMode } from '@shared/timeline'

export type Dialog =
  | { kind: 'none' }
  | { kind: 'settings' }
  | { kind: 'export' }
  | { kind: 'relink'; missing: Array<{ assetId: string; name: string; lastPath: string }> }
  | { kind: 'recovery'; records: Array<{ projectPath: string | null; autosavePath: string; savedAt: number }> }

export interface Selection {
  clipIds: string[]
  transitionId?: string
  assetId?: string
}

interface UiState {
  playhead: number
  playing: boolean
  /** Timeline zoom: pixels per second. */
  pxPerSec: number
  scrollX: number
  trimMode: TrimMode
  snapping: boolean
  selection: Selection
  dialog: Dialog
  status: string
  snapLine: number | null
  proxyProgress: Record<string, number>
  /** Clipboard holds copies of clips (start relative to earliest). */
  clipboard: import('@shared/types').Clip[]

  setPlayhead(t: number): void
  setPlaying(p: boolean): void
  setZoom(pxPerSec: number): void
  setScrollX(x: number): void
  setTrimMode(m: TrimMode): void
  toggleSnapping(): void
  select(sel: Selection): void
  selectClip(id: string, additive?: boolean): void
  clearSelection(): void
  openDialog(d: Dialog): void
  closeDialog(): void
  setStatus(s: string): void
  setSnapLine(t: number | null): void
  setProxyProgress(assetId: string, fraction: number): void
  setClipboard(c: import('@shared/types').Clip[]): void
}

export const useUi = create<UiState>((set, get) => ({
  playhead: 0,
  playing: false,
  pxPerSec: 60,
  scrollX: 0,
  trimMode: 'normal',
  snapping: true,
  selection: { clipIds: [] },
  dialog: { kind: 'none' },
  status: '',
  snapLine: null,
  proxyProgress: {},
  clipboard: [],

  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (pxPerSec) => set({ pxPerSec: Math.min(2000, Math.max(2, pxPerSec)) }),
  setScrollX: (scrollX) => set({ scrollX }),
  setTrimMode: (trimMode) => set({ trimMode }),
  toggleSnapping: () => set({ snapping: !get().snapping }),
  select: (selection) => set({ selection }),
  selectClip: (id, additive) => {
    const cur = get().selection.clipIds
    if (additive) set({ selection: { clipIds: cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id] } })
    else set({ selection: { clipIds: [id] } })
  },
  clearSelection: () => set({ selection: { clipIds: [] } }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: { kind: 'none' } }),
  setStatus: (status) => set({ status }),
  setSnapLine: (snapLine) => set({ snapLine }),
  setProxyProgress: (assetId, fraction) =>
    set((s) => {
      const next = { ...s.proxyProgress }
      if (fraction >= 1) delete next[assetId]
      else next[assetId] = fraction
      return { proxyProgress: next }
    }),
  setClipboard: (clipboard) => set({ clipboard }),
}))
