import type { VideoTransitionType } from '@shared/types'

export interface LayerParams {
  srcWidth: number
  srcHeight: number
  opacity: number
  scale: number
  x: number
  y: number
  rotation: number
  cropLeft: number
  cropTop: number
  cropRight: number
  cropBottom: number
}

const LAYER_VS = `#version 300 es
in vec2 a_pos;
uniform mat3 u_transform;   // unit quad -> clip space
uniform vec4 u_crop;        // l, t, r, b as fractions
out vec2 v_uv;
void main() {
  vec3 p = u_transform * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = vec2(mix(u_crop.x, 1.0 - u_crop.z, a_pos.x), mix(u_crop.y, 1.0 - u_crop.w, a_pos.y));
}`

const LAYER_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);
  o = vec4(c.rgb * c.a, c.a) * u_opacity;  // premultiplied
}`

const TRANS_VS = `#version 300 es
in vec2 a_pos;
uniform float u_flip;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  v_uv = vec2(a_pos.x, mix(a_pos.y, 1.0 - a_pos.y, u_flip));
}`

const TRANS_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_p;
uniform int u_type;
out vec4 o;
vec4 A(vec2 uv) { return texture(u_a, uv); }
vec4 B(vec2 uv) { return texture(u_b, uv); }
void main() {
  vec2 uv = v_uv;
  float p = clamp(u_p, 0.0, 1.0);
  if (u_type == 0) {            // cross dissolve
    o = mix(A(uv), B(uv), p);
  } else if (u_type == 1) {     // fade through black
    o = p < 0.5 ? A(uv) * (1.0 - p * 2.0) : B(uv) * (p * 2.0 - 1.0);
  } else if (u_type == 2) {     // wipe left  (B reveals from the right edge moving left)
    o = uv.x > 1.0 - p ? B(uv) : A(uv);
  } else if (u_type == 3) {     // wipe right
    o = uv.x < p ? B(uv) : A(uv);
  } else if (u_type == 4) {     // wipe up (B reveals from bottom moving up)
    o = uv.y > 1.0 - p ? B(uv) : A(uv);
  } else if (u_type == 5) {     // wipe down
    o = uv.y < p ? B(uv) : A(uv);
  } else if (u_type == 6) {     // slide left: A exits left, B enters from right
    float x = uv.x + p;
    o = x < 1.0 ? A(vec2(x, uv.y)) : B(vec2(x - 1.0, uv.y));
  } else {                      // slide right
    float x = uv.x - p;
    o = x >= 0.0 ? A(vec2(x, uv.y)) : B(vec2(x + 1.0, uv.y));
  }
}`

const BLIT_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_a;
out vec4 o;
void main() { o = texture(u_a, v_uv); }`

export const TRANSITION_INDEX: Record<VideoTransitionType, number> = {
  crossDissolve: 0,
  fadeBlack: 1,
  wipeLeft: 2,
  wipeRight: 3,
  wipeUp: 4,
  wipeDown: 5,
  slideLeft: 6,
  slideRight: 7,
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
    return s
  }
  const p = gl.createProgram()!
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs))
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error')
  return p
}

interface Target {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
}

/**
 * GPU compositor. Layers are drawn back-to-front with premultiplied alpha
 * into either the canvas or one of two offscreen targets (A/B) which the
 * transition pass then blends. Everything is one draw call per layer.
 */
export class Compositor {
  readonly gl: WebGL2RenderingContext
  width: number
  height: number
  private layerProg: WebGLProgram
  private transProg: WebGLProgram
  private blitProg: WebGLProgram
  private quad: WebGLVertexArrayObject
  private texPool = new Map<object, WebGLTexture>()
  private targets: Record<'A' | 'B', Target>
  private bitmapTex: WebGLTexture
  private loc: Record<string, WebGLUniformLocation | null> = {}
  private currentTarget: WebGLFramebuffer | null = null

  constructor(
    public canvas: HTMLCanvasElement | OffscreenCanvas,
    width: number,
    height: number,
    opts: { preserveDrawingBuffer?: boolean } = {},
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
      powerPreference: 'high-performance',
      desynchronized: true,
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    this.width = width
    this.height = height
    canvas.width = width
    canvas.height = height

    this.layerProg = compile(gl, LAYER_VS, LAYER_FS)
    this.transProg = compile(gl, TRANS_VS, TRANS_FS)
    this.blitProg = compile(gl, TRANS_VS, BLIT_FS)
    for (const [name, prog] of [
      ['layer', this.layerProg],
      ['trans', this.transProg],
      ['blit', this.blitProg],
    ] as const) {
      for (const u of ['u_transform', 'u_crop', 'u_tex', 'u_opacity', 'u_a', 'u_b', 'u_p', 'u_type', 'u_flip'])
        this.loc[`${name}.${u}`] = gl.getUniformLocation(prog, u)
    }

    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.quad = vao

    this.targets = { A: this.makeTarget(), B: this.makeTarget() }
    this.bitmapTex = this.makeTexture()

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  }

  private makeTexture(): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private makeTarget(): Target {
    const gl = this.gl
    const tex = this.makeTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { fbo, tex }
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    const gl = this.gl
    for (const t of Object.values(this.targets)) {
      gl.deleteFramebuffer(t.fbo)
      gl.deleteTexture(t.tex)
    }
    this.targets = { A: this.makeTarget(), B: this.makeTarget() }
  }

  /** Start a frame: clear the canvas with the background colour. */
  begin(background: string): void {
    const gl = this.gl
    const [r, g, b] = hexToRgb(background)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.currentTarget = null
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** Redirect subsequent layer draws into offscreen target A or B (cleared to transparent). */
  beginTarget(which: 'A' | 'B'): void {
    const gl = this.gl
    const t = this.targets[which]
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
    this.currentTarget = t.fbo
    gl.viewport(0, 0, this.width, this.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  endTarget(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null)
    this.currentTarget = null
  }

  private uploadTexture(source: TexImageSource, key: object): WebGLTexture {
    const gl = this.gl
    let tex = this.texPool.get(key)
    if (!tex) {
      tex = this.makeTexture()
      this.texPool.set(key, tex)
    }
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    return tex
  }

  drawLayer(source: TexImageSource, p: LayerParams): void {
    const gl = this.gl
    const tex = this.uploadTexture(source, source)
    gl.useProgram(this.layerProg)
    gl.bindVertexArray(this.quad)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(this.loc['layer.u_tex'], 0)
    gl.uniform1f(this.loc['layer.u_opacity'], Math.max(0, Math.min(1, p.opacity)))
    const cl = clamp01(p.cropLeft)
    const ct = clamp01(p.cropTop)
    const cr = clamp01(p.cropRight)
    const cb = clamp01(p.cropBottom)
    gl.uniform4f(this.loc['layer.u_crop'], cl, ct, cr, cb)
    gl.uniformMatrix3fv(this.loc['layer.u_transform'], false, this.layerMatrix(p, cl, ct, cr, cb))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /**
   * Build the unit-quad -> clip-space matrix. The source is "fit" into the
   * canvas (contain), then cropped in place, scaled and rotated about the
   * canvas centre, then translated by (x, y) canvas pixels (y down).
   */
  private layerMatrix(p: LayerParams, cl: number, ct: number, cr: number, cb: number): Float32Array {
    const W = this.width
    const H = this.height
    const sw = p.srcWidth || W
    const sh = p.srcHeight || H
    const fit = Math.min(W / sw, H / sh)
    const fullW = sw * fit
    const fullH = sh * fit
    // Rect of the cropped region in "fit" space, centred on the canvas centre.
    const left = -fullW / 2 + cl * fullW
    const right = fullW / 2 - cr * fullW
    const top = -fullH / 2 + ct * fullH
    const bottom = fullH / 2 - cb * fullH
    const cw = Math.max(0, right - left)
    const ch = Math.max(0, bottom - top)
    const s = p.scale
    const rad = (p.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    // Local (pixel, y-down) transform of unit quad: quad -> [left..right]x[top..bottom] -> scale/rotate -> translate.
    // unit u,v (0..1, v=0 at top of image because we flip on upload) => px = left + u*cw, py = top + v*ch
    const a = cw * s
    const d = ch * s
    const tx = left * s
    const ty = top * s
    // rotation applied to (px, py)
    const m00 = cos * a
    const m01 = -sin * d
    const m02 = cos * tx - sin * ty + p.x
    const m10 = sin * a
    const m11 = cos * d
    const m12 = sin * tx + cos * ty + p.y
    // pixel (y-down, origin centre) -> clip space (y-up)
    const kx = 2 / W
    const ky = -2 / H
    // column-major mat3
    return new Float32Array([m00 * kx, m10 * ky, 0, m01 * kx, m11 * ky, 0, m02 * kx, m12 * ky, 1])
  }

  /** Blend offscreen targets A and B onto the current output using a transition. */
  drawTransition(type: VideoTransitionType, progress: number): void {
    const gl = this.gl
    gl.useProgram(this.transProg)
    gl.bindVertexArray(this.quad)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.targets.A.tex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.targets.B.tex)
    gl.uniform1i(this.loc['trans.u_a'], 0)
    gl.uniform1i(this.loc['trans.u_b'], 1)
    gl.uniform1f(this.loc['trans.u_p'], progress)
    gl.uniform1i(this.loc['trans.u_type'], TRANSITION_INDEX[type] ?? 0)
    gl.uniform1f(this.loc['trans.u_flip'], 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** Draw a previously cached full frame. */
  drawBitmap(bitmap: ImageBitmap): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.disable(gl.BLEND)
    gl.bindTexture(gl.TEXTURE_2D, this.bitmapTex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    gl.useProgram(this.blitProg)
    gl.bindVertexArray(this.quad)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.bitmapTex)
    gl.uniform1i(this.loc['blit.u_a'], 0)
    gl.uniform1f(this.loc['blit.u_flip'], 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.enable(gl.BLEND)
  }

  /** Read back the canvas as top-down RGBA. Must be called right after drawing. */
  readPixels(): Uint8Array {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const out = new Uint8Array(this.width * this.height * 4)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, out)
    // WebGL gives bottom-up rows; flip in place.
    const row = this.width * 4
    const tmp = new Uint8Array(row)
    for (let y = 0; y < this.height >> 1; y++) {
      const a = y * row
      const b = (this.height - 1 - y) * row
      tmp.set(out.subarray(a, a + row))
      out.copyWithin(a, b, b + row)
      out.set(tmp, b)
    }
    return out
  }

  /** Release textures for sources no longer in use. */
  releaseTexture(key: object): void {
    const t = this.texPool.get(key)
    if (t) {
      this.gl.deleteTexture(t)
      this.texPool.delete(key)
    }
  }

  dispose(): void {
    const gl = this.gl
    for (const t of this.texPool.values()) gl.deleteTexture(t)
    this.texPool.clear()
    for (const t of Object.values(this.targets)) {
      gl.deleteFramebuffer(t.fbo)
      gl.deleteTexture(t.tex)
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(0.999, v || 0))
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
