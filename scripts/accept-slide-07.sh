#!/usr/bin/env bash
set -euo pipefail

missing=()
if [[ -z "${DASHSCOPE_API_KEY:-}" ]]; then
  missing+=("DASHSCOPE_API_KEY")
fi
if [[ -z "${DASHSCOPE_WORKSPACE_ID:-}" ]]; then
  missing+=("DASHSCOPE_WORKSPACE_ID")
fi
if (( ${#missing[@]} > 0 )); then
  joined=""
  for variable in "${missing[@]}"; do
    if [[ -n "$joined" ]]; then
      joined+=", "
    fi
    joined+="$variable"
  done
  printf 'Missing required environment variables: %s\n' "$joined" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SLIDE_IMAGE="/Users/neomei/项目/codexprojects/PPT 编辑/.codex-tmp/deck-audit/template-inspect/source-slides/source-slide-07.png"

if [[ ! -f "$SLIDE_IMAGE" ]]; then
  printf 'Slide 7 source image not found: %s\n' "$SLIDE_IMAGE" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
exec npm run cli -- run --image "$SLIDE_IMAGE" --out output/slide-07 --record
