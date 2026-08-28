import { useProject } from '../store/project'
import { Compositor } from './compositor'
import { MediaManager } from './media'
import { Player } from './player'

/** Process-wide engine objects for the editor window. */
export const media = new MediaManager()
let player: Player | undefined

export function getPlayer(): Player | undefined {
  return player
}

/** Bind the preview canvas; called once by the Preview component. */
export function attachCanvas(canvas: HTMLCanvasElement): Player {
  if (player) player.dispose()
  const { project } = useProject.getState()
  const comp = new Compositor(canvas, project.settings.width, project.settings.height)
  player = new Player(comp, media, () => {
    const s = useProject.getState()
    return { project: s.project, version: s.version }
  })
  return player
}

export function detachCanvas(): void {
  player?.dispose()
  player = undefined
}
