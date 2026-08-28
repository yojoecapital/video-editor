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
    // Short playback.
    await player.play(0)
    await sleep(1200)
    player.pause()
    assert(player.time > 0.5, `playback advanced (${player.time.toFixed(2)}s)`)

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
    await window.api.smokeDone(true, `exported ${probe.width}x${probe.height} ${probe.duration.toFixed(2)}s`)
  } catch (err) {
    console.error(err)
    await window.api.smokeDone(false, (err as Error).stack ?? String(err))
  }
}
