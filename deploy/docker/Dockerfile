FROM ubuntu:24.04 AS base
# Build-time only: an ENV here would follow the image into the native CLI's environment.
ARG DEBIAN_FRONTEND=noninteractive
# Optional package mirror, e.g. http://mirrors.aliyun.com/ubuntu (amd64) or .../ubuntu-ports (arm64); empty keeps
# Ubuntu's own. It replaces every URIs line of the image's apt sources.
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i -E "s#^URIs: .*#URIs: ${APT_MIRROR}#" /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget openssl openssh-client git rsync \
    bash tini tar xz-utils unzip zip jq ripgrep file less vim-tiny \
    python3 python3-pip python3-venv build-essential pkg-config \
    procps lsof iproute2 dnsutils netcat-openbsd sqlite3 \
    && rm -rf /var/lib/apt/lists/*
# Ubuntu's image already supplies uid 1000; use a dedicated unprivileged identity.
RUN userdel -r ubuntu && useradd --uid 1000 --create-home --shell /bin/bash ccdesktunnel

# Node, the CLI and the package manifests: what both the server and the Web client build start from.
FROM base AS node
# Optional npm registry, e.g. https://registry.npmmirror.com; empty keeps the public one.
ARG NPM_REGISTRY=
# Legacy Docker builders create WORKDIR as root, even after USER.
RUN install -d -o ccdesktunnel -g ccdesktunnel /app
COPY scripts/install-linux.sh /tmp/install-linux.sh
USER ccdesktunnel
RUN if [ -n "$NPM_REGISTRY" ]; then export npm_config_registry="$NPM_REGISTRY"; fi \
    && CC_DESK_TUNNEL_RUNTIME=/home/ccdesktunnel/runtime bash /tmp/install-linux.sh
ENV PATH=/home/ccdesktunnel/runtime/node/bin:$PATH
WORKDIR /app
COPY --chown=ccdesktunnel:ccdesktunnel package.json package-lock.json ./
COPY --chown=ccdesktunnel:ccdesktunnel apps/server/package.json apps/server/package.json
COPY --chown=ccdesktunnel:ccdesktunnel apps/desktop/package.json apps/desktop/package.json
COPY --chown=ccdesktunnel:ccdesktunnel apps/mobile/package.json apps/mobile/package.json
COPY --chown=ccdesktunnel:ccdesktunnel packages/protocol/package.json packages/protocol/package.json

FROM node AS build
ARG NPM_REGISTRY=
# Building node-pty downloads Node's headers, which now and then breaks off; it is tried a second time.
RUN if [ -n "$NPM_REGISTRY" ]; then export npm_config_registry="$NPM_REGISTRY"; fi \
    && install() { npm ci --omit=dev --workspace=@cc-desk-tunnel/server --workspace=@cc-desk-tunnel/protocol; } \
    && { install || { sleep 20 && install; }; } \
    && npm cache clean --force
COPY --chown=ccdesktunnel:ccdesktunnel apps/server/src apps/server/src
COPY --chown=ccdesktunnel:ccdesktunnel packages/protocol/src packages/protocol/src

# A source checkout builds the shared UI; a release archive already contains it, and its build is used even with
# older sources beside it (manage.sh drops it when the checkout has moved on).
# Build-time frontend dependencies never enter the runtime stage. The stage starts from node, not build, so the
# two run side by side and a change to the server's sources leaves it cached.
FROM node AS web-build
ARG NPM_REGISTRY=
COPY --chown=ccdesktunnel:ccdesktunnel CHANGELOG.md ./
COPY --chown=ccdesktunnel:ccdesktunnel packages/protocol/src packages/protocol/src
COPY --chown=ccdesktunnel:ccdesktunnel apps/desktop apps/desktop
# A release archive's prebuilt client, if there is one. A directory given to COPY has its contents copied, the same
# with either builder; the always present runtime-level keeps the pattern from matching nothing. The client is put
# together in /tmp, which the build user can write whichever builder made the directories above it.
COPY --chown=ccdesktunnel:ccdesktunnel deploy/docker/runtime-level apps/server/we[b] /tmp/prebuilt-web/
RUN if [ -s /tmp/prebuilt-web/index.html ]; then \
      cp -R /tmp/prebuilt-web /tmp/web && rm /tmp/web/runtime-level; \
    elif [ -f apps/desktop/src/main.tsx ]; then \
      if [ -n "$NPM_REGISTRY" ]; then export npm_config_registry="$NPM_REGISTRY"; fi \
      && ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --include=dev --workspace=@cc-desk-tunnel/desktop --workspace=@cc-desk-tunnel/protocol \
      && node node_modules/vite/bin/vite.js build --config apps/desktop/vite.config.ts --outDir /tmp/web --emptyOutDir; \
    fi && test -s /tmp/web/index.html

FROM base
COPY --from=build --chown=root:root /home/ccdesktunnel/runtime /opt/runtime
COPY --from=build --chown=root:root /app /app
COPY --from=web-build --chown=root:root /tmp/web /app/apps/server/web
COPY deploy/docker/entrypoint.sh /usr/local/bin/proxy-entrypoint
COPY deploy/docker/healthcheck.mjs /app/healthcheck.mjs
# What a release needs from this image; a program installed from the client must not ask for more.
COPY deploy/docker/runtime-level /opt/runtime/level
# The working directory is made here with its owner: a builder without BuildKit makes the one WORKDIR names as root.
RUN chmod 755 /usr/local/bin/proxy-entrypoint && mkdir -p /data/workspace \
    && chown -R ccdesktunnel:ccdesktunnel /data
ENV PATH=/opt/runtime/node/bin:/opt/runtime/cli/bin:$PATH \
    HOME=/data/home
USER ccdesktunnel
WORKDIR /data/workspace
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "--env-file=/data/config/service.env", "/app/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/proxy-entrypoint"]
CMD ["server"]
