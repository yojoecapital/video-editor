import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'

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

/**
 * `media:///absolute/path` -> local file, with Range support (Chromium's
 * <video> element needs it to seek). Using net.fetch on a file:// URL gives us
 * range handling for free.
 */
export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
    const fileUrl = pathToFileURL(filePath).toString()
    const res = await net.fetch(fileUrl, { headers: request.headers })
    // The renderer page is file:// (or the dev server) so media:// is a
    // foreign origin; without CORS headers WebGL refuses to sample <video>.
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  })
}

export function mediaUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://${encodeURI(filePath).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}
