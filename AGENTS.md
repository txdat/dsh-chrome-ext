# AGENTS.md

Guidance for AI coding agents working in this repository. The README is the
user-facing description and carries the rationale, measurements, and manual
verification log; this file covers commands, the cross-file architecture, and
the contracts that are easy to break.

## What this is

A Chrome MV3 extension plus a native-messaging host. One toolbar click:

1. `extension/popup.js` asks the host (`com.txdat.dsh_web`) for `status`, then `start`.
2. `native/host.sh` resolves Node (Chrome starts hosts without version-manager PATH entries) and execs `native/host.mjs`.
3. `host.mjs` installs or reuses the pinned `@deepseek-ai/dsh` CLI in `~/.local/share/dsh-chrome-ext/cli`, spawns `dsh web --no-open --port <port>` detached, and watches its log for the `dsh web: <url>` readiness line.
4. The popup opens the tokenized URL as a tab in the current Chrome window.

There is no build step and no bundler: Chrome loads `extension/` as-is, and Node
runs `native/` and `scripts/` as ESM. There are no runtime dependencies; Biome is
the formatter and linter.

## Commands

Run from the repository root.

```sh
npm test                                                   # all suites; offline, no Chrome
node --test test/host.test.mjs                             # one suite
node --test --test-name-pattern='stop' test/host.test.mjs  # tests whose name matches
npm run check                                              # Biome format + lint gate
npm run format                                             # apply formatting
npm run lint
npm run setup                                              # gen-key (idempotent) + install-host
npm run install-cli                                        # pre-install the pinned CLI
npm run install-cli -- 0.2.2-rc.1                          # switch the managed CLI version
npm run rotate-key                                         # rotate the extension-ID key
```

There is no compile or dev-server step. After changing anything under
`extension/`, reload the unpacked extension from `chrome://extensions`. After
changing `native/` or `scripts/`, only the next host invocation is needed
(Chrome starts a fresh host per request).

Node.js 20.11+ is required (`import.meta.dirname`, built-in `node:test`).

## Architecture

| Layer                      | Responsibility                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/popup.js`       | Owns the lifecycle: status → start/stop → open tab. Persists `state` and the `version` setting in `chrome.storage.local`.               |
| `extension/lib.js`         | Host RPC, storage/tab helpers, and `parseVersion`. Imported by the popup **and** `native/host.mjs`; keep it browser-safe and Node-safe. |
| `extension/background.js`  | Badge sync (`ON`, red at peak, green off-peak) and the peak-boundary alarm. The popup, not the service worker, owns the lifecycle.      |
| `extension/peak.js`        | DeepSeek peak windows: 01:00-04:00 and 06:00-10:00 UTC on weekdays. `isPeak`, the next flip the badge alarm schedules, and popup copy.  |
| `extension/manifest.json`  | MV3 manifest. Its `key` pins the extension ID that the native host manifest must allow.                                                 |
| `native/host.sh`           | The executable Chrome launches. Resolves node/npm/npx, then `exec`s `host.mjs`.                                                         |
| `native/host.mjs`          | Framed protocol, launch/resume/reuse/stop state machine, process ownership, state file.                                                 |
| `native/cli.mjs`           | Managed install: one CLI tree, in-place version switch, install lock, npx fallback. `DEFAULT_VERSION` lives here.                       |
| `scripts/install-host.mjs` | Writes the host manifest into every browser config dir, allowing only the pinned extension ID.                                          |
| `scripts/gen-key.mjs`      | Generates the pinning key. Idempotent by design; `--force` rotates the ID.                                                              |
| `scripts/id.mjs`           | Extension ID = first 16 SHA-256 bytes of the DER key, nibbles mapped to `a`–`p`.                                                        |
| `scripts/install-cli.mjs`  | Terminal path to the same managed install the host performs.                                                                            |

### Native messaging contract

`host.mjs` speaks Chrome's native-messaging framing: a 4-byte little-endian
length followed by UTF-8 JSON, in both directions. The extension calls
`chrome.runtime.sendNativeMessage`, so the host handles **one** request, writes
**one** reply, and exits. The spawned dsh process is detached and outlives it.

State is shared across host runs through
`~/.local/state/dsh-chrome-ext/state.json` (mode 0600), with two shapes:

- `launching` — written as soon as the child exists, before waiting for the URL.
- `ready` — adds `url` and `cleanUrl`.

A later `start` reuses a live `ready` entry, or resumes a `launching` entry, so a
slow install or a popup that closed mid-launch does not race a second server into
`EADDRINUSE`.

### Runtime paths (not in the repo)

| Path                                            | Contents                                           |
| ----------------------------------------------- | -------------------------------------------------- |
| `~/.local/state/dsh-chrome-ext/state.json`      | Launch state, mode 0600                            |
| `~/.local/state/dsh-chrome-ext/host.log`        | Host and `host.sh` diagnostics                     |
| `~/.local/state/dsh-chrome-ext/install.log`     | Managed install output from the host               |
| `${TMPDIR:-/tmp}/dsh-chrome-ext/logs/dsh-*.log` | Per-launch dsh output, mode 0600                   |
| `~/.local/share/dsh-chrome-ext/cli`             | The one managed CLI tree (`node_modules/.bin/dsh`) |
| `~/.local/share/dsh-chrome-ext/cli.lock`        | Install lock (host pid, installer pid, timestamp)  |
| `native/com.txdat.dsh_web.json`                 | Generated host manifest; gitignored, do not commit |

## Invariants

- **stdout is protocol only.** `host.mjs` must never write unframed data to
  stdout; diagnostics go to `host.log`. `host.sh` must likewise stay silent on
  stdout.
- **`--no-open` is mandatory.** Without it dsh hands the URL to the OS default
  browser; the extension must own the tab.
- **The token URL is a credential.** Loading it exchanges the process token for a
  cookie and redirects to the clean URL; the clean URL alone returns `401`. The
  popup opens the token URL first and then prefers `cleanUrl` (`tokenConsumed` is
  stored in extension state). Do not log the URL anywhere new.
- **Versions must be exact.** `parseVersion` accepts `1.2.3`, prerelease/build
  suffixes, and a leading `v`; blank means "use the built-in pin". Tags, ranges,
  and anything with extra arguments are rejected. Validate before touching the
  state file or spawning, in both the popup and the host.
- **A running server is never restarted implicitly.** A version change applies to
  the next launch; the user must press **Stop** first.
- **Launch ownership is provable.** Every launch gets a random `launchId` in the
  child's environment; on Linux `stop` checks `/proc/<pid>/environ` before
  signalling the process group. Never weaken this to a bare pid check — a stale
  state file plus pid reuse would kill an unrelated process.
- **Launches must stay resumable.** Spawn detached and unref the child, write the
  `launching` state before waiting, and keep the per-launch log fd. Chrome can
  kill the host when the popup closes.
- **One managed tree, replaced in place.** Install with an exact dependency and
  `--prefix <cli dir>`. The lock records the **installer** pid as well as the
  host pid so a waiter keeps waiting after Chrome kills the host; a client removes
  the lock only if it still holds it. Install failure falls back to
  `npx --yes --prefer-offline @deepseek-ai/dsh@<version>`.
- **`extension/` is browser-only.** No `node:` imports and no bundler; keep
  relative ESM imports. `lib.js` is also imported by Node, so it may only touch
  `chrome.*` inside function bodies.
- **The manifest `key` pins the extension ID.** Rotating it changes the ID and
  invalidates every registered host manifest; `gen-key` is idempotent for that
  reason. `install-host` re-runs after a key change.
- **`native/host.sh` must remain executable in git** (Chrome execs the path
  directly) and must not print to stdout.
- **Formatting is enforced.** Biome: 2-space indent, 120 columns, single quotes,
  semicolons, trailing commas. Run `npm run format` before committing.

## Testing conventions

- `test/host.test.mjs` spawns the real host and speaks the framed protocol. It
  never starts the real CLI or touches the network: `DSH_EXT_LAUNCH` points at an
  in-test stub launcher, and state/log/CLI dirs point into a temp directory.
- `test/cli.test.mjs` exercises `resolveCli` with a fake `npm` created by
  `test/stubs.mjs`; the stub either materialises the tree or fails on purpose.
- `test/popup.test.mjs` installs a fake `document` and `chrome.*` and imports
  `popup.js` fresh per test (cache-busted URL), driven by a reply table.
- `test/lib.test.mjs` covers the shared version parser.
- When you change a request/response field, a state-file shape, or the set of
  covered behaviors, update `test/host.test.mjs` and the README **Protocol** /
  **Verified** sections together.

## Environment overrides

Useful for tests and debugging; the README documents the user-facing ones.

| Variable                                                    | Effect                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `DSH_EXT_NODE` / `DSH_EXT_NPM` / `DSH_EXT_NPX`              | Skip `host.sh`'s lookup                                             |
| `DSH_EXT_DSH_BIN`                                           | Run this binary directly (`via: "env"`), no managed install         |
| `DSH_EXT_PACKAGE`                                           | Alternate package; always takes the npx path                        |
| `DSH_EXT_DSH_VERSION`                                       | Override the built-in pin                                           |
| `DSH_EXT_CLI_DIR` / `DSH_EXT_STATE_DIR` / `DSH_EXT_LOG_DIR` | Relocate the managed tree, state/logs, and launch logs              |
| `DSH_EXT_INSTALL_TIMEOUT_MS` / `DSH_EXT_READY_TIMEOUT_MS`   | Install / readiness budgets (default 10 min each)                   |
| `DSH_EXT_LAUNCH` + `DSH_EXT_LAUNCH_ARGS`                    | Test/debug launcher override (`via: "override"`); skips the install |

## See also

- `README.md` — design rationale, protocol table, manual verification log, limits.
- `biome.json` — formatter and linter configuration.
