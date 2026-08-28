import { BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { ExportProgress, ExportRequest } from '@shared/types'
import { extractAudioWav, startEncoder, tempDir, type EncoderHandle } from './ffmpeg'
import { ensureDecodable } from './media'

/**
 * Export runs in its own hidden renderer process: the compositor draws every
 * frame with WebGL at full resolution, and the raw RGBA frames are piped into
 * an ffmpeg encoder started here. The main UI window stays responsive and
 * only receives progress events.
 */
export interface ExportJob {
  cancel(): void
}

let current: { window: BrowserWindow; encoder?: EncoderHandle; cancelled: boolean } | undefined

export function isExporting(): boolean {
  return !!current
}

export async function startExport(
  req: ExportRequest,
  preloadPath: string,
  onProgress: (p: ExportProgress) => void,
): Promise<ExportJob> {
  if (current) throw new Error('An export is already running')
  const { project } = req
  const width = req.project.export.width ?? project.settings.width
  const height = req.project.export.height ?? project.settings.height
  const fps = project.settings.fps

  const work = path.join(tempDir(), `export-${Date.now()}`)
  await fs.mkdir(work, { recursive: true })

  onProgress({ phase: 'preparing', frame: 0, totalFrames: 0, fps: 0 })

  // Decode every used asset's audio to float WAV so the renderer can use
  // decodeAudioData regardless of the source container.
  const usedAssetIds = new Set<string>()
  for (const t of project.tracks) for (const c of t.clips) usedAssetIds.add(c.assetId)
  const audioWavs: Record<string, string> = {}
  const videoSources: Record<string, string> = {}
  for (const a of project.assets) {
    if (!usedAssetIds.has(a.id)) continue
    if (a.hasAudio) {
      const out = path.join(work, `${a.id}.wav`)
      await extractAudioWav(a.path, out, project.settings.sampleRate)
      audioWavs[a.id] = out
    }
    if (a.hasVideo) videoSources[a.id] = await ensureDecodable(a, req.cacheDir)
  }

  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  current = { window: win, cancelled: false }

  const cleanup = async (): Promise<void> => {
    ipcMain.removeHandler('export:audio')
    ipcMain.removeHandler('export:frame')
    ipcMain.removeHandler('export:done')
    ipcMain.removeHandler('export:error')
    ipcMain.removeAllListeners('export:progress')
    if (!win.isDestroyed()) win.destroy()
    current = undefined
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  }

  let encoder: EncoderHandle | undefined
  let frame = 0
  const totalFrames = Math.ceil(((req.rangeEnd ?? 0) - (req.rangeStart ?? 0)) * fps)
  let started = Date.now()

  ipcMain.handle('export:audio', async (_e, wav: ArrayBuffer | undefined) => {
    let audioWav: string | undefined
    if (wav && wav.byteLength > 0) {
      audioWav = path.join(work, 'mix.wav')
      await fs.writeFile(audioWav, Buffer.from(wav))
    }
    encoder = startEncoder({ settings: project.export, width, height, fps, audioWav, output: req.outputPath })
    if (current) current.encoder = encoder
    started = Date.now()
    onProgress({ phase: 'video', frame: 0, totalFrames, fps: 0 })
  })

  ipcMain.handle('export:frame', async (_e, rgba: ArrayBuffer) => {
    if (!encoder || current?.cancelled) return false
    await encoder.writeFrame(new Uint8Array(rgba))
    frame++
    if (frame % 5 === 0 || frame === totalFrames) {
      const elapsed = (Date.now() - started) / 1000
      onProgress({ phase: 'video', frame, totalFrames, fps: elapsed > 0 ? frame / elapsed : 0 })
    }
    return !current?.cancelled
  })

  ipcMain.on('export:progress', (_e, p: Partial<ExportProgress>) => {
    onProgress({ phase: 'audio', frame, totalFrames, fps: 0, ...p })
  })

  ipcMain.handle('export:done', async () => {
    try {
      onProgress({ phase: 'muxing', frame, totalFrames, fps: 0 })
      await encoder?.finish()
      onProgress({ phase: 'done', frame, totalFrames, fps: 0, message: req.outputPath })
    } catch (err) {
      onProgress({ phase: 'error', frame, totalFrames, fps: 0, message: (err as Error).message })
    } finally {
      await cleanup()
    }
  })

  ipcMain.handle('export:error', async (_e, message: string) => {
    encoder?.cancel()
    onProgress({ phase: 'error', frame, totalFrames, fps: 0, message })
    await cleanup()
  })

  win.webContents.on('render-process-gone', async (_e, details) => {
    encoder?.cancel()
    onProgress({ phase: 'error', frame, totalFrames, fps: 0, message: `Export renderer crashed (${details.reason})` })
    await cleanup()
  })

  win.webContents.once('did-finish-load', () => {
    win.webContents.send('export:request', { ...req, audioWavs, videoSources, width, height })
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mode=export`)
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { mode: 'export' } })
  }

  return {
    cancel() {
      if (!current) return
      current.cancelled = true
      encoder?.cancel()
      onProgress({ phase: 'cancelled', frame, totalFrames, fps: 0 })
      void cleanup()
      fs.rm(req.outputPath, { force: true }).catch(() => undefined)
    },
  }
}
