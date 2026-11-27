# syntax=docker/dockerfile:1

# --- Deno binary (runs App backends; builds Deno-toolchain sources) -------
FROM denoland/deno:bin-2.9.8 AS deno

# Private in-panel Tailscale node (userspace, no TUN or privileged container).
FROM golang:1.27.4 AS tailscale
WORKDIR /build
COPY packages/tailscale/go.mod packages/tailscale/go.sum ./
RUN go mod download
COPY packages/tailscale/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -o /hatch-tailscale .

# --- Native Shell (NSH): builds and checks `native` App frontends ------------
# Pinned by version and SHA-256 (src/server/apps/native/nsh-toolchain.ts keeps
# the same values). The CLI finds its runtimes at bin/../runtime; the web
# runtime component is installed beside it so deploys never download it.
FROM debian:trixie-slim AS nsh
ARG TARGETARCH
ARG NSH_VERSION=0.7.0
ARG NSH_COMMIT=3f8ecd8
ARG NSH_LINUX_X86_64_SHA256=d281bfa3d93d84e9831e1a97dfdb63104329fcc87a0a48c78db5aeabb00c0073
ARG NSH_LINUX_ARM64_SHA256=8392ec026bd32d1554b22f5ae8b574abcb746b502bc6ac93bcdca1436fdbbffc
ARG NSH_WEB_SHA256=e951e78966a65af4d7a0bbcd08a4a5eef4f3b6b4adaec3b4b502df7c4fe8b4e6
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) archive=nsh-linux-x86_64.tar.gz; sum="$NSH_LINUX_X86_64_SHA256" ;; \
    arm64) archive=nsh-linux-arm64.tar.gz; sum="$NSH_LINUX_ARM64_SHA256" ;; \
    *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  base="https://github.com/longbridge/nsh/releases/download/v${NSH_VERSION}"; \
  curl -fsSL -o /tmp/nsh.tar.gz "$base/$archive"; \
  echo "$sum  /tmp/nsh.tar.gz" | sha256sum -c -; \
  curl -fsSL -o /tmp/nsh-web.tar.gz "$base/nsh-web.tar.gz"; \
  echo "$NSH_WEB_SHA256  /tmp/nsh-web.tar.gz" | sha256sum -c -; \
  mkdir -p /opt; \
  tar -xzf /tmp/nsh.tar.gz -C /opt; \
  tar -xzf /tmp/nsh-web.tar.gz -C /opt; \
  mkdir -p /opt/nsh/components; \
  printf '{"version":"%s","commit":"%s"}' "$NSH_VERSION" "$NSH_COMMIT" \
    > /opt/nsh/components/web.json; \
  /opt/nsh/bin/nsh --version | grep -q "^nsh ${NSH_VERSION} "; \
  rm -f /tmp/nsh.tar.gz /tmp/nsh-web.tar.gz

# --- Base image with pnpm ----------------------------------------------------
# pnpm installs the platform itself and, at deploy time, the dependencies of
# pnpm-lockfile Apps. The version matches `packageManager`.
FROM node:26-slim AS base
WORKDIR /app
RUN npm install --global pnpm@12.22.0

# --- Dependencies ------------------------------------------------------------
# Install ALL deps (including dev) and DO run install scripts: the platform
# needs `buf` + `protoc-gen-es` (codegen) and `esbuild` (bundling) at runtime
# when it builds apps, and those packages fetch native binaries on install.
FROM base AS deps
# pnpm-workspace.yaml carries `allowBuilds` (incl. esbuild) — required
# so pnpm runs esbuild's install script and fetches its native binary.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

# --- Build the platform (Nitro node server) + the Agent Runner bundle --------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG HATCH_BUILD_COMMIT
ARG HATCH_BUILD_COMMIT_TIME
# Migrations run at server startup (nitro plugin), not during the build.
RUN HATCH_BUILD_COMMIT="$HATCH_BUILD_COMMIT" \
    HATCH_BUILD_COMMIT_TIME="$HATCH_BUILD_COMMIT_TIME" pnpm build

# --- Runtime image -----------------------------------------------------------
# Shared by the standard (default) and full images defined at the end.
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3700
ENV AGENT_INTERNAL_HOST=0.0.0.0
ENV AGENT_INTERNAL_PORT=3701
# Deno caches npm: dependencies here (mount /cache to persist across restarts).
ENV DENO_DIR=/cache/deno
# Deploy builds of pnpm-lockfile sources share one package store on the same
# volume. Files are copied out of it, so builds never share inodes with it.
ENV HATCH_PNPM_STORE_DIR=/cache/pnpm-store

# Runtime tools used by the platform and Agent Runner. git backs canonical
# App repos and local worktrees; the remaining tools are available to
# model-controlled commands and deployment scripts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    python-is-python3 \
    python3 \
    python3-pip \
    ripgrep \
    rsync \
    unzip \
    util-linux \
    vim \
    wget \
  && rm -rf /var/lib/apt/lists/*

# Compatibility user used only to probe/fallback-test setpriv. Actual Agent
# shells and worktree git run under a stable numeric UID/GID unique to their
# session. This keeps AGENT_RUNNER_TOKEN — present only in the root Runner's
# environment — unreadable from /proc and isolates sessions from one another.
# The Runner itself stays root so it can allocate identities and setpriv/chown.
RUN useradd --system --user-group --no-create-home hatch-sandbox

# Deno runs the app backends the platform spawns.
COPY --from=deno /deno /usr/local/bin/deno
# NSH builds native App frontends (HATCH_NSH_BIN points the platform at it).
COPY --from=nsh /opt/nsh /opt/nsh
ENV HATCH_NSH_BIN=/opt/nsh/bin/nsh
# `hatch app deploy --build local` (the Agent's Runner without a Builder)
# builds with the image's own esbuild, TypeScript and buf instead of
# downloading them.
ENV HATCH_BUILD_TOOLCHAIN_DIR=/app
COPY --from=tailscale /hatch-tailscale /app/bin/hatch-tailscale

# Runtime needs: the built server, the full dependency tree (esbuild bundling,
# tsc type checks and buf/protoc-gen-es codegen happen on every deploy, and
# @types/deno is copied into each source's .hatch/), the scaffold template, the
# agent skills, the built-in Hatch SDK, and SQL migrations applied on startup.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Standalone CLI, available to both the Platform and Runner image entrypoints.
# It needs only Node and never receives the Runner fleet token automatically.
# Local builds run the build driver that sits next to the CLI's real path,
# so both files live in one directory and `hatch` links to the CLI there.
COPY --from=build --chmod=755 /app/packages/hatch-cli/dist/main.mjs /usr/local/lib/hatch-cli/main.mjs
COPY --from=build /app/packages/hatch-cli/dist/build-driver.mjs /usr/local/lib/hatch-cli/build-driver.mjs
RUN ln -s /usr/local/lib/hatch-cli/main.mjs /usr/local/bin/hatch
COPY --from=build /app/packages/hatch-cli/dist/licenses /usr/local/share/hatch-cli/licenses
# The Agent Runner and the optional Builder: same image, alternate
# entrypoints (`node dist/runner/main.mjs`, `node dist/builder/main.mjs`),
# no DB credentials.
COPY package.json ./
COPY migrations ./migrations
COPY templates ./templates
COPY skills ./skills
COPY --from=build /app/sdk-internal/app/package.json ./sdk-internal/app/package.json
COPY --from=build /app/sdk-internal/app/dist ./sdk-internal/app/dist
COPY --from=build /app/sdk-internal/data/package.json ./sdk-internal/data/package.json
COPY --from=build /app/sdk-internal/data/dist ./sdk-internal/data/dist
COPY --from=build /app/sdk-internal/ui/package.json ./sdk-internal/ui/package.json
COPY --from=build /app/sdk-internal/ui/dist ./sdk-internal/ui/dist

# Runtime data lives in /app/workspace; dependency/tool caches live in /cache.
RUN mkdir -p /app/workspace /cache/deno /cache/pnpm-store

EXPOSE 3700
# Platform (default). The Agent Runner runs the same image with
# `command: ["node", "dist/runner/main.mjs"]` (see docker-compose.yml).
CMD ["node", "dist/platform/server/index.mjs"]

# --- Full image --------------------------------------------------------------
# The runtime image plus optional heavyweight tools, published with a `-full`
# tag suffix. Add tools here rather than to `runtime` when only some
# deployments need them.
FROM runtime AS full
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# --- Standard image ----------------------------------------------------------
# Kept last so a plain `docker build .` produces the standard image.
FROM runtime AS standard
