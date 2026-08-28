import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { Asset } from '@shared/types'
import { probe, resolveBinaries } from './ffmpeg'

/** Codecs Chromium's <video> can decode directly on Linux builds of Electron. */
const BROWSER_DECODABLE = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora', 'mjpeg', 'png', 'gif', 'webp'])
const BROWSER_CONTAINERS = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv', '.ogg'])

/**
 * The export renderer decodes originals through <video>. Anything Chromium
 * can't play (ProRes, DNxHD, HEVC on most Linux boxes, MPEG-2, AVI/MTS wrappers)
 * is transcoded once to a full-resolution H.264 mezzanine in the cache dir.
 */
export async function ensureDecodable(asset: Asset, cacheDir: string): Promise<string> {
  if (asset.kind === 'image') return asset.path
  const info = await probe(asset.path)
  const ext = path.extname(asset.path).toLowerCase()
  if (info.codec && BROWSER_DECODABLE.has(info.codec) && BROWSER_CONTAINERS.has(ext)) return asset.path

  const dir = path.join(cacheDir, 'mezzanine')
  await fs.mkdir(dir, { recursive: true })
  const out = path.join(dir, `${asset.id}.mp4`)
  try {
    const [o, s] = await Promise.all([fs.stat(out), fs.stat(asset.path)])
    if (o.size > 0 && o.mtimeMs >= s.mtimeMs) return out
  } catch {
    /* build it */
  }
  const { ffmpeg } = await resolveBinaries()
  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-y', '-v', 'error', '-i', asset.path, '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-g', '30', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', out],
      { maxBuffer: 1 << 20 },
      (err, _so, se) => (err ? reject(new Error(`mezzanine failed: ${se}`)) : resolve()),
    )
  })
  return out
}
