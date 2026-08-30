import { protocol } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

export const MEDIA_SCHEME = 'media'

/** Must be called before app.whenReady(). */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
    },
  ])
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mka': 'audio/x-matroska',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/**
 * `media:///absolute/path` -> local file with real HTTP Range semantics.
 * Chromium's <video>/<audio> seek by issuing byte-range requests; a 200
 * without Content-Range makes it assume the whole file restarted, which
 * resets playback to 0 on every seek. So ranges are served from fs directly.
 */
export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
    let stat: import('node:fs').Stats
    try {
      stat = await fs.stat(filePath)
    } catch {
      return new Response('not found', { status: 404 })
    }
    const size = stat.size
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const base: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      'Cache-Control': 'no-store',
      'Last-Modified': stat.mtime.toUTCString(),
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { ...base, 'Content-Length': String(size) } })

    const range = request.headers.get('range')
    let start = 0
    let end = size - 1
    let status = 200
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (!m) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
      if (m[1] === '' && m[2] !== '') {
        // Suffix range: last N bytes.
        start = Math.max(0, size - Number(m[2]))
      } else {
        start = Number(m[1])
        if (m[2] !== '') end = Math.min(end, Number(m[2]))
      }
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
      status = 206
    }
    const headers: Record<string, string> = { ...base, 'Content-Length': String(end - start + 1) }
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    const stream = createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers })
  })
}

export function mediaUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://${encodeURI(filePath).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}
