# CaDS Tutor whisper-service — self-contained container for durable hosting.
#
# Same proven build pattern as CADS-DEMO-deutschlandatlas-callcenter/deploy/Dockerfile
# (whisper.cpp built from source, pinned tag, multilingual ggml-base model baked in) -
# reused, not reinvented. Footprint is static: STT temp files are deleted per request
# (see src/stt.ts's mkdtemp/rm), nothing accumulates unboundedly.
#
# The only external runtime dependency is optional: WHISPER_SERVICE_API_KEY gates
# /transcribe when this is reachable over a public tunnel (see deploy/.env.template).

ARG TARGETARCH

# ---- stage 1: build whisper.cpp + fetch the model ----
FROM node:22-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --branch b4938 --depth 1 https://github.com/ggml-org/whisper.cpp.git
WORKDIR /build/whisper.cpp
# GGML_NATIVE=OFF: ggml's default -march=native CPU auto-detection is unreliable inside a
# container - hit live building this on arm64 (Docker Desktop on Apple Silicon): the detected
# flags enabled an ARM NEON fp16 vector op in one translation unit without consistently
# enabling it project-wide, so GCC's always_inline check failed ("target specific option
# mismatch" on vaddq_f16) partway through the build, not at configure time. A portable
# baseline (no native auto-detection) trades a little runtime perf for actually building
# reliably across whatever host architecture this image is built/run on.
RUN cmake -B build -S . -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
 && cmake --build build -j "$(nproc)" --config Release --target whisper-cli \
 && bash models/download-ggml-model.sh base

# ---- stage 2: build the TypeScript service ----
FROM node:22-bookworm-slim AS tsbuild
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: package.json's "prepare": "tsc" would otherwise run right here, before
# tsconfig.json/src are even copied into the image - tsc with no config and no source fails
# npm ci itself (real build failure, caught live deploying this - not a hypothetical). The
# explicit "npx tsc" below, run after the real source is present, is the actual build step.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- stage 3: runtime ----
FROM node:22-bookworm-slim AS runtime
# ffmpeg is required by src/stt.ts's toWhisperWav() - it resamples uploaded audio to
# 16kHz mono before handing it to whisper-cli. Missing this makes /transcribe fail on
# every request (a real, previously-hit gotcha in the sibling callcenter Dockerfile -
# reused here as a known trap, not rediscovered).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# whisper-cli + its shared libs (dynamically linked against libwhisper.so/libggml*.so,
# built alongside it by this cmake build - copying only the executable leaves it unable
# to even start, same gotcha the callcenter Dockerfile already documents).
COPY --from=build /build/whisper.cpp/build/bin /opt/whisper-cli-bin
COPY --from=build /build/whisper.cpp/models/ggml-base.bin /app/vendor/whisper.cpp/models/ggml-base.bin
RUN chmod +x /opt/whisper-cli-bin/whisper-cli \
 && mkdir -p /app/vendor/whisper.cpp/build/bin \
 && ln -s /opt/whisper-cli-bin/whisper-cli /app/vendor/whisper.cpp/build/bin/whisper-cli

COPY --from=tsbuild /app/dist ./dist
COPY package.json ./

RUN chown -R node:node /app
ENV LD_LIBRARY_PATH=/opt/whisper-cli-bin \
    NODE_ENV=production \
    WHISPER_SERVICE_PORT=8756

EXPOSE 8756
USER node
CMD ["node", "dist/cli/whisper-service.js"]
