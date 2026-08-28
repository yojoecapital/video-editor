# Project Brief: Electron Video Editor (Flatpak)

## Overview
A sleek, Linux-first desktop video editor built with Electron and distributed as a Flatpak. The app provides core non-linear editing (NLE) functionality — multi-track timeline editing, transitions, clip properties, and keyframed animation — with broad format support via FFmpeg.

## Core Functionality

### Format Support
- Seamless support for commonly used video, image, and audio formats
- FFmpeg-based decode/encode (bundled static binary preferred over system FFmpeg, for Flatpak sandbox reliability)

### Timeline & Tracks
- Multi-track support for footage and audio (independent video and audio tracks)
- Timeline-based editing with:
  - Panning and zooming
  - Drag-and-drop of timeline items
  - Trimming of items
- Snapping (clip edges, playhead, markers)
- Ripple/roll/slip/slide trim modes

### Effects & Clip Properties
- Transition effects for both footage and audio
- Footage properties: crop, scale, translate, speed
- Audio properties: volume, speed
- Keyframe support for animatable properties

### Project Settings
- Canvas resolution (custom width/height)
- Export format configuration

## Explicitly Out of Scope
- Color correction / grading tools
- Plugin/extension system
- Keyboard shortcut customization
- Localization/multi-language support

## Project File Format
- Project files saved as **YAML**
- Proxy/preview clips and cache files stored in a **directory alongside the YAML file** (not embedded)
- Should account for:
  - Schema versioning/migration as the format evolves
  - Media relinking if source files move or go missing

## Architecture Considerations

**Performance**
- Proxy/preview media generation for smooth scrubbing on high-res footage; swap to full-res on export
- GPU-accelerated preview rendering (WebGL/WebGPU) rather than software compositing
- Frame caching near the playhead
- Export/render runs off the main UI thread (background/worker process)

**Reliability**
- Undo/redo history
- Autosave and crash recovery
- Asset bin/media pool with thumbnails, separate from the timeline

**Flatpak-Specific**
- Portal permissions (`xdg-desktop-portal`) for sandboxed file access — affects open/save UX
- GPU device access in the manifest (`--device=dri`) for hardware acceleration
- Electron/Chromium sandbox vs. Flatpak sandbox friction — expect to need sandbox flag adjustments; prototype early
- Hardware-accelerated encode/decode (VAAPI/NVENC/QuickSync) where available, for export speed

## Open Questions for Design/Build Phase
1. Project file schema (YAML structure) for tracks, clips, transitions, and keyframes
2. Electron process architecture (main vs. renderer vs. worker responsibilities)
3. Preview rendering approach (WebGL/WebGPU compositor design)
4. FFmpeg integration strategy (bundled binary, bindings, or CLI invocation)
