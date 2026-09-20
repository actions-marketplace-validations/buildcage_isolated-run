# renovate: datasource=github-releases depName=opencontainers/runc
ARG RUNC_VERSION=v1.5.1
ARG RUNC_SHA256_AMD64=177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f
ARG RUNC_SHA256_ARM64=ca70e7dbd6616ca782a59b5d3ac86909123fdaa9fa3f89dcf29051c70eee7ce9

# Stated so a base image bump cannot move HAProxy quietly: apk fails rather than
# installing whatever the new Alpine carries.
ARG HAPROXY_BRANCH=3.4

# Prepare dependencies: runc's official release binaries are already
# statically linked (including libseccomp), so no compilation is needed,
# only a checksum-pinned download (see docs/development.md).
FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS deps
ARG RUNC_VERSION
ARG RUNC_SHA256_AMD64
ARG RUNC_SHA256_ARM64
RUN apk add --no-cache curl && \
    mkdir -p /opt/buildcage/bin && \
    ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/') && \
    EXPECTED_SHA256=$([ "$ARCH" = "amd64" ] && echo "$RUNC_SHA256_AMD64" || echo "$RUNC_SHA256_ARM64") && \
    curl -fsSL "https://github.com/opencontainers/runc/releases/download/${RUNC_VERSION}/runc.${ARCH}" \
      -o /opt/buildcage/bin/runc && \
    echo "${EXPECTED_SHA256}  /opt/buildcage/bin/runc" | sha256sum -c && \
    chmod +x /opt/buildcage/bin/runc

# Building gen-seccomp-profile here only compiles the binary: it's
# extracted onto the runner host and run natively there, not at image
# build time; see gen-seccomp-profile/main.go for why. Pure Go
# (CGO_ENABLED=0), so this cross-compiles natively via BUILDPLATFORM
# without needing QEMU.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:4cb7ac979db5fcc41cae44b2227ba5ab8a51e8807f40d9ba4dee20a0ad960b5b AS gen-seccomp-profile-build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY docker/gen-seccomp-profile/go.mod docker/gen-seccomp-profile/go.sum ./
RUN go mod download
COPY docker/gen-seccomp-profile/main.go ./
RUN CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build -trimpath -ldflags="-s -w" -o /out/gen-seccomp-profile .

# Bundle the QuickJS scripts (rolldown; see rolldown.scripts.config.js),
# since qjs has no TypeScript support. Architecture-independent output, so
# pinned to --platform=$BUILDPLATFORM like gen-seccomp-profile-build above
# (no QEMU).
FROM --platform=$BUILDPLATFORM ghcr.io/pnpm/pnpm:11@sha256:e26f380828856f205feaaf42abd157df9ce41bc8e17b662eeaa3379a9638dee0 AS qjs-build
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY rolldown.scripts.config.js ./
COPY src/core/ ./src/core/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm run build:qjs

# Final image
FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

LABEL org.opencontainers.image.title="isolated-run-proxy" \
      org.opencontainers.image.description="Network-isolated proxy for arbitrary GitHub Actions commands" \
      org.opencontainers.image.licenses="MIT AND GPL-2.0-or-later AND Apache-2.0" \
      org.opencontainers.image.source="https://github.com/buildcage/isolated-run"

ARG HAPROXY_BRANCH
RUN apk add --no-cache \
      s6-overlay \
      "haproxy~${HAPROXY_BRANCH}" \
      dnsmasq \
      iptables \
      iproute2 \
      gettext \
      curl \
      quickjs-ng

ENV S6_KEEP_ENV=1
ENV S6_LOGGING=0
# Stop the container when a service never comes up, instead of running on with a
# half-started tree and an s6-rc transition that never ends.
ENV S6_CMD_WAIT_FOR_SERVICES_MAXTIME=60000
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2
# Shutdown sleeps this long unconditionally between its SIGTERM and SIGKILL, so
# the default 3000 costs every teardown 3s. The services stop in under 50ms.
ENV S6_KILL_GRACETIME=500

COPY docker/universal/files/dnsmasq.conf /etc/dnsmasq.conf

RUN mkdir -p /etc/haproxy/rules /var/log/haproxy
COPY docker/universal/files/haproxy.cfg.template /etc/haproxy/haproxy.cfg.template

# Tools (QuickJS scripts, rolldown-bundled by qjs-build above).
# convert-rule.js is used by init-haproxy-cfg. No report-action.js here:
# src/lib/report.ts builds its own report in-process instead of fetching one
# from the container.
COPY --from=qjs-build /build/dist/qjs/src/core/scripts/convert-rule.js /opt/buildcage/scripts/convert-rule.js

# runc, extracted onto the runner host at action startup and used by
# run-isolated.sh to execute the isolated command (see docs/development.md)
COPY --from=deps /opt/buildcage/bin/runc /opt/buildcage/bin/runc

# gen-seccomp-profile, extracted onto the runner host and run natively
# there (not inside this container) to produce the seccomp filter embedded
# in runc's config.json; see the build stage comment above for why.
COPY --from=gen-seccomp-profile-build /out/gen-seccomp-profile /opt/buildcage/bin/gen-seccomp-profile

COPY docker/universal/files/THIRD_PARTY_LICENSES /opt/buildcage/THIRD_PARTY_LICENSES

COPY docker/universal/files/s6-rc.d/ /etc/s6-overlay/s6-rc.d/
COPY docker/universal/files/s6-scripts/ /etc/s6-overlay/scripts/

ENTRYPOINT ["/init"]
