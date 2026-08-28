import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Asset, EncoderInfo, ExportSettings, ProbeResult, ProxyInfo, VideoCodec } from '@shared/types'

/* ------------------------------ Binary resolution ------------------------------ */

function unasar(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

let ffmpegPath = 'ffmpeg'
let ffprobePath = 'ffprobe'

async function canRun(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (err) => resolve(!err))
  })
}

/**
 * Prefer the bundled static binaries (reliable inside the Flatpak sandbox),
 * fall back to whatever is on PATH for development machines.
 */
export async function resolveBinaries(): Promise<{ ffmpeg: string; ffprobe: string }> {
  const candidates: Array<[string, string]> = []
  try {
    const ffm = unasar(require('ffmpeg-static') as string)
    const ffp = unasar((require('ffprobe-static') as { path: string }).path)
    candidates.push([ffm, ffp])
  } catch {
    /* not bundled */
  }
  const res = path.join(process.resourcesPath ?? '', 'bin')
  candidates.push([path.join(res, 'ffmpeg'), path.join(res, 'ffprobe')])
  candidates.push(['ffmpeg', 'ffprobe'])
  for (const [f, p] of candidates) {
    if ((f === 'ffmpeg' || existsSync(f)) && (await canRun(f))) {
      ffmpegPath = f
      ffprobePath = p === 'ffprobe' || existsSync(p) ? p : 'ffprobe'
      break
    }
  }
  return { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
}

function run(bin: string, args: string[], opts: { maxBuffer?: number; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, timeout: opts.timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} failed: ${stderr?.toString().split('\n').slice(-5).join('\n') || err.message}`))
      else resolve(stdout.toString())
    })
  })
}

/* ---------------------------------- Probing ---------------------------------- */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.heic'])

function parseFps(r: string | undefined): number {
  if (!r) return 0
  const [n, d] = r.split('/').map(Number)
  if (!d) return n || 0
  return d === 0 ? 0 : n / d
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await run(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ])
  const json = JSON.parse(out)
  const streams: any[] = json.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.find((s) => s.codec_type === 'audio')
  const ext = path.extname(file).toLowerCase()
  const isImage =
    IMAGE_EXT.has(ext) || (v && !a && (v.nb_frames === '1' || /png|mjpeg|webp|bmp|tiff|gif/.test(v.codec_name) && !json.format?.duration))
  const duration = Number(json.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0
  if (isImage) {
    return {
      kind: 'image',
      duration: 5,
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      fps: 0,
      hasVideo: true,
      hasAudio: false,
      codec: v?.codec_name,
    }
  }
  if (v) {
    return {
      kind: 'video',
      duration,
      width: v.width ?? 0,
      height: v.height ?? 0,
      fps: parseFps(v.avg_frame_rate) || parseFps(v.r_frame_rate) || 30,
      hasVideo: true,
      hasAudio: !!a,
      sampleRate: a ? Number(a.sample_rate) : undefined,
      channels: a?.channels,
      codec: v.codec_name,
    }
  }
  if (a) {
    return {
      kind: 'audio',
      duration,
      width: 0,
      height: 0,
      fps: 0,
      hasVideo: false,
      hasAudio: true,
      sampleRate: Number(a.sample_rate),
      channels: a.channels,
      codec: a.codec_name,
    }
  }
  throw new Error('No audio or video streams found')
}

/* ---------------------------------- Proxies ---------------------------------- */

export const PROXY_MAX_WIDTH = 960

async function isFresh(target: string, source: string): Promise<boolean> {
  try {
    const [t, s] = await Promise.all([fs.stat(target), fs.stat(source)])
    return t.size > 0 && t.mtimeMs >= s.mtimeMs
  } catch {
    return false
  }
}

function proxySize(w: number, h: number): { width: number; height: number } {
  if (w <= PROXY_MAX_WIDTH) return { width: w - (w % 2), height: h - (h % 2) }
  const scale = PROXY_MAX_WIDTH / w
  const width = PROXY_MAX_WIDTH
  const height = Math.round((h * scale) / 2) * 2
  return { width, height }
}

/**
 * Build the preview proxy + thumbnail for an asset. Proxies are low-res,
 * all-intra-ish H.264 so the renderer can seek instantly; export always goes
 * back to the original file.
 */
export async function generateProxy(
  asset: Asset,
  cacheDir: string,
  onProgress?: (fraction: number) => void,
): Promise<ProxyInfo> {
  const dir = path.join(cacheDir, 'proxies')
  await fs.mkdir(dir, { recursive: true })
  const thumb = path.join(dir, `${asset.id}.jpg`)

  if (asset.kind === 'image') {
    const out = path.join(dir, `${asset.id}.png`)
    const { width, height } = proxySize(asset.width, asset.height)
    const big = asset.width > 2048 || asset.height > 2048
    if (!(await isFresh(out, asset.path))) {
      if (big) {
        await run(ffmpegPath, ['-y', '-v', 'error', '-i', asset.path, '-vf', 'scale=min(2048\\,iw):-2', out])
      }
    }
    if (!(await isFresh(thumb, asset.path))) {
      await run(ffmpegPath, ['-y', '-v', 'error', '-i', asset.path, '-vf', 'scale=160:-2', '-frames:v', '1', thumb])
    }
    onProgress?.(1)
    return { path: big ? out : asset.path, thumbnail: thumb, width, height }
  }

  if (asset.kind === 'audio') {
    const out = path.join(dir, `${asset.id}.m4a`)
    if (!(await isFresh(out, asset.path))) {
      await runWithProgress(
        ['-y', '-v', 'error', '-i', asset.path, '-vn', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', out],
        asset.duration,
        onProgress,
      )
    }
    return { path: out, audioPath: out, width: 0, height: 0 }
  }

  const out = path.join(dir, `${asset.id}.mp4`)
  const { width, height } = proxySize(asset.width, asset.height)
  if (!(await isFresh(out, asset.path))) {
    const args = [
      '-y',
      '-v',
      'error',
      '-i',
      asset.path,
      '-vf',
      `scale=${width}:${height}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-g',
      '12',
      '-bf',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
    ]
    if (asset.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2')
    else args.push('-an')
    args.push(out)
    await runWithProgress(args, asset.duration, onProgress)
  }
  if (!(await isFresh(thumb, asset.path))) {
    const at = Math.min(1, asset.duration * 0.1)
    await run(ffmpegPath, ['-y', '-v', 'error', '-ss', String(at), '-i', asset.path, '-vf', 'scale=160:-2', '-frames:v', '1', thumb]).catch(
      () => undefined,
    )
  }
  let audioPath: string | undefined
  if (asset.hasAudio) {
    audioPath = path.join(dir, `${asset.id}.m4a`)
    if (!(await isFresh(audioPath, asset.path))) {
      await run(ffmpegPath, ['-y', '-v', 'error', '-i', asset.path, '-vn', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', audioPath])
    }
  }
  return { path: out, audioPath, thumbnail: existsSync(thumb) ? thumb : undefined, width, height }
}

function runWithProgress(args: string[], duration: number, onProgress?: (f: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-progress', 'pipe:1', '-nostats', ...args])
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.stdout.on('data', (d) => {
      const m = /out_time_us=(\d+)/g
      let last: RegExpExecArray | null = null
      let cur: RegExpExecArray | null
      const s = d.toString()
      while ((cur = m.exec(s))) last = cur
      if (last && duration > 0) onProgress?.(Math.min(1, Number(last[1]) / 1e6 / duration))
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress?.(1)
        resolve()
      } else reject(new Error(`ffmpeg exited with ${code}: ${stderr.split('\n').slice(-4).join('\n')}`))
    })
  })
}

/* ------------------------------ Encoder detection ------------------------------ */

const ENCODERS: Array<{ name: VideoCodec; label: string; hardware: boolean }> = [
  { name: 'libx264', label: 'H.264 (x264, software)', hardware: false },
  { name: 'libx265', label: 'H.265 / HEVC (x265, software)', hardware: false },
  { name: 'libvpx-vp9', label: 'VP9 (software)', hardware: false },
  { name: 'h264_vaapi', label: 'H.264 (VAAPI hardware)', hardware: true },
  { name: 'hevc_vaapi', label: 'H.265 (VAAPI hardware)', hardware: true },
  { name: 'h264_nvenc', label: 'H.264 (NVENC hardware)', hardware: true },
  { name: 'hevc_nvenc', label: 'H.265 (NVENC hardware)', hardware: true },
  { name: 'h264_qsv', label: 'H.264 (Intel QuickSync)', hardware: true },
  { name: 'hevc_qsv', label: 'H.265 (Intel QuickSync)', hardware: true },
]

let encoderCache: EncoderInfo[] | undefined

export function vaapiDevice(): string | undefined {
  for (const n of ['renderD128', 'renderD129']) {
    const p = `/dev/dri/${n}`
    if (existsSync(p)) return p
  }
  return undefined
}

/** Encoder-specific input/pre-codec args for a raw RGBA pipe source. */
function hwArgs(codec: VideoCodec): { pre: string[]; filter: string; post: string[] } {
  if (codec.endsWith('_vaapi')) {
    const dev = vaapiDevice() ?? '/dev/dri/renderD128'
    return { pre: ['-vaapi_device', dev], filter: 'format=nv12,hwupload', post: [] }
  }
  if (codec.endsWith('_qsv')) return { pre: [], filter: 'format=nv12', post: [] }
  if (codec.endsWith('_nvenc')) return { pre: [], filter: 'format=yuv420p', post: [] }
  if (codec === 'libvpx-vp9') return { pre: [], filter: 'format=yuv420p', post: ['-row-mt', '1'] }
  return { pre: [], filter: 'format=yuv420p', post: [] }
}

async function testEncoder(codec: VideoCodec): Promise<boolean> {
  const { pre, filter } = hwArgs(codec)
  try {
    await run(
      ffmpegPath,
      ['-v', 'error', ...pre, '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=5', '-frames:v', '3', '-vf', filter, '-c:v', codec, '-f', 'null', '-'],
      { timeout: 15000 },
    )
    return true
  } catch {
    return false
  }
}

export async function listEncoders(): Promise<EncoderInfo[]> {
  if (encoderCache) return encoderCache
  let compiled = ''
  try {
    compiled = await run(ffmpegPath, ['-v', 'error', '-encoders'])
  } catch {
    /* ignore */
  }
  const result: EncoderInfo[] = []
  for (const e of ENCODERS) {
    const present = new RegExp(`\\s${e.name}\\s`).test(compiled)
    let available = present
    if (present && e.hardware) available = await testEncoder(e.name)
    result.push({ ...e, available })
  }
  encoderCache = result
  return result
}

/* --------------------------------- Exporting --------------------------------- */

export interface EncoderHandle {
  child: ChildProcess
  /** Write one raw RGBA frame; resolves once ffmpeg has accepted it. */
  writeFrame(frame: Buffer | Uint8Array): Promise<void>
  finish(): Promise<void>
  cancel(): void
  stderr: () => string
}

export function startEncoder(opts: {
  settings: ExportSettings
  width: number
  height: number
  fps: number
  audioWav?: string
  output: string
}): EncoderHandle {
  const { settings, width, height, fps, audioWav, output } = opts
  const { pre, filter, post } = hwArgs(settings.videoCodec)
  const args = [
    '-y',
    '-v',
    'error',
    ...pre,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    String(fps),
    '-i',
    'pipe:0',
  ]
  if (audioWav) args.push('-i', audioWav)
  args.push('-vf', filter, '-c:v', settings.videoCodec)
  const c = settings.videoCodec
  if (settings.bitrateKbps) {
    args.push('-b:v', `${settings.bitrateKbps}k`)
  } else if (c === 'libx264' || c === 'libx265') {
    args.push('-crf', String(settings.crf), '-preset', settings.preset || 'medium')
  } else if (c === 'libvpx-vp9') {
    args.push('-crf', String(settings.crf), '-b:v', '0')
  } else if (c.endsWith('_vaapi')) {
    args.push('-qp', String(settings.crf))
  } else if (c.endsWith('_nvenc')) {
    args.push('-rc', 'vbr', '-cq', String(settings.crf), '-preset', 'p4')
  } else if (c.endsWith('_qsv')) {
    args.push('-global_quality', String(settings.crf))
  }
  args.push(...post)
  if (audioWav) {
    args.push('-c:a', settings.audioCodec)
    if (settings.audioCodec !== 'flac' && settings.audioCodec !== 'pcm_s16le') args.push('-b:a', `${settings.audioBitrateKbps}k`)
    args.push('-shortest')
  } else args.push('-an')
  if (settings.container === 'mp4' || settings.container === 'mov') args.push('-movflags', '+faststart')
  args.push(output)

  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let err = ''
  child.stderr!.on('data', (d) => (err += d.toString()))
  let closed = false
  child.stdin!.on('error', () => {
    closed = true
  })

  return {
    child,
    stderr: () => err,
    writeFrame(frame) {
      return new Promise((resolve, reject) => {
        if (closed || child.exitCode !== null) return reject(new Error(`ffmpeg closed: ${err}`))
        const ok = child.stdin!.write(frame)
        if (ok) resolve()
        else child.stdin!.once('drain', () => resolve())
      })
    },
    finish() {
      return new Promise((resolve, reject) => {
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err}`))))
        child.stdin!.end()
      })
    },
    cancel() {
      closed = true
      child.kill('SIGKILL')
    },
  }
}

/** Decode a source file to a float32 planar-interleaved WAV for the export audio mixer. */
export async function extractAudioWav(src: string, out: string, sampleRate: number): Promise<void> {
  await run(ffmpegPath, ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '2', '-ar', String(sampleRate), '-c:a', 'pcm_f32le', out])
}

export function tempDir(): string {
  return path.join(app.getPath('temp'), 'video-editor')
}
