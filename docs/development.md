# Development Guide

This document covers local development, testing, and the project structure of isolated-run.

## Contents

- [Local Usage](#local-usage)
- [Testing](#testing)
- [Local Development](#local-development)
- [Formatting & Linting](#formatting--linting)
- [Viewing Logs](#viewing-logs)
- [Makefile Commands](#makefile-commands)
- [Directory Structure](#directory-structure)
- [Action Internals](#action-internals)
- [Inspect Engine Internals](#inspect-engine-internals)
- [Troubleshooting](#troubleshooting)

## Local Usage

You can run isolated-run's proxy locally without GitHub Actions using Docker Compose and Make.

GitHub Actions inputs are lowercase (`proxy_mode`); the environment variables for local usage are
the uppercase form of the same names (`PROXY_MODE`).

### Sandbox Dev Loop (mac-friendly)

The action's own isolation mechanism (`run-isolated.sh`) uses Linux-only primitives (`ip netns`,
`nsenter`, `runc`) that can't run natively on macOS. `make setup_sandbox_dev` /
`make test_sandbox_dev` instead drive it from inside a container with `pid: host` and
`/var/run/docker/netns` mounted in (see `dev/Dockerfile` and `docker/compose.sandbox-dev.yaml`),
which is enough to reach the proxy container's `SandboxKey` netns the same way production does.
That is close enough to the real "runner host + separate proxy container"
arrangement for day-to-day iteration, though it can't validate the container-boundary parts of
production (see [Action Internals](#action-internals) below). `runc` and `gen-seccomp-profile` are
built directly into the dev-loop image (mirroring `docker/universal/Dockerfile`) rather than
`docker cp`-extracted from the proxy image at runtime, so the dev loop doesn't need the Docker
socket mounted in just to reach a sibling container; `dev/build-test-bundle.sh` stands in for
`lib/sandbox/oci-config.ts`'s `buildOciConfig` to build a minimal OCI bundle for the smoke test.
CI's `test_sandbox_*` e2e jobs run `run-isolated.sh` directly on the runner host instead, matching
production exactly. Treat those as the final word on whether a change actually works, not this dev
loop.

```bash
make setup_sandbox_dev  # start the proxy + dev-loop runner container
make test_sandbox_dev   # run a sample isolated command and verify allow/block + capability drop
```

## Testing

```bash
make test_unit_core      # core library unit tests (src/core)
make test_unit_sandbox   # action's own unit tests (src/lib, src/main.ts)
make test_unit_qjs       # dual-runs the acl module's tests under real QuickJS in a throwaway image
make test_unit           # all of the above
make test_unit_coverage  # every Node test in one run, with a coverage report in coverage/
```

CI runs `make test_unit_coverage` and pastes `coverage/summary.txt` into the job summary. The
threshold is 100% on all four counters, so anything added without a test fails the run. Code that is
deliberately not tested carries a `/* v8 ignore */` comment saying why, which keeps that decision in
the source rather than buried in a percentage. Only two things qualify: code whose body lives
outside the process, and the default implementation behind a seam whose callers are already tested.
The QuickJS run is not measured separately, since it executes the same `.test.ts` files as the Node
run.

`make test_sandbox_dev` is the dev-loop end-to-end check described above; `make
test_integration_sandbox_linux` drives `dist/main.cjs` directly for checks that don't depend on
the real action wrapper (see `test/integration-test-*.sh`) and is what CI's `test_sandbox` job in
`test-integration.yml` runs. The ones that need the fixture origin live in
`test_integration_sandbox_universal` instead, whether they need it for what only a fixture can
cover or just to keep off the real internet. The CI-only `test_sandbox_*` end-to-end jobs (real
runner host, no nested container) are described in [Action Internals](#action-internals) below.

### Running the integration tests from several git worktrees

`test_integration_sandbox_universal` and `test_integration_sandbox_inspect` use the fixture origins
in `compose.test-*.yaml`, whose network name is global to the daemon, so two worktrees would
otherwise fight over it and over the fixtures' `10.200.0.x` addresses.

Nothing has to be configured. The Makefile takes the worktree's name from `git rev-parse
--git-dir`, suffixes the network name with it and derives the network's own subnet from it, and
exports both so the test scripts and the proxy the action starts agree. The main checkout gets the
unsuffixed name and the subnet CI uses.

The fixtures' addresses are not part of that. Each assigns its own `10.200.0.x` inside its own
network namespace instead of taking one from Compose IPAM (see each fixture's entrypoint, and
`test/test-net-addr` for the proxy's side of it), so the daemon never allocates `10.200.0.0/24` and
every worktree uses the same addresses. That is why the assertions name those addresses literally.

A fresh worktree needs `vp install` first: `node_modules` is per checkout, and these tests run
`dist/main.cjs` with the repo's own dependencies.

The rest of `test/integration-test-*.sh` clean up only the proxy containers they started
themselves, read back from their own `GITHUB_STATE` (`main.ts` writes the name there before
creating the container). A `buildcage-proxy-*` sweep would otherwise remove, or call a leak,
whatever another worktree has running. `integration-test-listener-scope.sh` is the one script with
fixed Compose and container names of its own, and those carry the suffix too.

## Local Development

### Local testing of the action

Sigstore verification requires a real, published GHCR image, so the action normally can't run
against an unpublished branch or local changes. This repo's own CI (the `test_sandbox_*` jobs in
`.github/workflows/test-e2e.yml`) tests the real action end-to-end against a locally built image
instead, via a build-time-gated mechanism: `BUILDCAGE_BUILD_TEST_HOOKS=1 vp run build` compiles
`dist/main.cjs` where the `BUILDCAGE_LOCAL_IMAGE_REF` override is reachable. The override logic
lives in its own module (`src/core/lib/provenance/local-image-override.ts`), loaded only via a
dynamic `import()` gated by that build-time flag. Without the flag (i.e. every normal/committed
build), rolldown's own module-graph tree-shaking excludes that entire file from the bundle. It is
physically absent, not just unreachable. A CI check (`unit_test` job) additionally confirms a
normal build never contains a live runtime read of `BUILDCAGE_BUILD_TEST_HOOKS` in `dist/`,
guarding against a future refactor silently breaking that guarantee.

To exercise it locally:

1. Build the image: `docker compose build proxy`.
2. `BUILDCAGE_BUILD_TEST_HOOKS=1 vp run build`
3. Run it with `BUILDCAGE_LOCAL_IMAGE_REF=<image ref from step 1>` set (e.g. via `act`, or by
   invoking `node dist/main.cjs` directly with the relevant `INPUT_*` env vars; note the action's
   own isolation step still needs a real Linux host, so this only gets you past image verification,
   not a full local run on macOS). Never commit a `dist/main.cjs` built this way: run
   `vp run build` again (without the flag) before committing.

See [security.md](./security.md#verification-limitations) for more details.

## Formatting & Linting

Formatting, linting, and type-aware linting are handled by [vp (Vite+)](https://viteplus.dev/),
installed globally on your machine like `pnpm`/`corepack` rather than through `pnpm exec`:

```bash
curl -fsSL https://vite.plus | bash   # macOS/Linux
# Windows: irm https://viteplus.dev/install.ps1 | iex
```

The project pins its own toolchain version via the `vite-plus` devDependency in `package.json`
(the same way `packageManager` pins `pnpm`), and the globally installed `vp` binary detects and
delegates to that pinned version automatically, so plain `vp ...` commands are reproducible without
going through `pnpm exec`.

```bash
vp check       # format + lint + type-aware lint (read-only; what CI runs)
vp check --fix # same, but auto-fixes format/lint issues in place
vp lint --fix
vp fmt --write
```

`vp run typecheck` (`tsc`) remains the authoritative full type check; `vp check`'s type-aware
linting (via `oxlint-tsgolint`) catches a subset of type-driven issues fast but doesn't replace it.

Running `vp install` (in place of `pnpm install`) automatically sets up a pre-commit hook, via the
`prepare` script, that formats and lints your staged files (`vite.config.ts`'s `staged` config)
before each commit, auto-fixing and re-staging what it can.

## Viewing Logs

```bash
# Communication logs from the locally-built proxy
docker compose logs proxy

# Real-time log monitoring
docker compose logs -f proxy
```

**Log format (`universal`):**

```
[28/Feb/2026:10:15:30 +0000] buildcage [ALLOWED] "github.com:443" -
[28/Feb/2026:10:15:31 +0000] buildcage [BLOCKED] "malicious.com:443" not-allowed
[28/Feb/2026:10:15:32 +0000] buildcage [AUDIT] "npmjs.org:80" -
```

Fields: `[timestamp] buildcage [status] "domain:port" reason`

**`inspect` reads two logs instead**, since a name CoreDNS refused never reaches HAProxy at all:

```bash
docker compose exec proxy cat /var/log/haproxy/current
docker compose exec proxy cat /var/log/coredns/current
```

HAProxy's log carries one line per request, oldest first, with its method, status, size, and its
full URL last:

```
buildcage 1787471975123 https GET 200 708 ts=-- reason=- dst=104.16.1.34:443 https://registry.npmjs.org/express
buildcage 1787471976000 pass tls 3421 ts=-- reason=- dst=10.200.0.100:5432 sni=db.example.com
```

The URL and the SNI come last because a step decides how long they are: every field the report
needs to place an event then sits ahead of anything that could cut the line short. The line is
sized for the longest request HAProxy will accept, so nothing should cut one; a line that arrives
unreadable anyway is counted, and the report says it is not a full record rather than passing off
what survived as everything. A line the log pipe dropped whole leaves no trace and cannot be
counted.

Refusals are interleaved with the rest:

```
✅ 00:00.512: GET https://registry.npmjs.org/express -> 200 (99.9KB)
🚫 00:01.048: DNS secret-data.attacker.example -> dns-not-allowed
🚫 00:01.390: POST https://registry.npmjs.org/express/-rev/1-abc -> not-allowed
✅ 00:02.115: TLS db.example.com:5432 -> (12.3KB)
```

Times are relative to when the proxy started. A refusal names its reason rather than a status. The
`reason` field carries it whenever the rule that refused knew one the line could not otherwise show
(`dns-failed`, `internal-address`); a `-` there leaves the termination state's phase to name it: `R`
a request buildcage refused (`not-allowed`), `C` an origin that could not be reached or verified,
`H` one that never sent usable response headers, `D`/`L` one that cut the transfer short.

Each log is an s6-log directory rather than a single file: `current` rotates into a timestamped
archive once it crosses 1MB, up to 100 archives kept, and a line is only ever split past 32KB. The
report reads every archive, oldest first, then `current`, so early traffic is never dropped just
because a later part of the same run pushed the log past a rotation. Reading `current` by hand, as
above, only shows what has accumulated since the most recent one.

## Makefile Commands

`make help` lists every target with its own description. The ones you type most:

| Command                                   | Description                                                        |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `make setup_sandbox_dev`                  | Start the proxy and the mac-friendly dev-loop runner               |
| `make test_sandbox_dev`                   | Run a sample isolated command in the dev loop and verify isolation |
| `make clean_sandbox_dev`                  | Stop and remove the dev-loop containers                            |
| `make test_unit`                          | Every unit test: core, the action's own, and the QuickJS run       |
| `make test_unit_coverage`                 | Every Node unit test in one run, with a coverage report            |
| `make test_integration`                   | Every integration test CI runs, as the four groups below           |
| `make test_integration_sandbox_linux`     | The action's integration tests on a Linux host                     |
| `make test_integration_sandbox_universal` | The ones that need the universal engine's fixture origin           |
| `make test_integration_sandbox_inspect`   | The same for the inspect engine, round trip included               |
| `make test_integration_listener_scope`    | `:10024`/`:53` stay unreachable outside `buildcage0`, both engines |

The first three integration groups need `BUILDCAGE_LOCAL_IMAGE_REF` and a test-hook build of
`dist/main.cjs`; see [Local Development](#local-development) above. They do not all want the same
image: the inspect group needs one built from `docker/inspect`, and `test_integration_listener_scope`
builds both images itself and wants the variable unset. So `make test_integration` records what CI
runs rather than running it in one go; build the image a group needs, then run that group.

## Directory Structure

```text
.
├── action.yml                 # Action entry (node24 → dist/main.cjs, dist/post.cjs)
├── src/                       # Source (ESM)
│   ├── main.ts / post.ts      # Start proxy, run isolated command, report, stop
│   ├── lib/                   # Action-specific implementation: container, report, sudo-preflight,
│   │                          # sandbox/ (OCI config, runc bootstrap, netns/mountinfo helpers)
│   └── core/                  # Code shared with the isolated-run proxy image's QuickJS scripts
│       ├── lib/                # acl/ (rule parsing and the proxy config generators, dual-consumed
│       │                      # by Node and QuickJS), actions/, docker/, provenance/ (Sigstore,
│       │                      # OCI registry lookups, image ref resolution, local-image test-hook
│       │                      # override), report/, log/, test/test-shim.ts (portable
│       │                      # node:test-alike shim used by *.test.ts across Node and QuickJS
│       │                      # alike)
│       └── scripts/            # QuickJS entry point (convert-rule.qjs.ts), run inside the built
│                              # image (rolldown-bundled into /opt/buildcage/scripts/ at image
│                              # build time; see rolldown.scripts.config.js). test/ is a qjs test
│                              # runner, types/ is the qjs:std/qjs:os ambient type declaration
├── dist/                      # Bundled output (rolldown → CommonJS); dist/qjs, dist/qjs-test are
│                              # gitignored build-time scratch output, not committed
├── docker/                    # Proxy image build contexts, one per proxy_engine
│   ├── universal/             # alpine + haproxy/dnsmasq/iptables/s6-overlay + pinned runc +
│   │                          # gen-seccomp-profile, plus their config and s6 service definitions
│   ├── inspect/               # alpine + haproxy/CoreDNS/s6-overlay, plus scripts/ (gen-configs
│   │                          # runs under QuickJS at container startup)
│   ├── gen-seccomp-profile/   # Go module: derives a seccomp filter from Docker's default profile
│   ├── compose.action.yaml    # Runtime compose file the action itself uses (verified,
│   │                          # digest-pinned image ref), distinct from the top-level compose.yaml
│   ├── compose.action.test-inspect.yaml  # Same, for the inspect-engine integration tests
│   └── compose.sandbox-dev.yaml  # Mac dev-loop overlay (see dev/)
├── scripts/run-isolated.sh    # netns/veth/rootfs-bind setup around `runc run`, invoked via
│                              # `sudo -n` (see Action Internals)
├── test/                      # assert-sandbox*.sh + integration-test-*.sh (capability/filesystem/
│                              # seccomp/die-with-parent checks driving dist/main.cjs directly) and
│                              # *-scenarios.sh (run inside the sandbox as a step's own `run:`).
│                              # helpers.sh carries what both halves share: pass/fail, check_status/
│                              # check_ok, assert_summary_contains, and the result line each half
│                              # ends with
├── dev/                       # Mac dev-loop-only Dockerfile + smoke-test.sh + build-test-bundle.sh
│                              # (see docker/compose.sandbox-dev.yaml), not used in production or CI
├── docs/                      # development.md, security.md, plus the reference.md/rules.md/
│                              # inspect-engine.md link stubs
├── licenses/                  # gen-license-file.mjs, which regenerates THIRD_PARTY_LICENSES_NPM
│                              # during `vp run build`, and what .glf.jsonc substitutes in
├── compose.yaml               # Docker Compose config for local dev (builds docker/universal/Dockerfile;
│                              # also what CI's test_sandbox/test_sandbox_* jobs build from)
└── Makefile                   # Operational commands
```

## Action Internals

This section walks through how the action isolates one `run:` command, in the order it actually
happens. For the user-facing behavior and threat model, see [Security Details](./security.md) and
the [README](../README.md).

1. Verify the proxy image's provenance and resolve a digest-pinned image ref (`src/main.ts`).
2. Start a dedicated, throwaway proxy container for this one step (`src/main.ts`).
   - The container provides network-layer isolation only (iptables `REDIRECT`/`INPUT`/`DROP`
     rules, dnsmasq, HAProxy), with no build daemon.
   - Every `docker compose` invocation passes an explicit `-p <containerName>`, so concurrent
     `run:` steps in the same job (GitHub Actions' `background`/`wait`/`parallel` keywords) never
     share an implicit, directory-derived Compose project; otherwise one step's `up`/`down` could
     recreate or tear down another step's still-running container.
3. Extract `runc` and a seccomp-profile generator onto the runner host
   (`src/lib/sandbox/runc-bootstrap.ts`).
   - Both ship inside the proxy image and are pulled onto the host via `docker cp`, then run
     natively there rather than `docker exec`'d, since the seccomp profile's content depends on
     the real host's kernel and architecture.
   - Extracted fresh into this step's own scratch directory on every invocation (no shared,
     cross-step/cross-job cache), so each `run:` step is fully independent and everything extracted
     is torn down with the scratch directory afterward.
4. Build an OCI runtime bundle (`config.json`) describing the sandbox
   (`src/lib/sandbox/oci-config.ts`).
   - Starts from `runc`'s own default spec, then patches in: a root filesystem pointing at a
     not-yet-created bind-mount directory, made read-only (every real host mount point is forced
     individually read-only outside workdir/home/tmp/RUNNER_TEMP/writable, since the top-level
     read-only flag alone doesn't cover separate mount points); a network namespace reference to the
     netns created in the next step; all Linux capabilities cleared plus no-new-privileges; and a
     seccomp filter resolved from Docker's own default profile, applied against an empty
     capability set to match the sandbox.
   - A few of `runc`'s own defaults are overridden so the command sees the environment an
     unwrapped step would: the runner's own `RLIMIT_NOFILE` in place of the 1024-file cap runc and
     `sudo` both impose, `/dev/shm` sized from the host's own, and the runner's hostname in place of
     the literal `runc`. `test/integration-test-host-parity.sh` checks these on a real runner, once
     with the limits as inherited and once under a deliberately lowered soft limit.
   - The limit is read from `/proc/<ppid>/limits`, never `self`. Node raises its own soft
     `RLIMIT_NOFILE` to the hard limit before any JS runs, so the action's own view reports the hard
     limit as the soft one, and the sandbox would end up with more than the step had. A
     GitHub-hosted runner sets soft = hard, which hides the difference entirely; that is what the
     lowered-limit pass in the parity test exists to expose.
   - `/dev/shm`'s size is taken only after confirming the fstype is tmpfs. Where `/dev/shm` is a
     plain directory rather than a mount of its own, `statfs` answers for the containing filesystem,
     and sizing a fresh tmpfs to a whole disk would let a step exhaust host memory.
   - The step's environment is deliberately _not_ part of that config. It is piped to the
     sandboxed process over stdin as NUL-delimited `KEY=VALUE` records and applied by a small
     loader that execs the run script, so an `env:` secret is never written to the runner's disk.
     Do not move it back into `config.json`. `RUNNER_ONLY_ENV_KEYS` and `ACTION_INPUT_ENV_KEYS`
     in `env-loader.ts` are what keep the runner's JavaScript-action credentials, and this
     action's own inputs, out of that blob.
   - `/var/tmp/buildcage-<uid>` is covered with an empty tmpfs inside the sandbox, with only this
     run's own `exec/` subdirectory (the run script and that loader) bound back on top, read-only.
     Without it, the host-`/` rootfs below would hand every step a readable copy of every other
     concurrent step's bundle. The reveal is a non-recursive `bind`: the scratch directory also
     holds the live `mount --rbind /` rootfs, and an `rbind` would pull that in as a second,
     writable copy of the whole host `/`.
   - The writable exceptions are recursive bind-mounts (so legitimately nested mounts under them
     stay visible). The `mount --rbind /` rootfs is therefore staged under `/var/tmp/buildcage-<uid>`,
     never one of the writable exceptions, so those recursive rbinds don't re-expose it as a
     second, _writable_ copy of the whole host `/` inside the sandbox. A `write_through:` input
     naming that directory (or an ancestor of it) is rejected outright rather than silently accepted. The
     sandbox's real host view (its own `/` and every nested mount) is untouched and stays read-only
     outside the writable set.
5. Stage the sandbox's network and filesystem as root, via `sudo -n` (`run-isolated.sh`).
   - Re-execs itself into a fresh, private mount namespace before touching anything else, so the
     mount work below is invisible to every other `run:` step running concurrently on the same
     host.
   - Bind-mounts the host's own root filesystem onto a fresh directory to serve as the sandbox's
     rootfs (a plain `pivot_root` can't target the real root directly). Done before the network
     setup below, since it has no dependency on it and doing it first minimizes the gap between the
     mount-table snapshot the read-only patching above was computed from and this actually
     capturing the host's mount table.
   - Creates a network namespace and a veth pair, with one end moved into it (as `eth0`) and the
     other moved into the proxy container's own netns, renamed to `buildcage0`, and given the
     proxy's fixed gateway address directly. There is no bridge, since this is always a 1:1
     connection (one sandbox, one proxy) and a plain named interface is enough for `init-iptables`'s
     `-i buildcage0` rule (added at container startup) to match once this device appears later.
   - The proxy's netns is referenced by Docker's own `NetworkSettings.SandboxKey` path (see
     `getContainerNetns` in `src/lib/container.ts`), not by PID -- Docker holds that path for the
     container's whole lifetime, so it can't be silently reused if the proxy dies before use.
6. Run the sandboxed command via `runc`.
   - runc creates its own further-nested namespaces per `config.json` and enforces every
     isolation guarantee declared there: capability drop, seccomp filter, read-only filesystem,
     network namespace.
   - A two-hop process-supervision chain ties the sandboxed process's life to the staging step
     above: the process that starts `runc` and, separately, the sandboxed command itself both
     die if their immediate parent does, so killing the staging step tears down the whole chain
     instead of leaving the sandboxed command running as an orphan.
7. Clean up once the command exits (`run-isolated.sh`).
   - An exit trap tears the container down, unmounts the rootfs bind-mount, removes the veth, and
     deletes the network namespace.
   - As a second layer of defense, anything still mounted under the run's own scratch directory
     is force-detached before that directory is deleted, in case the trap above didn't run to
     completion.
8. Append this step's report to the Job Summary and stop the proxy container (`src/main.ts`).
   - The report is built in-process on the runner: `src/lib/report.ts` reads the container's own
     communication log via `docker exec ... cat`, then the container is stopped.
   - If the whole process is killed before reaching this point, a fallback step reads the
     container's identity back from job state and stops it anyway, and reclaims the step's scratch
     directory, whose path it reconstructs deterministically from that same identity, then
     force-detaches any surviving mount before deleting (`src/post.ts`).

## Inspect Engine Internals

This section covers how `proxy_engine: inspect` is implemented internally. For the user-facing
behavior, see [Inspect Proxy Engine](./security.md#inspect-proxy-engine) in Security Details.

- `PROXY_ENGINE=inspect` selects `docker/inspect/Dockerfile` at build time (see `compose.yaml`'s
  `build.dockerfile: docker/${PROXY_ENGINE:-universal}/Dockerfile`), and the action's own runtime
  compose file for the engine is `docker/compose.action.yaml`, with
  `docker/compose.action.test-inspect.yaml` overlaying it for the integration tests.
- **HAProxy** is the single listener. `req.ssl_hello_type` tells a TLS handshake from a plain
  request by its first bytes, so one `bind` line handles both without the config declaring per-port
  whether it's plaintext or TLS. Two HAProxy features carry the rest of the enforcement:
  `normalize-uri` (an upstream directive still marked experimental, gated behind
  `expose-experimental-directives` in `src/core/lib/acl/haproxy-sections.ts`) resolves `..` in the
  path before ACLs see it, and `do-resolve` + `set-dst` resolve the requested name and rewrite the
  connection's destination to it, run only after the ACL check for that request has already passed.

  What those two resolve against is the container's own `/etc/resolv.conf`, through HAProxy's
  `parse-resolv-conf`, as in `universal`. On a runner that file is Docker's embedded DNS forwarding
  to the runner's own resolvers, so a name only an internal resolver knows resolves, and the query
  follows the runner's own DNS policy. `EXTERNAL_RESOLVER` names upstreams explicitly instead; it
  is not an action input, and only the integration tests set it, to reach their own fixture
  resolver. Either way HAProxy's resolvers do no search-domain expansion, so a rule has to name a
  host in full.

- **CoreDNS** answers every query with the proxy's own address, allowed or not, using an `expr`
  plugin view compiled from the same host patterns HAProxy's own ACLs use, so what's logged as
  `allowed` matches exactly what HAProxy would actually let through:

  ```
  # Allowlisted names are logged as allowed, but answered exactly like a denied
  # one below: this resolver never gets a request any closer to a real address.
  . {
      view allowlist {
        expr name() matches '^(abc[^.]*\.amazonaws\.com|registry\.npmjs\.org)\.$'
      }
      template IN A   { answer "{{ .Name }} 60 IN A <proxy-ip>" }
      template IN AAAA { }
      template IN ANY  { }
      log . "buildcage dns allowed name={name}"
  }
  ```

  Reverse lookups get their own block, ahead of these, answering `PTR` with `NXDOMAIN` and
  logging `buildcage dns reverse name=...`. Nothing in the cage has a name to give back, and no
  rule can name an address backwards, so the lookup is recorded rather than judged. `NXDOMAIN` is
  what ends it: a query no template matches is answered `SERVFAIL` instead, which musl retries and
  then waits out its full five-second resolver timeout on, once per lookup. `template IN ANY` above
  does the same for every other query type, `SRV` and `HTTPS` included.

  A view of its own holds that block to names that really are an address backwards. Anything else
  under `in-addr.arpa` or `ip6.arpa`, `SECRET-DATA.in-addr.arpa` included, misses the view and
  falls through to the blocks above, so appending a reverse suffix is no way out of the report.

  Service-discovery names get a block of the same shape, logging
  `buildcage dns discovery name=... type=...`. No rule can permit one: this resolver returns no
  discovery record to anybody, so reporting the lookup as denied would put a row in the report that
  no rule could ever take away, and fail the step under `fail_on_blocked` over a lookup the caller
  falls back from on its own. apt asks for `_http._tcp.<repo>` on every repository it fetches from,
  which is how this shows up in practice. The report keeps these out of both host tables and shows
  them in the timeline instead, carrying the query type, which is the difference between a fallback
  nobody notices and a `mongodb+srv://` connection that fails outright.

  Its view is what stops that verb from becoming a hiding place. Three things have to hold: the name
  is shaped like a service name, the host below it is one the rules allow, and the type is one of
  the four defined at such a name (`SRV`, `TXT`, `TLSA`, `URI`). A type nobody has taught the block
  about is not one to exempt on a guess.

  Every other service name gets a block of its own after the allowlist, logging
  `buildcage dns service-denied name=... type=...`. Note that only this second block sits after the
  allowlist: the discovery block sits before it, so a service name under an allowed host reads as
  `discovery` even when a rule names it outright. That is the more accurate of the two, the record
  being unserved either way. It is a refusal like any other, kept apart only
  so the report can name the remedy: the host below the name, never the name itself, which no rule
  can make resolve. That becomes `dns-service-not-allowed` in the Blocked Hosts table. Sitting after
  the allowlist is what leaves a name someone did write a rule for reading as allowed.

  Between them, these two blocks are the only place a service name is recognised. The report reads
  the verbs they log under, so nothing in `src/core/lib/log/` or `src/core/lib/report/` has to know
  the shape, and the two cannot drift apart.

- **The CA trust mount** is built by `src/lib/sandbox/` rather than written into the sandbox. The CA
  and, where the step has one, an augmented copy of the system CA store are written into this run's
  own scratch directory and mounted over the sandbox's view of those paths in its OCI
  `config.json`, so nothing is written to the runner and `run-isolated.sh`'s teardown removes them
  with the rest of the mount namespace. Which variables get set, and when, is in
  [CA trust variables](./reference.md#ca-trust-variables).
- The `allowed_url_rules` compiler enumerates hosts rather than generalizing them
  (`a.example.com`/`b.example.com` never becomes `*.example.com`), because CoreDNS's own allow/deny
  view is generated from the same host patterns. Widening a host widens what's logged as allowed
  DNS-side, not only what matches HTTP-side.
- `make test_integration_sandbox_inspect` (see [Testing](#testing) above) ends with
  `test/integration-test-inspect-roundtrip.sh`, which runs an audit step, feeds its own generated
  `allowed_url_rules` back as `restrict`, and checks both halves: every request the audit saw still
  passes, and a path, method, host, or port it never saw is refused.

## Troubleshooting

If you encounter issues, try reproducing the problem locally to get detailed logs:

1. **Check logs:**

   ```bash
   docker compose logs proxy
   ```

2. **Run in audit mode** to understand your command's network behavior:

   ```bash
   make setup_sandbox_dev
   # or drive the action directly, see README.md
   ```

3. **The step fails with "never became ready"**: the proxy came up but one of its services never
   answered its own readiness check. The step prints the container log; locally:

   ```bash
   docker inspect --format '{{json .State.Health}}' buildcage-proxy
   ```

4. **Open an issue** at [github.com/buildcage/isolated-run/issues](https://github.com/buildcage/isolated-run/issues) with:
   - The Job Summary report (audit or restrict mode)
   - The relevant `docker compose logs proxy` output
   - Your workflow YAML (with secrets redacted)
