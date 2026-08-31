#!/usr/bin/env bash
# Clone + build whisper.cpp (pinned tag) and download a *multilingual* ggml
# model (never an English-only ".en" model - CaDS Tutor needs to handle
# German/English mixed dialog per the user's own working style).
#
# Same pattern as CADS-DEMO-deutschlandatlas-callcenter/scripts/setup_whisper_cpp.sh
# and CADS-DEMO-podcast/scripts/setup_whisper_cpp.sh - reusing a proven setup
# rather than reinventing it. On failure of the model download (no network,
# blocked host, 4xx/5xx), this script exits non-zero and prints exactly
# what's missing and why - it never silently substitutes a mock.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/whisper.cpp"
PINNED_TAG="b4938"
# Multilingual model. "base" (~148MB) is the default: fast to fetch/run and
# comfortably better than "tiny". For production-grade accuracy, re-run with
# WHISPER_MODEL_NAME=small (~488MB) or "medium" (~1.5GB).
MODEL_NAME="${WHISPER_MODEL_NAME:-base}"

case "$MODEL_NAME" in
  *.en) echo "FATAL: MODEL_NAME=$MODEL_NAME is English-only; CaDS Tutor needs a multilingual model (no .en suffix)." >&2; exit 1 ;;
esac

if [ -d "$VENDOR_DIR/.git" ]; then
  echo "whisper.cpp already cloned at $VENDOR_DIR - skipping clone"
else
  echo "Cloning ggml-org/whisper.cpp @ $PINNED_TAG ..."
  if ! git clone --branch "$PINNED_TAG" --depth 1 \
      https://github.com/ggml-org/whisper.cpp.git "$VENDOR_DIR"; then
    echo "FATAL: could not clone whisper.cpp from github.com. This is a real" >&2
    echo "network/availability limitation of this environment, not a bug in" >&2
    echo "this module." >&2
    exit 1
  fi
fi

echo "Building whisper.cpp (cmake, Release) ..."
cmake -B "$VENDOR_DIR/build" -S "$VENDOR_DIR" -DCMAKE_BUILD_TYPE=Release
NPROC="$(command -v nproc >/dev/null 2>&1 && nproc || sysctl -n hw.ncpu)"
cmake --build "$VENDOR_DIR/build" -j "$NPROC" --config Release --target whisper-cli

BIN="$VENDOR_DIR/build/bin/whisper-cli"
if [ ! -x "$BIN" ]; then
  echo "FATAL: build finished but $BIN was not produced." >&2
  exit 1
fi
echo "Built: $BIN"

MODEL_PATH="$VENDOR_DIR/models/ggml-${MODEL_NAME}.bin"
if [ -f "$MODEL_PATH" ]; then
  echo "Model already present at $MODEL_PATH - skipping download"
else
  echo "Downloading ggml $MODEL_NAME model (multilingual) from huggingface.co/ggerganov/whisper.cpp ..."
  if ! ( cd "$VENDOR_DIR" && bash "models/download-ggml-model.sh" "$MODEL_NAME" ); then
    echo "" >&2
    echo "FATAL: whisper.cpp model download failed." >&2
    echo "This is a real limitation of this sandbox/network (huggingface.co" >&2
    echo "unreachable or blocked), not a module bug. Real transcription will" >&2
    echo "refuse to run without this model (see src/stt.ts)." >&2
    exit 1
  fi
fi

if [ ! -f "$MODEL_PATH" ]; then
  echo "FATAL: download script exited 0 but $MODEL_PATH is still missing." >&2
  exit 1
fi

echo ""
echo "whisper.cpp ready:"
echo "  WHISPER_CLI_PATH=$BIN"
echo "  WHISPER_MODEL_PATH=$MODEL_PATH"
