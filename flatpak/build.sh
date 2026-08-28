#!/usr/bin/env bash
# Build the Flatpak bundle: compiles the app with electron-builder, then runs
# flatpak-builder against the manifest and exports a .flatpak single-file bundle.
#
#   ./flatpak/build.sh            # build + install for the current user
#   ./flatpak/build.sh --bundle   # additionally write video-editor.flatpak
set -euo pipefail
cd "$(dirname "$0")/.."

APP_ID=io.github.yojoe.VideoEditor

# Runtimes may live in either installation; only install if missing.
for ref in org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08 org.electronjs.Electron2.BaseApp//24.08; do
  flatpak info "$ref" >/dev/null 2>&1 || flatpak install -y --noninteractive flathub "$ref"
done

npm ci
npm run build
npx electron-builder --linux dir

flatpak-builder --user --install --force-clean --state-dir=flatpak/.flatpak-builder \
  flatpak/build-dir flatpak/${APP_ID}.yml

if [[ "${1:-}" == "--bundle" ]]; then
  flatpak-builder --user --repo=flatpak/repo --force-clean --state-dir=flatpak/.flatpak-builder \
    flatpak/build-dir flatpak/${APP_ID}.yml
  flatpak build-bundle flatpak/repo video-editor.flatpak ${APP_ID}
  echo "Wrote video-editor.flatpak"
fi

echo "Run with: flatpak run ${APP_ID}"
