/**
 * Project document model. This is exactly what gets serialised to the YAML
 * project file, so every change here must be paired with a migration in
 * schema.ts when SCHEMA_VERSION is bumped.
 */

export const SCHEMA_VERSION = 1

export type AssetKind = 'video' | 'audio' | 'image'
export type TrackKind = 'video' | 'audio'

export interface AssetFingerprint {
  size: number
  mtimeMs: number
}

export interface Asset {
  id: string
  name: string
  /** Absolute path of the source media. */
  path: string
  /** Path relative to the project file, used to relink after a folder move. */
  relPath?: string
  kind: AssetKind
  duration: number
  width: number
  height: number
  fps: number
  hasVideo: boolean
  hasAudio: boolean
  sampleRate?: number
  channels?: number
  fingerprint?: AssetFingerprint
}

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

export interface Keyframe {
  /** Seconds from the clip's timeline start. */
  time: number
  value: number
  easing: Easing
}

export type VideoProp =
  | 'opacity'
  | 'scale'
  | 'x'
  | 'y'
  | 'rotation'
  | 'cropLeft'
  | 'cropTop'
  | 'cropRight'
  | 'cropBottom'
export type AudioProp = 'volume'
export type ClipProp = VideoProp | AudioProp

export interface Clip {
  id: string
  assetId: string
  /** Timeline start in seconds. */
  start: number
  /** Timeline duration in seconds (already divided by speed). */
  duration: number
  /** Source in-point in seconds. */
  inPoint: number
  /** Playback speed multiplier; source length consumed = duration * speed. */
  speed: number
  props: Partial<Record<ClipProp, number>>
  keyframes: Partial<Record<ClipProp, Keyframe[]>>
  /** Audio clips linked to a video clip (or vice versa) move together. */
  linkedClipId?: string
}

export type VideoTransitionType =
  | 'crossDissolve'
  | 'fadeBlack'
  | 'wipeLeft'
  | 'wipeRight'
  | 'wipeUp'
  | 'wipeDown'
  | 'slideLeft'
  | 'slideRight'
export type AudioTransitionType = 'crossfade' | 'fade'
export type TransitionType = VideoTransitionType | AudioTransitionType

export interface Transition {
  id: string
  type: TransitionType
  duration: number
  /** Clip on the left of the cut; undefined means a fade-in at the start of inClip. */
  outClipId?: string
  /** Clip on the right of the cut; undefined means a fade-out at the end of outClip. */
  inClipId?: string
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  locked: boolean
  clips: Clip[]
  transitions: Transition[]
}

export interface Marker {
  id: string
  time: number
  label: string
  color: string
}

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  sampleRate: number
  background: string
}

export type Container = 'mp4' | 'mkv' | 'mov' | 'webm'
export type VideoCodec =
  | 'libx264'
  | 'libx265'
  | 'libvpx-vp9'
  | 'h264_vaapi'
  | 'hevc_vaapi'
  | 'h264_nvenc'
  | 'hevc_nvenc'
  | 'h264_qsv'
  | 'hevc_qsv'
export type AudioCodec = 'aac' | 'libopus' | 'flac' | 'pcm_s16le'

export interface ExportSettings {
  container: Container
  videoCodec: VideoCodec
  /** CRF / quality level (lower is better). Ignored if bitrateKbps is set. */
  crf: number
  bitrateKbps?: number
  preset: string
  audioCodec: AudioCodec
  audioBitrateKbps: number
  /** Optional output size override; defaults to the canvas size. */
  width?: number
  height?: number
}

export interface Project {
  schemaVersion: number
  name: string
  settings: ProjectSettings
  export: ExportSettings
  assets: Asset[]
  tracks: Track[]
  markers: Marker[]
}

/* ----- Non-persisted, runtime-only shapes shared across processes ----- */

export interface ProbeResult {
  kind: AssetKind
  duration: number
  width: number
  height: number
  fps: number
  hasVideo: boolean
  hasAudio: boolean
  sampleRate?: number
  channels?: number
  codec?: string
}

export interface ProxyInfo {
  /** Absolute path to the proxy media (mp4 for video, m4a for audio, png for images). */
  path: string
  /** Separate AAC file for the asset's audio (Web Audio decodes it directly). */
  audioPath?: string
  thumbnail?: string
  width: number
  height: number
}

export interface EncoderInfo {
  name: VideoCodec
  label: string
  available: boolean
  hardware: boolean
}

export interface ExportRequest {
  project: Project
  cacheDir: string
  outputPath: string
  /** Inclusive range in seconds; defaults to the whole project. */
  rangeStart?: number
  rangeEnd?: number
}

export interface ExportProgress {
  phase: 'preparing' | 'audio' | 'video' | 'muxing' | 'done' | 'error' | 'cancelled'
  frame: number
  totalFrames: number
  fps: number
  message?: string
}

export interface MissingAsset {
  assetId: string
  name: string
  lastPath: string
}

export interface LoadedProject {
  project: Project
  path: string
  cacheDir: string
  missing: MissingAsset[]
  migratedFrom?: number
}
