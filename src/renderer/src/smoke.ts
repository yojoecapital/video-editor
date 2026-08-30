/**
 * Scripted end-to-end scenario used by `npm run smoke`. Exercises import,
 * proxy generation, timeline editing, keyframes, transitions, preview
 * rendering and a full export through the real IPC surface.
 */
import { clipEnd, findClip, projectDuration } from '@shared/timeline'
import { addTransition, insertAsset, setClipProp, setClipSpeed, splitAt, toggleKeyframe, trimClips } from './actions'
import { getPlayer, media } from './engine/session'
import { importFiles, prepareAllMedia, saveProject } from './lifecycle'
import { useProject } from './store/project'
import { useUi } from './store/ui'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

let started = false

export async function runSmoke(dir: string, out: string): Promise<void> {
  if (started) return // StrictMode double-invokes the mounting effect in dev
  started = true
  const log = (m: string): void => console.log(`smoke: ${m}`)
  try {
    const files = ['clipA.mp4', 'clipB.mkv', 'music.mp3', 'still.png', 'prores.mov'].map((f) => `${dir}/${f}`)
    log('importing')
    const assets = await importFiles(files)
    assert(assets.length === 5, `imported ${assets.length}/5`)
    const byName = (n: string): string => assets.find((a) => a.name === n)!.id
    assert(assets.find((a) => a.name === 'still.png')!.kind === 'image', 'png is image')
    assert(assets.find((a) => a.name === 'music.mp3')!.kind === 'audio', 'mp3 is audio')

    log('waiting for proxies')
    await prepareAllMedia()
    for (const a of assets) assert(media.hasSource(a.id), `proxy for ${a.name}`)

    log('building timeline')
    const p = (): ReturnType<typeof useProject.getState>['project'] => useProject.getState().project
    const [a1] = insertAsset(byName('clipA.mp4'), undefined, 0)
    const aEnd = clipEnd(findClip(p(), a1)!.clip)
    const [b1] = insertAsset(byName('clipB.mkv'), undefined, aEnd)
    const bEnd = clipEnd(findClip(p(), b1)!.clip)
    const [img] = insertAsset(byName('still.png'), undefined, bEnd)
    const [pr] = insertAsset(byName('prores.mov'), undefined, clipEnd(findClip(p(), img)!.clip))
    const audioTrack = p().tracks.filter((t) => t.kind === 'audio')[1]
    const [mus] = insertAsset(byName('music.mp3'), audioTrack.id, 1)
    assert(findClip(p(), mus)!.track.kind === 'audio', 'music landed on audio track')
    assert(findClip(p(), a1)!.clip.linkedClipId, 'video clip has linked audio')

    // Trim + ripple + split + speed.
    trimClips([a1], 'out', -1, 'normal')
    useProject.getState().update(() => undefined) // no-op keeps history simple
    assert(Math.abs(findClip(p(), a1)!.clip.duration - 5) < 1e-6, 'normal trim shortened clip A to 5s')
    trimClips([b1], 'in', 0.5, 'ripple')
    const bClip = findClip(p(), b1)!.clip
    assert(Math.abs(bClip.inPoint - 0.5) < 1e-6, 'ripple trim moved in-point')
    assert(Math.abs(findClip(p(), img)!.clip.start - clipEnd(bClip)) < 1e-6, 'ripple closed the gap')
    splitAt(2, [a1])
    assert(findClip(p(), a1)!.clip.duration === 2, 'split at 2s')
    setClipSpeed(pr, 2)
    assert(Math.abs(findClip(p(), pr)!.clip.duration - 1.5) < 1e-6, 'speed 2x halves duration')

    // Keyframes + transitions.
    toggleKeyframe(b1, 'scale', bClip.start)
    setClipProp(b1, 'scale', 0.5, bClip.start + 1)
    toggleKeyframe(b1, 'rotation', bClip.start)
    setClipProp(b1, 'rotation', 45, clipEnd(findClip(p(), b1)!.clip))
    assert((findClip(p(), b1)!.clip.keyframes.scale?.length ?? 0) === 2, 'two scale keyframes')
    setClipProp(img, 'cropLeft', 0.2, 0)
    setClipProp(img, 'opacity', 0.8, 0)
    const vTrack = findClip(p(), b1)!.track
    const sorted = [...vTrack.clips].sort((x, y) => x.start - y.start)
    const before = sorted[sorted.findIndex((c) => c.id === b1) - 1]
    // A and B are not adjacent (normal trim left a gap), so this must be rejected.
    addTransition(vTrack.id, before.id, b1, 'crossDissolve', 1)
    assert(findClip(p(), b1)!.track.transitions.length === 0, 'non-adjacent transition rejected')
    const trId = addTransition(vTrack.id, b1, img, 'wipeLeft', 0.5)
    assert(findClip(p(), b1)!.track.transitions.some((t) => t.id === trId), 'adjacent transition added')
    addTransition(vTrack.id, undefined, findClip(p(), pr)!.clip.id, 'fadeBlack', 0.5)
    const aTrackA = findClip(p(), mus)!.track
    addTransition(aTrackA.id, undefined, mus, 'fade', 1)
    assert(findClip(p(), mus)!.track.transitions.length === 1, 'audio fade added')

    // Mount the inspector for a clip and for a transition (both once crashed the renderer).
    useUi.getState().select({ clipIds: [b1] })
    await sleep(300)
    useUi.getState().select({ clipIds: [], transitionId: trId })
    await sleep(300)
    assert(document.querySelector('.inspector-section'), 'inspector rendered')
    useUi.getState().clearSelection()

    // Undo/redo round-trip.
    const beforeUndo = JSON.stringify(p())
    useProject.getState().undo()
    assert(JSON.stringify(p()) !== beforeUndo, 'undo changed state')
    useProject.getState().redo()
    assert(JSON.stringify(p()) === beforeUndo, 'redo restored state')

    // Preview render at a few positions.
    const player = getPlayer()
    assert(player, 'player exists')
    const dur = projectDuration(p())
    for (const t of [0, 4.6, 6, dur - 0.5]) {
      useUi.getState().setPlayhead(t)
      await player.renderAt(t)
    }
    assert(player.cache.size >= 1, 'frame cache populated')
    // Playback: the clock, the video decoders and the canvas must all advance.
    const canvasHash = (): string => {
      const c = document.createElement('canvas')
      c.width = 64
      c.height = 36
      const g = c.getContext('2d')!
      g.drawImage(player.comp.canvas as HTMLCanvasElement, 0, 0, 64, 36)
      const d = g.getImageData(0, 0, 64, 36).data
      let h = 0
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0
      return h.toString(16)
    }
    await player.play(0)
    await sleep(700)
    const d1 = player.debug()
    const h1 = canvasHash()
    await sleep(900)
    const d2 = player.debug()
    const h2 = canvasHash()
    player.pause()
    log(`playback: t ${d1.time.toFixed(2)}→${d2.time.toFixed(2)} ticks ${d1.ticks}→${d2.ticks} perf(ms)=${JSON.stringify({ sync: +d2.perf.sync.toFixed(1), emit: +d2.perf.emit.toFixed(1), render: +d2.perf.render.toFixed(1) })} audio=${d2.audioState} nodes=${d2.liveNodes} videos=${JSON.stringify(d2.videos.map((v) => [v.clipId, v.currentTime.toFixed(2), v.paused]))}`)
    assert(d2.time > d1.time + 0.5, 'clock advanced')
    const v1 = d1.videos.find((v) => v.clipId === a1)!
    const v2 = d2.videos.find((v) => v.clipId === a1)!
    assert(v2.currentTime > v1.currentTime + 0.3, `video element advanced (${v1.currentTime.toFixed(2)}→${v2.currentTime.toFixed(2)})`)
    assert(h1 !== h2, 'canvas content changed during playback')
    assert(player.debug().liveNodes === 0, 'audio nodes stopped on pause')
    // Rapid seek-while-playing must not leak audio nodes.
    await player.play(0)
    for (let i = 0; i < 5; i++) {
      player.seek(0.2 * i)
      await sleep(30)
    }
    await sleep(600)
    const leak = player.debug()
    player.pause()
    assert(leak.liveNodes <= 3, `no duplicate audio after seeks (${leak.liveNodes} nodes)`)
    assert(player.debug().liveNodes === 0, 'audio stopped after final pause')

    // Save YAML + reload.
    const projPath = `${dir}/smoke-project.yaml`
    useProject.setState({ path: projPath })
    assert(await saveProject(false), 'saved project')
    const loaded = await window.api.project.load(projPath)
    assert(loaded.project.tracks.length === p().tracks.length, 'reloaded track count')
    assert(loaded.missing.length === 0, 'no missing assets after reload')

    // Export.
    log(`exporting ${dur.toFixed(2)}s to ${out}`)
    const done = new Promise<string>((resolve, reject) => {
      window.api.exporter.onProgress((pr) => {
        if (pr.phase === 'video' && pr.frame % 30 === 0) log(`frame ${pr.frame}/${pr.totalFrames} @ ${pr.fps.toFixed(1)}fps`)
        if (pr.phase === 'done') resolve(pr.message ?? out)
        if (pr.phase === 'error' || pr.phase === 'cancelled') reject(new Error(pr.message ?? pr.phase))
      })
    })
    await window.api.exporter.start({ project: p(), cacheDir: useProject.getState().cacheDir, outputPath: out, rangeStart: 0, rangeEnd: dur })
    await done
    const probe = await window.api.media.probe(out)
    assert(probe.hasVideo && probe.hasAudio, 'export has audio+video')
    assert(Math.abs(probe.duration - dur) < 0.25, `export duration ${probe.duration.toFixed(2)} ≈ ${dur.toFixed(2)}`)
    assert(probe.width === p().settings.width, 'export width')
    player.cache.invalidate(-2)
    useUi.getState().setPlayhead(0.5)
    await player.renderAt(0.5)
    await sleep(200)
    await window.api.smokeDone(true, `exported ${probe.width}x${probe.height} ${probe.duration.toFixed(2)}s`)
  } catch (err) {
    console.error(err)
    await window.api.smokeDone(false, (err as Error).stack ?? String(err))
  }
}

/** Preview-only check against one real-world file: import, place, play, seek, step. */
export async function runPreviewCheck(file: string): Promise<void> {
  if (started) return
  started = true
  const log = (m: string): void => console.log(`preview-check: ${m}`)
  try {
    const t0 = performance.now()
    const [asset] = await importFiles([file])
    assert(asset, 'imported')
    log(`imported ${asset.name} (${asset.duration.toFixed(1)}s), generating proxy…`)
    await prepareAllMedia()
    assert(media.hasSource(asset.id), 'proxy ready')
    log(`proxy ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
    const ids = insertAsset(asset.id, undefined, 0)
    useUi.getState().select({ clipIds: ids })
    const player = getPlayer()
    assert(player, 'player')
    await sleep(300)
    assert(document.querySelector('.inspector-section'), 'inspector rendered')

    const tPlay = performance.now()
    await player.play(0)
    await sleep(600)
    const d1 = player.debug()
    await sleep(1500)
    const d2 = player.debug()
    log(`play: t ${d1.time.toFixed(2)}→${d2.time.toFixed(2)} ticks ${d1.ticks}→${d2.ticks} perf=${JSON.stringify(d2.perf)} audio=${d2.audioState} playingAudio=${d2.liveNodes} video=${JSON.stringify(d2.videos)} audios=${JSON.stringify(d2.audios)} (${((performance.now() - tPlay) / 1000).toFixed(1)}s)`)
    assert(d2.time > d1.time + 1, 'clock advanced')
    assert(d2.videos[0] && d2.videos[0].currentTime > d1.videos[0].currentTime + 0.8, 'video advanced')
    assert(d2.audios[0] && !d2.audios[0].paused && d2.audios[0].currentTime > 0.5, 'audio element playing')
    assert(Math.abs(d2.audios[0].currentTime - d2.time) < 0.3, `audio in sync (${d2.audios[0].currentTime.toFixed(2)} vs ${d2.time.toFixed(2)})`)
    assert(Math.abs(d2.videos[0].currentTime - d2.time) < 0.3, `video in sync (${d2.videos[0].currentTime.toFixed(2)} vs ${d2.time.toFixed(2)})`)

    // Seek far while playing (deep into a long file).
    const far = Math.min(asset.duration - 5, 600)
    player.seek(far)
    await sleep(1500)
    const d3 = player.debug()
    log(`after seek to ${far}: t=${d3.time.toFixed(2)} video=${JSON.stringify(d3.videos)} audio=${JSON.stringify(d3.audios)}`)
    {
      const src = media.sources.get(asset.id)!
      const r = await fetch(src.videoUrl!, { headers: { Range: 'bytes=1000-1999' } })
      log(`range fetch: status=${r.status} content-range=${r.headers.get('content-range')} length=${(await r.arrayBuffer()).byteLength} accept-ranges=${r.headers.get('accept-ranges')}`)
    }
    assert(d3.playing && d3.time > far + 0.5, 'still playing after seek')
    assert(Math.abs(d3.videos[0].currentTime - d3.time) < 0.5, 'video resynced after seek')
    assert(Math.abs(d3.audios[0].currentTime - d3.time) < 0.5, 'audio resynced after seek')

    player.pause()
    await sleep(200)
    const d4 = player.debug()
    assert(d4.audios.every((a) => a.paused) && d4.videos.every((v) => v.paused), 'everything paused')
    assert(d4.liveNodes === 0, 'no audio playing after pause')

    // Frame stepping while paused.
    const fps = useProject.getState().project.settings.fps
    const step0 = d4.time
    for (let i = 1; i <= 5; i++) {
      useUi.getState().setPlayhead(step0 + i / fps)
      await player.renderAt(step0 + i / fps)
    }
    assert(player.cache.size >= 5, `stepped frames cached (${player.cache.size})`)
    // Toggle twice quickly, must end paused with silence.
    player.toggle()
    await sleep(100)
    player.toggle()
    await sleep(300)
    assert(!player.playing && player.debug().liveNodes === 0, 'quick toggle leaves silence')
    await window.api.smokeDone(true, `preview OK for ${asset.name}`)
  } catch (err) {
    console.error(err)
    await window.api.smokeDone(false, (err as Error).stack ?? String(err))
  }
}
