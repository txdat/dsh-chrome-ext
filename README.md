# DSH Web (Chrome extension)

One toolbar click starts `npx @deepseek-ai/dsh web --no-open` and opens the resulting
tokenized URL as a tab in the Chrome you are already using.

## Why there is a native host

A Chrome extension cannot start a process. MV3 has no `child_process`, no shell, and
`chrome.runtime.connectNative` is the only supported way out of the sandbox. So the
work splits in two:

```
toolbar click
   │
   └─ popup.js  ──sendNativeMessage──►  native/host.sh
                                          │ resolves node (PATH → login shell → known dirs)
                                          └─ node native/host.mjs
                                               └─ npx --yes @deepseek-ai/dsh web --no-open --port 3080
                                                    │ stdout → /tmp/dsh-chrome-ext/logs/*.log
                                                    └─ "dsh web: http://127.0.0.1:3080/?token=…"
                        ◄── framed JSON { ok, url, cleanUrl, pid, port } ──┘
   └─ chrome.tabs.create({ url })   ← the "current Chrome" part
```

Two consequences worth knowing before you change anything:

- `--no-open` matters. Without it dsh hands the URL to the OS default browser, which
  may not be this Chrome. With it, dsh only prints the line and the extension owns the
  tab.
- The printed URL carries a **process token**. The first load exchanges it for a signed
  cookie and redirects to the clean URL; the clean URL alone returns `401`. The host
  therefore stores both and reuses the token URL only until it has been opened once
  (verified below).

## Install

```sh
npm run setup          # register the native host (gen-key is a no-op when a key is pinned)
npm test               # offline protocol/lifecycle tests, no Chrome needed
```

Then in Chrome: `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
select `extension/`. The ID shown must equal the one `npm run setup` printed
(`chrome-extension://…/`); the host manifest allows only that ID.

Open the toolbar popup, optionally set a workspace and port, click **Start and open**.
First run downloads the CLI (a few minutes, cached afterwards). Progress and failures
are in `/tmp/dsh-chrome-ext/logs/dsh-<stamp>-<pid>.log`; host diagnostics are in
`~/.local/state/dsh-chrome-ext/host.log`.

## Layout

| Path | Role |
|---|---|
| `extension/manifest.json` | MV3 manifest; `key` pins the extension ID, `nativeMessaging` permission |
| `extension/icons/icon-{16,32,48,128}.png` | toolbar and store icons, rasterized from `deepseek.svg` (Chrome does not accept SVG manifest icons) |
| `extension/popup.js` | status / start / stop / open-tab flow |
| `extension/background.js` | badge sync only (the popup owns the lifecycle) |
| `native/host.sh` | the executable Chrome launches; resolves `node` and `npx` |
| `native/host.mjs` | native-messaging protocol, process supervision, state file |
| `scripts/gen-key.mjs` | generates the pinning key (`--write` stores it, `--force` rotates) |
| `scripts/install-host.mjs` | writes the host manifest into every browser config dir |
| `scripts/id.mjs` | extension ID = first 16 bytes of SHA-256 over the DER key, nibbles → `a`-`p` |
| `test/host.test.mjs` | native host protocol and lifecycle, driven by a stub launcher |

State and host diagnostics live outside the repo in `~/.local/state/dsh-chrome-ext/`
(`state.json` mode 0600, `host.log`). The dsh console output of each launch goes to
`$TMPDIR/dsh-chrome-ext/logs` (`/tmp/…` by default), so it survives a host restart but
not a reboot; override that dir with `DSH_EXT_LOG_DIR`.

## Protocol

One request, one response, then the host exits; the spawned dsh is detached and keeps
running. Replies always carry `running` and `starting` booleans.

| Request | Effect |
|---|---|
| `{"type":"start","workspace":"…","port":3099}` | reuse a live entry, resume an in-flight launch, or spawn and wait for the URL line |
| `{"type":"status"}` | `{running:true, port, pid, cleanUrl, logFile}`, `{starting:true, pid, logFile}` or `{running:false}` |
| `{"type":"stop"}` | `SIGTERM`/`SIGKILL` the npx process group, clear state |

State has two shapes, and the second is written **before** the host waits for the URL:

- `launching` — pid, `launchId`, port, log file. A launch that outlives this process
  (slow first install, popup closed, host killed) is resumed by the next `start`
  instead of racing a second server into `EADDRINUSE`.
- `ready` — adds `url` and `cleanUrl`.

`provable identity`: each launch gets a random `launchId` in the child's environment,
so `stop` reads `/proc/<pid>/environ` and never signals a pid that does not carry it.
A stale state file plus pid reuse therefore cannot kill an unrelated process group;
`stop` clears the entry and reports a warning instead. Off Linux the environment is
unreadable, so the open port is the fallback evidence.

Reuse is gated on the recorded pid being alive **and** its port accepting a connection,
plus that same identity check, so a crashed dsh or a foreign process on the port is not
mistaken for a running one.

## Resolution of `node` and `npx`

Chrome starts hosts with the desktop session environment, which usually lacks fnm/nvm/
asdf PATH entries. `native/host.sh` tries, in order:

1. `$DSH_EXT_NODE` / `$DSH_EXT_NPX` (override)
2. `command -v`
3. `zsh`/`bash` with `-lc`, then `-ic` (version managers often init in an interactive rc)
4. `~/.local/share/fnm/aliases/default/bin`, `~/.nvm/versions/node/*/bin` (highest),
   `~/.asdf/shims`, `~/.volta/bin`, `~/n/bin`, `/usr/local/bin`, `/usr/bin`

`npx` is taken from node's own directory, so a shim on PATH cannot shadow it. The npx
child gets `dirname(node)` prepended to `PATH` so the `npx` shebang resolves.

## Verified

`npm test` covers the host contract without Chrome, network, or a dsh install: it points
`DSH_EXT_LAUNCH` at a stub launcher that prints the readiness line on an ephemeral port.

| Test | Asserts |
|---|---|
| start with stdin left open | reply does not wait for EOF; URL, clean URL, and port parsed |
| shell wrapper | `host.sh` resolves node/npx and speaks the same protocol |
| second start | reuses the live pid, writes no second log |
| stop | process group gone, state cleared |
| host killed mid-launch | state stays `launching`, `status` reports `starting`, next `start` resumes the same pid |
| stop with a foreign pid | refuses, warns, the pid survives, stale state cleared |
| launcher exits without a URL | `ok:false` with the `EADDRINUSE` output attached |
| unknown request | rejected |

Run by hand on this machine, `env -i PATH=/usr/bin:/bin` (no node on PATH), isolated
`DSH_HOME`:

| Check | Result |
|---|---|
| node resolution with a Chrome-like PATH | `zsh -ic` lookup found the fnm node |
| real `npx @deepseek-ai/dsh web --no-open --port 3097` | ready in ~5 s, `launchId` present through the `npx`→`npm exec` hand-off |
| token URL over plain HTTP | `303` + `Set-Cookie`; clean URL alone `401`; token reusable |
| `google-chrome --pack-extension` | packs the extension (valid manifest, loads) |
| popup with stubbed `chrome.*` over HTTP | running state, details pane, and the failed-start state all render as coded |
| port 3080 already in use | `ok:false` with the real `EADDRINUSE` startup report |

Not verified here: clicking through the popup inside a real Chrome extension context
(the host registration is written and the ID is pinned, but that last step needs a human
in the browser). Chrome 156 ignores `--load-extension`, so it cannot be driven headlessly.
macOS and Windows host registration are not implemented.

## Limits and caveats

- Two dsh servers cannot share a port. If something already listens on 3080 (for example
  a dsh started from a terminal), the start fails with dsh's own `EADDRINUSE` report.
  Pick another port in the popup.
- The token URL is a credential. It is stored in extension storage, the state file, and
  the per-launch dsh log (both files mode 0600, the log in a shared `/tmp`); it is never
  sent anywhere except `127.0.0.1`.
- The host is a local code-execution surface. Only the pinned extension ID may talk to
  it, and `start` runs a fixed command; the only variables are workspace, port, and the
  `DSH_EXT_PACKAGE` / `DSH_EXT_LAUNCH*` debug overrides.
- The first launch is bounded by `DSH_EXT_READY_TIMEOUT_MS` (10 min default) because a
  cold `npx` install of the CLI is slow; timing out kills the install, but the launch
  entry stays resumable until its process is gone.
- `extension/icons/*.png` are derived from `deepseek.svg`; Chrome requires raster icons
  in the manifest, so re-rasterize if the artwork changes.
- **Flatpak/snap Chrome** cannot exec a host on the host system; use the distro package.
  The installer still writes flatpak paths, and that is the case they will not work in.
- macOS: host manifests go to
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`; Windows uses a
  registry value. Only the Linux paths are implemented in `scripts/install-host.mjs`.
