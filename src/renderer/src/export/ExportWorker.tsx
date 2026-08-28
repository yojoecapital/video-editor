import { useEffect, useRef, useState } from 'react'
import type { ExportRequest } from '@shared/types'
import { projectDuration } from '@shared/timeline'
import { encodeWav, scheduleTimeline } from '../engine/audio'
import { Compositor } from '../engine/compositor'
import { MediaManager } from '../engine/media'
import { renderFrame } from '../engine/renderer'

type Req = ExportRequest & { audioWavs: Record<string, string>; videoSources: Record<string, string>; width: number; height: number }

/**
 * Runs inside the hidden export window. Mixes audio offline, then composites
 * every frame at full resolution and streams raw RGBA to the main process.
 */
export default function ExportWorker(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [log, setLog] = useState('waiting for request')

  useEffect(() => {
    const off = window.api.exportWorker.onRequest((req) => {
      void run(req, canvasRef.current!, setLog)
    })
    return off
  }, [])

  return (
    <div style={{ padding: 12, fontFamily: 'monospace', fontSize: 12 }}>
      <div>{log}</div>
      <canvas ref={canvasRef} style={{ width: 320 }} />
    </div>
  )
}

async function run(req: Req, canvas: HTMLCanvasElement, log: (s: string) => void): Promise<void> {
  const w = window.api.exportWorker
  try {
    const { project } = req
    const fps = project.settings.fps
    const rangeStart = req.rangeStart ?? 0
    const rangeEnd = req.rangeEnd ?? projectDuration(project)
    const duration = Math.max(0, rangeEnd - rangeStart)
    const url = window.api.media.url

    const media = new MediaManager()
    for (const a of project.assets) {
      const videoSrc = req.videoSources[a.id]
      const audioSrc = req.audioWavs[a.id]
      if (!videoSrc && !audioSrc) continue
      media.setSource(a.id, {
        width: a.width,
        height: a.height,
        videoUrl: a.kind === 'video' && videoSrc ? url(videoSrc) : undefined,
        imageUrl: a.kind === 'image' && videoSrc ? url(videoSrc) : undefined,
        audioUrl: audioSrc ? url(audioSrc) : undefined,
      })
    }

    /* ---- Audio ---- */
    log('mixing audio')
    w.progress({ phase: 'audio' })
    const sr = project.settings.sampleRate
    const hasAudio = project.tracks.some((t) => t.kind === 'audio' && !t.muted && t.clips.some((c) => req.audioWavs[c.assetId]))
    if (hasAudio && duration > 0) {
      const offline = new OfflineAudioContext(2, Math.ceil(duration * sr), sr)
      const buffers = new Map<string, AudioBuffer>()
      for (const a of project.assets) {
        const p = media.audioBuffer(a.id, offline)
        if (p) buffers.set(a.id, await p)
      }
      scheduleTimeline(offline, offline.destination, project, buffers, rangeStart, 0, rangeEnd)
      const mixed = await offline.startRendering()
      const wav = encodeWav(mixed)
      await w.sendAudio(wav)
    } else await w.sendAudio(undefined)

    /* ---- Video ---- */
    const comp = new Compositor(canvas, req.width, req.height, { preserveDrawingBuffer: true })
    const totalFrames = Math.ceil(duration * fps)
    log(`rendering ${totalFrames} frames`)
    for (let f = 0; f < totalFrames; f++) {
      const t = rangeStart + f / fps
      await renderFrame(comp, media, project, t, { seek: true, tolerance: 0.25 / fps })
      const pixels = comp.readPixels()
      const ok = await w.sendFrame(pixels.buffer as ArrayBuffer)
      if (!ok) {
        log('cancelled')
        return
      }
    }
    log('finishing')
    await w.done()
  } catch (err) {
    log(`error: ${(err as Error).message}`)
    await w.error((err as Error).stack ?? String(err))
  }
}
