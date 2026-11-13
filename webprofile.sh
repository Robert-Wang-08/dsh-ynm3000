#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$ROOT/dsh-permission-compat/tools/dsh-web-safe.ps1" "$@"
