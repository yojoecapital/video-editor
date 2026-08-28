import { useEffect, useRef, useState } from 'react'
import { formatTimecode, projectDuration } from '@shared/timeline'
import { attachCanvas, detachCanvas, getPlayer } from '../engine/session'
import { useProject } from '../store/project'
import { useUi } from '../store/ui'

export default function Preview(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playhead = useUi((s) => s.playhead)
  const playing = useUi((s) => s.playing)
  const settings = useProject((s) => s.project.settings)
  const duration = useProject((s) => projectDuration(s.project))
  const [cacheInfo, setCacheInfo] = useState('')

  // Mount the compositor + player on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current!
    let player
    try {
      player = attachCanvas(canvas)
    } catch (err) {
      console.error(err)
      useUi.getState().setStatus(`Preview unavailable: ${(err as Error).message}`)
      return
    }
    const offTime = player.onTime((t, p) => {
      const ui = useUi.getState()
      if (ui.playhead !== t) ui.setPlayhead(t)
      if (ui.playing !== p) useUi.setState({ playing: p })
    })
    const offProject = useProject.subscribe((s, prev) => {
      if (s.version !== prev.version) {
        const pl = getPlayer()
        if (!pl) return
        const { width, height } = s.project.settings
        pl.comp.resize(width, height)
        pl.projectChanged()
        const ids = new Set<string>()
        for (const t of s.project.tracks) for (const c of t.clips) ids.add(c.id)
        pl.media.retain(ids)
      }
    })
    void player.renderAt(0)
    const infoTimer = window.setInterval(() => {
      const pl = getPlayer()
      if (pl) setCacheInfo(`${pl.cache.size} cached`)
    }, 1000)
    return () => {
      offTime()
      offProject()
      clearInterval(infoTimer)
      detachCanvas()
    }
  }, [])

  // Playhead moved from the timeline/keyboard: seek the player.
  useEffect(() => {
    const pl = getPlayer()
    if (!pl) return
    if (Math.abs(pl.time - playhead) > 1e-6) pl.seek(playhead)
  }, [playhead])

  const fps = settings.fps
  const step = (frames: number): void => {
    const pl = getPlayer()
    if (!pl) return
    if (pl.playing) pl.pause()
    useUi.getState().setPlayhead(Math.max(0, Math.round(pl.time * fps + frames) / fps))
  }

  return (
    <div className="panel preview">
      <div className="preview-canvas-wrap">
        <canvas ref={canvasRef} style={{ aspectRatio: `${settings.width} / ${settings.height}` }} />
        <div className="preview-overlay">
          {settings.width}×{settings.height} @ {fps}fps · {cacheInfo}
        </div>
      </div>
      <div className="transport">
        <button className="icon" title="Go to start (Home)" onClick={() => useUi.getState().setPlayhead(0)}>
          ⏮
        </button>
        <button className="icon" title="Previous frame (←)" onClick={() => step(-1)}>
          ◀︎
        </button>
        <button className="icon primary" title="Play / Pause (Space)" onClick={() => getPlayer()?.toggle()} style={{ minWidth: 44 }}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="icon" title="Next frame (→)" onClick={() => step(1)}>
          ▶︎
        </button>
        <button className="icon" title="Go to end (End)" onClick={() => useUi.getState().setPlayhead(duration)}>
          ⏭
        </button>
        <span className="timecode">{formatTimecode(playhead, fps)}</span>
        <span className="hint">/ {formatTimecode(duration, fps)}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="hint">
          <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> shuttle · <kbd>S</kbd> split · <kbd>M</kbd> marker
        </span>
      </div>
    </div>
  )
}
