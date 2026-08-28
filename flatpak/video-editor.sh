#!/bin/sh
# Launcher installed as /app/bin/video-editor inside the Flatpak.
# zypak-wrapper (from org.electronjs.Electron2.BaseApp) replaces Chromium's
# SUID/namespace sandbox, which cannot be created inside bubblewrap.
export TMPDIR="${XDG_RUNTIME_DIR:-/tmp}/app/${FLATPAK_ID:-io.github.yojoe.VideoEditor}"
mkdir -p "$TMPDIR"
exec zypak-wrapper /app/lib/video-editor/video-editor "$@"
