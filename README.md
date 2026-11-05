# DSH Web (Chrome extension)

One toolbar click starts `npx @deepseek-ai/dsh@0.2.2-rc.1 web --no-open` and opens the
resulting tokenized URL as a tab in the Chrome you are already using.

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
                                               └─ npx --yes @deepseek-ai/dsh@0.2.2-rc.1 web --no-open --port 3080
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

Open the toolbar popup, optionally set a workspace, port, and CLI version, click **Start
and open**.
First run downloads the pinned CLI (a few minutes, cached afterwards; see
[Pinned CLI version](#pinned-cli-version)). Progress and failures are in
`/tmp/dsh-chrome-ext/logs/dsh-<stamp>-<pid>.log`; host diagnostics are in
`~/.local/state/dsh-chrome-ext/host.log`.

## Layout

| Path | Role |
|---|---|
| `extension/manifest.json` | MV3 manifest; `key` pins the extension ID, `nativeMessaging` permission |
| `extension/icons/icon-{16,32,48,128}.png` | toolbar and store icons, rasterized from `deepseek.svg` (Chrome does not accept SVG manifest icons) |
| `extension/popup.js` | status / start / stop / open-tab flow |
| `extension/lib.js` | host call, storage, tabs, and the exact-version parser shared with the host |
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
| `{"type":"start","workspace":"…","port":3099,"version":"0.1.7-rc.2"}` | reuse a live entry, resume an in-flight launch, or spawn and wait for the URL line |
| `{"type":"status"}` | `{running:true, port, pid, cleanUrl, package, logFile}`, `{starting:true, pid, logFile}` or `{running:false}` |
| `{"type":"stop"}` | `SIGTERM`/`SIGKILL` the npx process group, clear state |

State has two shapes, and the second is written **before** the host waits for the URL:

- `launching` — pid, `launchId`, package spec, port, log file. A launch that outlives
  this process (slow first install, popup closed, host killed) is resumed by the next
  `start` instead of racing a second server into `EADDRINUSE`.
- `ready` — adds `url` and `cleanUrl`.

`start` carries an optional `version`. It is validated first (through the same parser the
popup uses), so `latest`, `^1.2.3`, `1.2`, or a string with extra arguments is rejected
without touching the state file or spawning anything. **A blank or absent version uses
the built-in pin.** A version only applies to a launch, so with a server already running
the host keeps it and reports the spec it is actually running as `package`.

`provable identity`: each launch gets a random `launchId` in the child's environment,
so `stop` reads `/proc/<pid>/environ` and never signals a pid that does not carry it.
A stale state file plus pid reuse therefore cannot kill an unrelated process group;
`stop` clears the entry and reports a warning instead. Off Linux the environment is
unreadable, so the open port is the fallback evidence.

Reuse is gated on the recorded pid being alive **and** its port accepting a connection,
plus that same identity check, so a crashed dsh or a foreign process on the port is not
mistaken for a running one.

## Pinned CLI version

`npx @deepseek-ai/dsh` resolves the `latest` dist-tag on **every** launch, so each time
the package is republished npx downloads the new tarball before starting the server.
The host therefore asks for an exact version (`@deepseek-ai/dsh@0.2.2-rc.1`), which hashes
to a stable npm `_npx` cache entry: first launch downloads, later launches run straight
from the cache.

**Settings → CLI version** overrides the pin for the next launch. The field is validated
(an exact version only — `latest`, `^0.2.0`, `0.2`, or anything with extra arguments is
refused with an inline error), stored in `chrome.storage.local`, and sent as `version` in
the `start` request; the value that is running is shown under **Details** as `version`.
Leave it empty to use the built-in pin, or press **Reset to defaults**. Because a running
server is never restarted implicitly, **Stop** before a version change takes effect.

Resolution order for a launch: `start.version` (popup) → `DSH_EXT_DSH_VERSION` → the
`PINNED_VERSION` constant in `native/host.mjs`. To move the default to a new release,
bump that constant (the README and the host manifest description name the same version).
Setting `DSH_EXT_PACKAGE` to an already versioned spec (`@deepseek-ai/dsh@0.1.7-rc.2`)
bypasses the pin entirely.

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
| pinned spec | npx is asked for `@deepseek-ai/dsh@<exact version>`, identical on every launch (a different spec would hash to a different cache dir and re-download) |
| version overrides | `DSH_EXT_DSH_VERSION` / `DSH_EXT_PACKAGE` win; an already versioned package is not pinned twice |
| popup version | `start.version` replaces the pin, is echoed back as `package`, and is written to state |
| invalid version | `latest`, ranges, and `0.2.2 --registry …` are rejected before any spawn; no argv, no state |
| version parser | exact versions accepted (`v` prefix dropped), blanks mean "default", ranges/tags/option-like input refused |
| unknown request | rejected |

Run by hand on this machine, `env -i PATH=/usr/bin:/bin` (no node on PATH), isolated
`DSH_HOME`:

| Check | Result |
|---|---|
| node resolution with a Chrome-like PATH | `zsh -ic` lookup found the fnm node |
| real `npx @deepseek-ai/dsh web --no-open --port 3097` | ready in ~5 s, `launchId` present through the `npx`→`npm exec` hand-off |
| token URL over plain HTTP | `303` + `Set-Cookie`; clean URL alone `401`; token reusable |
| `google-chrome --pack-extension` | packs the extension (valid manifest, loads) |
| `npx @deepseek-ai/dsh@0.2.2-rc.1 --version` twice | 56 s cold (download), 0.5 s with `npm_config_offline=true` on the second run: the pin is served from the npm cache, no network |
| popup with stubbed `chrome.*` over HTTP | running state, details pane, and the failed-start state all render as coded |
| popup with a stubbed host (Node harness) | saved version restored into the field, sent as `version`, echoed into Details, persisted; `latest` refused inline and never sent as a start |
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
  it, and `start` runs a fixed command; the only variables are workspace, port, the
  validated CLI version, and the `DSH_EXT_PACKAGE` / `DSH_EXT_DSH_VERSION` /
  `DSH_EXT_LAUNCH*` debug overrides.
- The first launch is bounded by `DSH_EXT_READY_TIMEOUT_MS` (10 min default) because a
  cold `npx` install of the CLI is slow; timing out kills the install, but the launch
  entry stays resumable until its process is gone. A pinned version also means the CLI
  never upgrades on its own: bump `PINNED_VERSION` to pick up fixes.
- `extension/icons/*.png` are derived from `deepseek.svg`; Chrome requires raster icons
  in the manifest, so re-rasterize if the artwork changes.
- **Flatpak/snap Chrome** cannot exec a host on the host system; use the distro package.
  The installer still writes flatpak paths, and that is the case they will not work in.
- macOS: host manifests go to
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`; Windows uses a
  registry value. Only the Linux paths are implemented in `scripts/install-host.mjs`.
