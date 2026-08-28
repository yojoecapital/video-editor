import { useEffect, useState, type DragEvent } from 'react'
import type { Asset } from '@shared/types'
import { media } from '../engine/session'
import { useProject } from '../store/project'
import { useUi } from '../store/ui'
import { importFiles } from '../lifecycle'
import { insertAsset, removeAsset } from '../actions'

export const ASSET_MIME = 'application/x-video-editor-asset'

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function AssetCard({ asset }: { asset: Asset }): JSX.Element {
  const selected = useUi((s) => s.selection.assetId === asset.id)
  const progress = useUi((s) => s.proxyProgress[asset.id])
  const [, force] = useState(0)
  useEffect(() => media.onChange(() => force((n) => n + 1)), [])
  const src = media.sources.get(asset.id)
  const icon = asset.kind === 'audio' ? '🎵' : asset.kind === 'image' ? '🖼️' : '🎬'
  const thumb = src?.thumbnail ?? (asset.kind === 'image' ? src?.imageUrl : undefined)

  return (
    <div
      className={`bin-item ${selected ? 'selected' : ''}`}
      draggable
      title={asset.path}
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_MIME, asset.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => useUi.getState().select({ clipIds: [], assetId: asset.id })}
      onDoubleClick={() => {
        const ids = insertAsset(asset.id, undefined, useUi.getState().playhead)
        useUi.getState().select({ clipIds: ids })
      }}
      onContextMenu={async (e) => {
        e.preventDefault()
        const r = await window.api.dialogs.confirm({
          title: 'Remove media',
          message: `Remove "${asset.name}" from the project?`,
          detail: 'Clips using it will be deleted from the timeline.',
          buttons: ['Remove', 'Cancel'],
        })
        if (r === 0) removeAsset(asset.id)
      }}
    >
      <div className="bin-thumb">{thumb ? <img src={thumb} alt="" draggable={false} /> : icon}</div>
      {progress !== undefined && progress < 1 && (
        <div className="bin-progress">
          <div style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <div className="bin-name">{asset.name}</div>
      <div className="bin-meta">
        {asset.kind === 'image' ? `${asset.width}×${asset.height}` : fmtDuration(asset.duration)}
        {asset.kind === 'video' ? ` · ${asset.width}×${asset.height}` : ''}
        {asset.kind === 'audio' && asset.sampleRate ? ` · ${Math.round(asset.sampleRate / 1000)}kHz` : ''}
      </div>
    </div>
  )
}

export default function MediaBin(): JSX.Element {
  const assets = useProject((s) => s.project.assets)
  const [dropping, setDropping] = useState(false)

  useEffect(() => {
    return window.api.media.onProxyProgress(({ assetId, fraction }) => useUi.getState().setProxyProgress(assetId, fraction))
  }, [])

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDropping(false)
    const files = [...e.dataTransfer.files].map((f) => window.api.pathOf(f)).filter((p): p is string => !!p)
    if (files.length) void importFiles(files)
  }

  return (
    <div
      className={`panel bin ${dropping ? 'drop-target' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDropping(true)
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div className="panel-header">
        Media
        <span className="spacer" />
        <button onClick={() => void importFiles()}>Import…</button>
      </div>
      <div className="panel-body">
        {assets.length === 0 ? (
          <div className="bin-empty">
            Import media or drop files here.
            <br />
            <span className="hint">Drag items onto the timeline, or double-click to insert at the playhead.</span>
          </div>
        ) : (
          <div className="bin-grid">
            {assets.map((a) => (
              <AssetCard key={a.id} asset={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
