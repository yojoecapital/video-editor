# Video Editor

A Linux-first, non-linear video editor built with Electron and distributed as a
Flatpak. Multi-track timeline, ripple/roll/slip/slide trimming, snapping,
transitions, keyframed transform/crop/volume, GPU preview compositing, and
FFmpeg export with hardware encoders where available.

```
npm install
npm run dev        # hot-reloading dev build
npm run smoke      # scripted end-to-end run against /tmp/ve-test (see below)
npm run package    # electron-builder → dist/linux-unpacked
./flatpak/build.sh # build + install the Flatpak for the current user
```

## Using it

| Action | How |
| --- | --- |
| Import media | `Ctrl+I`, the **Import…** button, or drop files onto the media bin |
| Add to timeline | Drag from the bin onto a track, or double-click to insert at the playhead |
| Play / shuttle | `Space`, `J` `K` `L`; `←`/`→` step frames (`Shift` = 10) |
| Trim | Drag a clip edge. Modes: `V` select, `B` ripple, `N` roll, `Y` slip, `U` slide |
| Snapping | `G` toggles; snaps to clip edges, playhead, markers |
| Split / marker | `S` / `M` at the playhead |
| Transition | Select a clip, press `T` (or **Transition**). Adds a dissolve/crossfade at the cut with its neighbour, or a fade if it has none. Click the transition bar to change type/duration |
| Keyframes | In the inspector, click ◆ next to a property to animate it; change the value at another time to add a keyframe. Easing per keyframe |
| Zoom | `Ctrl`+wheel over the timeline, `Ctrl`+`=`/`-`, `Ctrl+0` fit |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Export | `Ctrl+E` |

Video files with audio land as linked video + audio clips (⛓); they move and
trim together until unlinked in the inspector.

## Architecture

```
src/shared     Project model (types.ts), YAML schema migrations (schema.ts),
               keyframe interpolation (interp.ts), pure timeline math incl.
               trim modes and snapping (timeline.ts). No Electron/DOM imports.
src/main       Electron main: window/menu/IPC (index.ts), FFmpeg wrapper
               (ffmpeg.ts), YAML I/O + autosave + relink (project-io.ts),
               media:// protocol (protocol.ts), export orchestration (export.ts).
src/preload    contextBridge API surface (window.api).
src/renderer   React UI + engine:
  engine/compositor.ts  WebGL2 compositor (layers, crop/transform, transitions)
  engine/media.ts       <video>/ImageBitmap/AudioBuffer ownership
  engine/renderer.ts    project + time → frame
  engine/player.ts      playback clock, video sync, frame cache, prefetch
  engine/audio.ts       Web Audio scheduling shared by preview and export
  export/ExportWorker   runs in the hidden export window
  store/                zustand: project (with undo/redo) and UI state
  actions.ts            every timeline edit
  lifecycle.ts          new/open/save/import/autosave/recovery
```

### Process model

* **Main** owns the filesystem, dialogs and every `ffmpeg`/`ffprobe` child
  process. It never touches pixels.
* **Editor renderer** runs the UI, the WebGL compositor and Web Audio playback
  against low-res proxies.
* **Export renderer** is a second, hidden `BrowserWindow` that loads the same
  bundle in `?mode=export`. It mixes audio with an `OfflineAudioContext`, then
  composites every frame at full resolution from the *original* media and
  streams raw RGBA over IPC into an `ffmpeg` encoder started by main. The
  editor window only receives progress events, so the UI stays responsive.

### Media pipeline

* `ffprobe` classifies each import (video / audio / image).
* Proxies live in `<project>.cache/proxies/`: H.264 at the configured width
  (default 960 px) with a short GOP for instant seeking, a separate AAC file
  for audio, and a JPEG thumbnail. Images larger than 2048 px are downscaled.
* **Project Settings → Preview proxies** controls when they are built:
  *Auto* (default) only transcodes sources wider than the proxy width or that
  Chromium cannot decode; *Always* transcodes everything; *Never* plays the
  originals directly and only transcodes what the app can't decode (ProRes,
  10‑bit H.264, HEVC, …). The proxy width can be raised to 1280/1920/2560 for
  a sharper preview at the cost of decode load. Changing either regenerates
  the proxies.
* Export decodes originals through Chromium's `<video>`; sources it cannot
  play (ProRes, DNxHD, HEVC on most Linux builds, MPEG-2, odd containers) are
  transcoded once to a high-quality H.264 mezzanine in `<project>.cache/mezzanine/`.
* FFmpeg comes from `ffmpeg-static` / `ffprobe-static` (unpacked from the asar)
  and falls back to the system binaries in development.

### Preview performance

* WebGL2 compositing: one draw call per layer; transitions render both sides
  to offscreen targets and blend in a single pass.
* A frame cache (LRU of composited `ImageBitmap`s) serves scrubbing and
  frame-stepping; while idle, the next 30 frames are prefetched.
* Each timeline clip gets its own `<video>` (and `<audio>`) element so cuts and
  transitions can pre-roll independently; during playback they are kept in
  lock-step with a `performance.now()` master clock, and audio is routed
  through per-clip `GainNode`s for keyframed volume and transitions. Long
  sources stream — nothing is decoded up front.

### Project file

Projects are YAML (`schemaVersion`, settings, export settings, assets, tracks →
clips + transitions, markers). Asset paths are stored absolute *and* relative to
the project file; on load the app tries both, then a same-name file next to the
project, and finally prompts to relink (locate a file, or search a folder).
Migrations in `src/shared/schema.ts` upgrade older documents on load.

Autosaves go to `<project>.cache/autosave.yaml` (or the user-data dir for
unsaved projects) every 30 s while dirty; the next launch offers recovery for
any autosave newer than its project file.

### Flatpak

`flatpak/io.github.yojoe.VideoEditor.yml` builds on
`org.electronjs.Electron2.BaseApp`, whose `zypak-wrapper` provides a Chromium
sandbox that works inside bubblewrap. Notable `finish-args`:

* `--device=dri` for WebGL and VAAPI
* `--socket=wayland --socket=fallback-x11 --socket=pulseaudio`
* `GTK_USE_PORTAL=1` so Electron's file dialogs go through
  `xdg-desktop-portal`; the media directories are also granted so that
  proxies can be written next to the project and so files dropped from a file
  manager resolve to real paths.

Hardware encoders (VAAPI, NVENC, QuickSync) are probed with a tiny test encode
on first use and offered in the export dialog when they work.

## Smoke test

`npm run smoke` needs a folder of fixtures; generate them with:

```sh
mkdir -p /tmp/ve-test && cd /tmp/ve-test
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=440 -t 6 -c:v libx264 -c:a aac clipA.mp4
ffmpeg -f lavfi -i mandelbrot=size=1920x1080:rate=25 -f lavfi -i sine=220 -t 5 -c:v libx264 -c:a aac clipB.mkv
ffmpeg -f lavfi -i sine=660 -t 8 music.mp3
ffmpeg -f lavfi -i color=c=orange:size=800x600 -frames:v 1 still.png
ffmpeg -f lavfi -i testsrc=size=640x480:rate=24 -t 3 -c:v prores_ks prores.mov
```

It imports all five, edits with every trim mode, adds keyframes and
transitions, exercises undo/redo, renders and plays the preview, saves and
reloads the YAML, exports to `smoke-out.mp4` and verifies it with `ffprobe`.
A screenshot of the editor is written to `screenshot.png`.

## Not in scope

Colour grading, plugins, shortcut customisation and localisation — per the
project brief.
