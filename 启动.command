#!/bin/zsh
set -e
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo '请先安装 Node.js 22.15 或更新版本（包含 npm）。'
  read -k 1
  exit 1
fi
if [[ ! -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]]; then npm ci; fi
exec node scripts/install-mac.mjs
