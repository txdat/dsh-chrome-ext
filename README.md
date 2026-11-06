# DSH Web (Chrome extension)

One toolbar click launches the pinned `@deepseek-ai/dsh` web CLI and opens its
tokenized URL as a tab in the Chrome you are already using. The CLI is installed
once into `~/.local/share/dsh-chrome-ext/cli` and launched from disk after that.

## Quick start

Requires Node.js 20.11+ and a distro build of Chrome or Chromium (Flatpak and
snap builds cannot exec a host on the host system).

```sh
npm run setup          # generate the ID key (idempotent) and register the native host
npm run install-cli    # optional: pre-install the pinned CLI
npm test               # offline tests, no Chrome needed
npm run check          # Biome format + lint gate
```

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load
   unpacked** → `extension/`.
2. The extension ID shown must match the one `npm run setup` printed; the host
   manifest allows only that ID.
3. Open the toolbar popup, optionally set a workspace, port, and CLI version, then
   click **Start and open**.

The first launch installs the CLI (a few minutes); later launches reuse that tree.
Re-run `npm run setup` after moving this checkout or reinstalling a browser.

## How it works

Extensions cannot start processes, so a native-messaging host does it:

```text
popup.js ──sendNativeMessage──► native/host.sh ──► native/host.mjs
                                                      ├─ install/reuse the managed CLI
                                                      └─ dsh web --no-open --port 3080
                                                           └─ prints http://127.0.0.1:3080/?token=…
             ◄──── framed JSON { url, cleanUrl, pid, port, package, via } ────┘
   chrome.tabs.create({ url })
```

- `--no-open` makes dsh print the URL instead of handing it to the OS default
  browser; the extension owns the tab.
- The token URL is a credential: the first load exchanges it for a cookie and
  redirects to the clean URL, which returns `401` by itself.
- The host exits after replying; the dsh process is detached and keeps running.

See [AGENTS.md](AGENTS.md) for the full architecture and invariants.

## Configuration

| Setting         | Effect                                                                            |
| --------------- | --------------------------------------------------------------------------------- |
| **Workspace**   | Working directory dsh starts in; defaults to the home directory                   |
| **Port**        | Loopback port; default 3080                                                       |
| **CLI version** | Exact `@deepseek-ai/dsh` version for the next launch; blank uses the built-in pin |

Only exact versions are accepted (`0.2.2-rc.1`, not `latest` or `^0.2.0`).
Resolution order: popup setting → `DSH_EXT_DSH_VERSION` → `DEFAULT_VERSION` in
`native/cli.mjs`. A version change applies to the next launch; press **Stop**
first, because the managed tree is replaced in place.

`npm run install-cli -- <version>` installs a version from a terminal.

## Managed CLI install

The host keeps one CLI tree instead of an `npx` cache per spec string. A start
uses, in order:

1. `DSH_EXT_DSH_BIN`, if set (`via: "env"`).
2. The managed tree, if it already has the requested version (`via: "cli"`).
3. `npm install --prefix <cli dir>` with an exact dependency, under a lock, then
   run the tree (`via: "cli"`). Concurrent launches install once.
4. On install failure, `npx --yes --prefer-offline @deepseek-ai/dsh@<version>`
   (`via: "npx"`), so a broken install does not block the launcher.

Old `npx` trees under `~/.npm/_npx` are safe to delete (`rm -rf ~/.npm/_npx`);
each dsh tree there is ~900 MB.

## Protocol

One request, one response, then the host exits. Lifecycle replies carry `running`
and `starting`; errors are `{ok: false, error}`.

| Request                                                               | Effect                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `{"type":"start","workspace":"…","port":3099,"version":"0.1.7-rc.2"}` | Reuse a live server, resume an in-flight launch, or spawn one and wait for its URL                           |
| `{"type":"status"}`                                                   | `{running, port, pid, cleanUrl, package, via, logFile}`, `{starting, pid, package, …}`, or `{running:false}` |
| `{"type":"stop"}`                                                     | Stop the CLI process group and clear state                                                                   |

State is `launching` first (pid, launchId, package, via, port, log file), then
`ready` (adds `url` and `cleanUrl`). Writing `launching` before waiting for the
URL makes a launch that outlives the host resumable instead of racing
`EADDRINUSE`. `launchId` in the child's environment proves ownership, so `stop`
never signals a reused pid.

`via` says where the binary came from: `cli`, `env`, `npx`, or `override` (tests
only).

## Runtime files

| Path                                            | Contents                             |
| ----------------------------------------------- | ------------------------------------ |
| `~/.local/state/dsh-chrome-ext/state.json`      | Launch state (mode 0600)             |
| `~/.local/state/dsh-chrome-ext/host.log`        | Host diagnostics                     |
| `~/.local/state/dsh-chrome-ext/install.log`     | Host-driven install output           |
| `${TMPDIR:-/tmp}/dsh-chrome-ext/logs/dsh-*.log` | Per-launch dsh output                |
| `~/.local/share/dsh-chrome-ext/cli`             | Managed CLI tree                     |
| `native/com.txdat.dsh_web.json`                 | Generated host manifest (gitignored) |

Override the directories with `DSH_EXT_STATE_DIR`, `DSH_EXT_LOG_DIR`, and
`DSH_EXT_CLI_DIR`.

## Limits

- One dsh server per port. If 3080 is taken, start fails with dsh's
  `EADDRINUSE`; choose another port.
- The token URL is stored in extension storage, the state file, and the per-launch
  log, and is only ever sent to `127.0.0.1`.
- The managed tree is ~900 MB and holds one version. Switching versions
  reinstalls in place, so **Stop** first.
- The CLI never upgrades on its own. Change the popup version or bump
  `DEFAULT_VERSION` in `native/cli.mjs`.
- First launch is bounded by `DSH_EXT_INSTALL_TIMEOUT_MS` and readiness by
  `DSH_EXT_READY_TIMEOUT_MS` (10 minutes each by default).
- The host is a local code-execution surface. Only the pinned extension ID may
  talk to it, and `start` runs a fixed command.
- macOS and Windows host registration are not implemented; only Linux browser
  config paths are written.
- `extension/icons/*.png` are the checked-in artwork; Chrome does not accept SVG
  manifest icons.

## Development

No build step: Chrome loads `extension/` directly, and Node runs `native/` and
`scripts/` as ESM.

```sh
npm test                                                   # all suites, offline
node --test test/host.test.mjs                             # one suite
node --test --test-name-pattern='stop' test/host.test.mjs  # tests matching a name
npm run check                                              # Biome format + lint
npm run format
```

Tests never start the real CLI or touch the network. The popup's click-through
path in a real Chrome context is not automated; load the unpacked extension to
verify it manually. See [AGENTS.md](AGENTS.md) for architecture, invariants, and
testing conventions.
