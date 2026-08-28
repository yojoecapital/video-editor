/**
 * LRU of fully composited frames keyed by frame index. Filled while paused
 * (and by the idle prefetcher) so scrubbing and frame-stepping near the
 * playhead never wait on a decoder seek. Invalidated whenever the project
 * changes.
 */
export class FrameCache {
  private frames = new Map<number, ImageBitmap>()
  version = -1

  constructor(private capacity = 120) {}

  invalidate(version: number): void {
    if (version === this.version) return
    for (const b of this.frames.values()) b.close()
    this.frames.clear()
    this.version = version
  }

  get(frame: number): ImageBitmap | undefined {
    const b = this.frames.get(frame)
    if (b) {
      // Refresh LRU position.
      this.frames.delete(frame)
      this.frames.set(frame, b)
    }
    return b
  }

  has(frame: number): boolean {
    return this.frames.has(frame)
  }

  set(frame: number, bitmap: ImageBitmap): void {
    const old = this.frames.get(frame)
    if (old) old.close()
    this.frames.delete(frame)
    this.frames.set(frame, bitmap)
    while (this.frames.size > this.capacity) {
      const first = this.frames.keys().next().value as number
      this.frames.get(first)?.close()
      this.frames.delete(first)
    }
  }

  get size(): number {
    return this.frames.size
  }

  dispose(): void {
    for (const b of this.frames.values()) b.close()
    this.frames.clear()
  }
}
