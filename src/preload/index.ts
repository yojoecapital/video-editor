import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Asset, EncoderInfo, ExportProgress, ExportRequest, LoadedProject, ProbeResult, Project, ProxyInfo } from '@shared/types'

type Unsubscribe = () => void
function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  platform: process.platform,
  isFlatpak: !!process.env.FLATPAK_ID,
  /** Absolute path of a File dropped from the desktop (undefined for portal-backed drops without a path). */
  pathOf: (file: File): string | undefined => {
    try {
      return webUtils.getPathForFile(file) || undefined
    } catch {
      return undefined
    }
  },

  dialogs: {
    openProject: (): Promise<string | undefined> => ipcRenderer.invoke('dialog:openProject'),
    saveProject: (defaultName: string): Promise<string | undefined> => ipcRenderer.invoke('dialog:saveProject', defaultName),
    importMedia: (): Promise<string[]> => ipcRenderer.invoke('dialog:importMedia'),
    exportPath: (defaultName: string, ext: string): Promise<string | undefined> => ipcRenderer.invoke('dialog:exportPath', defaultName, ext),
    chooseFile: (title: string): Promise<string | undefined> => ipcRenderer.invoke('dialog:chooseFile', title),
    chooseFolder: (title: string): Promise<string | undefined> => ipcRenderer.invoke('dialog:chooseFolder', title),
    confirm: (opts: { title: string; message: string; detail?: string; buttons: string[] }): Promise<number> =>
      ipcRenderer.invoke('dialog:confirm', opts),
    error: (title: string, message: string): Promise<void> => ipcRenderer.invoke('dialog:error', title, message),
  },

  project: {
    load: (p: string): Promise<LoadedProject> => ipcRenderer.invoke('project:load', p),
    save: (project: Project, p: string): Promise<void> => ipcRenderer.invoke('project:save', project, p),
    scratchCacheDir: (): Promise<string> => ipcRenderer.invoke('project:scratchCacheDir'),
    autosave: (project: Project, p: string | null): Promise<{ autosavePath: string }> => ipcRenderer.invoke('project:autosave', project, p),
    pendingRecoveries: (): Promise<Array<{ projectPath: string | null; autosavePath: string; savedAt: number }>> =>
      ipcRenderer.invoke('project:pendingRecoveries'),
    loadAutosave: (rec: { projectPath: string | null; autosavePath: string; savedAt: number }): Promise<LoadedProject> =>
      ipcRenderer.invoke('project:loadAutosave', rec),
    clearAutosave: (p: string): Promise<void> => ipcRenderer.invoke('project:clearAutosave', p),
    setTitle: (t: string): Promise<void> => ipcRenderer.invoke('project:setTitle', t),
  },

  media: {
    addAsset: (file: string): Promise<Asset> => ipcRenderer.invoke('media:addAsset', file),
    probe: (file: string): Promise<ProbeResult> => ipcRenderer.invoke('media:probe', file),
    proxy: (asset: Asset, cacheDir: string): Promise<ProxyInfo> => ipcRenderer.invoke('media:proxy', asset, cacheDir),
    onProxyProgress: (cb: (p: { assetId: string; fraction: number }) => void): Unsubscribe => on('proxy:progress', cb),
    searchForFile: (root: string, name: string): Promise<string | undefined> => ipcRenderer.invoke('media:searchForFile', root, name),
    fileExists: (p: string): Promise<boolean> => ipcRenderer.invoke('media:fileExists', p),
    /** Build a `media://` URL the renderer can use in <video>/<img>/fetch. */
    url: (filePath: string): string => `media://${encodeURI(filePath).replace(/#/g, '%23').replace(/\?/g, '%3F')}`,
  },

  exporter: {
    listEncoders: (): Promise<EncoderInfo[]> => ipcRenderer.invoke('export:listEncoders'),
    start: (req: ExportRequest): Promise<void> => ipcRenderer.invoke('export:start', req),
    cancel: (): Promise<void> => ipcRenderer.invoke('export:cancel'),
    isRunning: (): Promise<boolean> => ipcRenderer.invoke('export:isRunning'),
    onProgress: (cb: (p: ExportProgress) => void): Unsubscribe => on('export:progress-ui', cb),
    showItem: (p: string): Promise<void> => ipcRenderer.invoke('shell:showItem', p),
  },

  /** Used only by the hidden export renderer. */
  exportWorker: {
    onRequest: (
      cb: (req: ExportRequest & { audioWavs: Record<string, string>; videoSources: Record<string, string>; width: number; height: number }) => void,
    ): Unsubscribe => on('export:request', cb),
    sendAudio: (wav: ArrayBuffer | undefined): Promise<void> => ipcRenderer.invoke('export:audio', wav),
    sendFrame: (rgba: ArrayBuffer): Promise<boolean> => ipcRenderer.invoke('export:frame', rgba),
    progress: (p: Partial<ExportProgress>): void => ipcRenderer.send('export:progress', p),
    done: (): Promise<void> => ipcRenderer.invoke('export:done'),
    error: (message: string): Promise<void> => ipcRenderer.invoke('export:error', message),
  },

  smokeDone: (ok: boolean, message: string): Promise<void> => ipcRenderer.invoke('smoke:done', ok, message),
  onMenu: (cb: (action: string) => void): Unsubscribe => on('menu', cb),
  onCloseRequested: (cb: () => void): Unsubscribe => on('app:close-requested', () => cb()),
  closeNow: (): Promise<void> => ipcRenderer.invoke('app:closeNow'),
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
