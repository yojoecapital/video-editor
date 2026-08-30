import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type { Asset, ExportProgress, ExportRequest, Project, ProxyOptions } from '@shared/types'
import { newId } from '@shared/schema'
import { generateProxy, listEncoders, probe, resolveBinaries } from './ffmpeg'
import { installMediaProtocol, registerMediaScheme } from './protocol'
import {
  clearAutosave,
  fingerprintOf,
  loadAutosave,
  loadProject,
  pendingRecoveries,
  saveProject,
  scratchCacheDir,
  searchForFile,
  writeAutosave,
  type AutosaveRecord,
} from './project-io'
import { startExport, isExporting, type ExportJob } from './export'

// Flatpak: the Chromium sandbox can't nest inside bubblewrap; the zypak
// wrapper from the Electron base-app handles it, but be defensive for
// unwrapped launches too.
if (process.env.FLATPAK_ID && !process.argv.includes('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox')
// Hardware video decode/encode paths in Chromium on Linux.
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,VaapiVideoEncoder,AcceleratedVideoDecodeLinuxGL')
app.commandLine.appendSwitch('ignore-gpu-blocklist')

registerMediaScheme()

let mainWindow: BrowserWindow | undefined
let exportJob: ExportJob | undefined
const preloadPath = path.join(__dirname, '../preload/index.js')

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#141417',
    title: 'Video Editor',
    autoHideMenuBar: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('close', (e) => {
    if (win.webContents.isDestroyed()) return
    // Let the renderer decide (unsaved changes prompt).
    e.preventDefault()
    win.webContents.send('app:close-requested')
  })
  // VE_SMOKE_DIR=<dir with media> VE_SMOKE_OUT=<file> runs the scripted end-to-end
  // scenario in the renderer (see renderer/src/smoke.ts) and exits with a status code.
  const smoke = process.env.VE_SMOKE_DIR ?? (process.env.VE_SMOKE_FILE ? path.dirname(process.env.VE_SMOKE_FILE) : undefined)
  if (smoke) {
    win.webContents.on('console-message', (_e, _level, message) => console.log(`[renderer] ${message}`))
    ipcMain.handle('smoke:done', async (_e, ok: boolean, message: string) => {
      console.log(ok ? `SMOKE OK: ${message}` : `SMOKE FAILED: ${message}`)
      try {
        const img = await win.webContents.capturePage()
        await fs.writeFile(path.join(smoke, 'screenshot.png'), img.toPNG())
      } catch (err) {
        console.log(`screenshot failed: ${(err as Error).message}`)
      }
      setTimeout(() => app.exit(ok ? 0 : 1), 200)
    })
  }
  const query: Record<string, string> | undefined = process.env.VE_SMOKE_FILE
    ? { smokeFile: process.env.VE_SMOKE_FILE }
    : smoke
      ? { smokeDir: smoke, smokeOut: process.env.VE_SMOKE_OUT ?? '' }
      : undefined
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const u = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
    void win.loadURL(u.toString())
  } else void win.loadFile(path.join(__dirname, '../renderer/index.html'), query ? { query } : undefined)
  return win
}

function sendMenu(action: string): void {
  mainWindow?.webContents.send('menu', action)
}

function buildMenu(): void {
  const file: MenuItemConstructorOptions[] = [
    { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
    { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
    { type: 'separator' },
    { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
    { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('saveAs') },
    { type: 'separator' },
    { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: () => sendMenu('import') },
    { label: 'Project Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
    { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export') },
    { type: 'separator' },
    { role: 'quit' },
  ]
  const edit: MenuItemConstructorOptions[] = [
    { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
    { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenu('redo') },
    { type: 'separator' },
    { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => sendMenu('cut') },
    { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendMenu('copy') },
    { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => sendMenu('paste') },
    { label: 'Delete', accelerator: 'Delete', click: () => sendMenu('delete') },
    { label: 'Ripple Delete', accelerator: 'Shift+Delete', click: () => sendMenu('rippleDelete') },
    { type: 'separator' },
    { label: 'Split at Playhead', accelerator: 'S', click: () => sendMenu('split') },
    { label: 'Add Marker', accelerator: 'M', click: () => sendMenu('marker') },
    { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendMenu('selectAll') },
  ]
  const view: MenuItemConstructorOptions[] = [
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => sendMenu('zoomIn') },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => sendMenu('zoomOut') },
    { label: 'Zoom to Fit', accelerator: 'CmdOrCtrl+0', click: () => sendMenu('zoomFit') },
    { type: 'separator' },
    { role: 'togglefullscreen' },
    { role: 'toggleDevTools' },
  ]
  const help: MenuItemConstructorOptions[] = [
    {
      label: 'About',
      click: () =>
        dialog.showMessageBox({
          type: 'info',
          title: 'Video Editor',
          message: `Video Editor ${app.getVersion()}`,
          detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
        }),
    },
  ]
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'File', submenu: file },
      { label: 'Edit', submenu: edit },
      { label: 'View', submenu: view },
      { label: 'Help', submenu: help },
    ]),
  )
}

/* ------------------------------------ IPC ------------------------------------ */

const MEDIA_FILTERS = [
  {
    name: 'Media',
    extensions: [
      'mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv', 'ogv',
      'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff',
      'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif',
    ],
  },
  { name: 'All Files', extensions: ['*'] },
]

function registerIpc(): void {
  ipcMain.handle('dialog:openProject', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: 'Open Project',
      filters: [{ name: 'Video Editor Project', extensions: ['yaml', 'yml'] }],
      properties: ['openFile'],
    })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('dialog:saveProject', async (_e, defaultName: string) => {
    const r = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save Project',
      defaultPath: `${defaultName || 'Untitled'}.yaml`,
      filters: [{ name: 'Video Editor Project', extensions: ['yaml'] }],
    })
    return r.canceled ? undefined : r.filePath
  })
  ipcMain.handle('dialog:importMedia', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: 'Import Media',
      filters: MEDIA_FILTERS,
      properties: ['openFile', 'multiSelections'],
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('dialog:exportPath', async (_e, defaultName: string, ext: string) => {
    const r = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export Video',
      defaultPath: `${defaultName || 'export'}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    })
    return r.canceled ? undefined : r.filePath
  })
  ipcMain.handle('dialog:chooseFile', async (_e, title: string) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title, filters: MEDIA_FILTERS, properties: ['openFile'] })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('dialog:chooseFolder', async (_e, title: string) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openDirectory'] })
    return r.canceled ? undefined : r.filePaths[0]
  })
  ipcMain.handle('dialog:confirm', async (_e, opts: { title: string; message: string; detail?: string; buttons: string[] }) => {
    const r = await dialog.showMessageBox(mainWindow!, { type: 'question', ...opts, cancelId: opts.buttons.length - 1 })
    return r.response
  })
  ipcMain.handle('dialog:error', async (_e, title: string, message: string) => {
    dialog.showErrorBox(title, message)
  })

  ipcMain.handle('project:load', (_e, p: string) => loadProject(p))
  ipcMain.handle('project:save', (_e, project: Project, p: string) => saveProject(project, p))
  ipcMain.handle('project:scratchCacheDir', async () => {
    const d = scratchCacheDir()
    await fs.mkdir(d, { recursive: true })
    return d
  })
  ipcMain.handle('project:autosave', (_e, project: Project, p: string | null) => writeAutosave(project, p))
  ipcMain.handle('project:pendingRecoveries', () => pendingRecoveries())
  ipcMain.handle('project:loadAutosave', (_e, rec: AutosaveRecord) => loadAutosave(rec))
  ipcMain.handle('project:clearAutosave', (_e, p: string) => clearAutosave(p))
  ipcMain.handle('project:setTitle', (_e, title: string) => mainWindow?.setTitle(title))

  ipcMain.handle('media:addAsset', async (_e, file: string): Promise<Asset> => {
    const info = await probe(file)
    return {
      id: newId('m'),
      name: path.basename(file),
      path: file,
      kind: info.kind,
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasVideo: info.hasVideo,
      hasAudio: info.hasAudio,
      sampleRate: info.sampleRate,
      channels: info.channels,
      fingerprint: await fingerprintOf(file),
    }
  })
  ipcMain.handle('media:probe', (_e, file: string) => probe(file))
  ipcMain.handle('media:proxy', (e, asset: Asset, cacheDir: string, opts: ProxyOptions) =>
    generateProxy(asset, cacheDir, opts, (fraction) => {
      if (!e.sender.isDestroyed()) e.sender.send('proxy:progress', { assetId: asset.id, fraction })
    }),
  )
  ipcMain.handle('media:searchForFile', (_e, root: string, name: string) => searchForFile(root, name))
  ipcMain.handle('media:fileExists', async (_e, p: string) => {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('export:listEncoders', () => listEncoders())
  ipcMain.handle('export:start', async (e, req: ExportRequest) => {
    const sender = e.sender
    exportJob = await startExport(req, preloadPath, (p: ExportProgress) => {
      if (!sender.isDestroyed()) sender.send('export:progress-ui', p)
      if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') exportJob = undefined
    })
  })
  ipcMain.handle('export:cancel', () => exportJob?.cancel())
  ipcMain.handle('export:isRunning', () => isExporting())
  ipcMain.handle('shell:showItem', (_e, p: string) => shell.showItemInFolder(p))

  ipcMain.handle('app:closeNow', () => {
    mainWindow?.destroy()
    app.quit()
  })
}

/* ------------------------------------ Boot ------------------------------------ */

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('io.github.yojoe.VideoEditor')
  installMediaProtocol()
  await resolveBinaries()
  registerIpc()
  buildMenu()
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  mainWindow = createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
