#!/usr/bin/env bash
# Chrome native-messaging launcher for the dsh web extension.
#
# Chrome starts native hosts with an environment that usually lacks a
# version-manager PATH (fnm/nvm/asdf), so node is resolved explicitly:
#   $DSH_EXT_NODE  ->  PATH  ->  login shell lookup
# FD 0/1 must stay raw (native messaging framing). All diagnostics go to the
# log file, never to stdout.
set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${DSH_EXT_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/dsh-chrome-ext}"
mkdir -p "$STATE_DIR" 2>/dev/null || true
HOST_LOG="$STATE_DIR/host.log"
export DSH_EXT_STATE_DIR="$STATE_DIR"

say() { printf '%s [host.sh] %s\n' "$(date -Is)" "$*" >>"$HOST_LOG" 2>/dev/null; }

is_exec() { [ -n "${1:-}" ] && [ -x "$1" ]; }

# Version managers usually inject PATH from an interactive rc file, not a login
# profile, so try both; every candidate's stderr is discarded.
shell_lookup() {
  local shell variant found
  for shell in "${SHELL:-}" /bin/zsh /bin/bash /usr/bin/zsh /usr/bin/bash; do
    [ -n "$shell" ] && [ -x "$shell" ] || continue
    for variant in -lc -ic; do
      found="$("$shell" "$variant" "command -v $1" 2>/dev/null </dev/null | tail -n1 | tr -d '\r')"
      if is_exec "$found"; then printf '%s' "$found"; return 0; fi
    done
  done
  return 1
}

# Last resort: the directories version managers install into.
known_locations() {
  local candidate
  for candidate in \
    "$HOME/.local/share/fnm/aliases/default/bin/$1" \
    "$HOME/.asdf/shims/$1" \
    "$HOME/.volta/bin/$1" \
    "$HOME/n/bin/$1" \
    "/usr/local/bin/$1" \
    "/usr/bin/$1"; do
    if is_exec "$candidate"; then printf '%s' "$candidate"; return 0; fi
  done
  # highest installed nvm node
  candidate="$(ls -d "$HOME"/.nvm/versions/node/*/bin/"$1" 2>/dev/null | sort -V | tail -n1)"
  if is_exec "$candidate"; then printf '%s' "$candidate"; return 0; fi
  return 1
}

find_node() {
  local found
  is_exec "${DSH_EXT_NODE:-}" && { printf '%s' "$DSH_EXT_NODE"; return 0; }
  found="$(command -v node 2>/dev/null || true)"
  is_exec "$found" && { printf '%s' "$found"; return 0; }
  found="$(shell_lookup node || true)"
  is_exec "$found" && { printf '%s' "$found"; return 0; }
  found="$(known_locations node || true)"
  is_exec "$found" && { printf '%s' "$found"; return 0; }
  return 1
}

# npm and npx live next to node in every standard layout. npm installs and
# updates the managed CLI; npx is only the fallback, so either one is enough.
find_tool() {
  local name="$1" node_dir="$2" var found
  var="DSH_EXT_$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
  found="${!var:-}"
  is_exec "$found" && { printf '%s' "$found"; return 0; }
  is_exec "$node_dir/$name" && { printf '%s' "$node_dir/$name"; return 0; }
  found="$(command -v "$name" 2>/dev/null || true)"
  is_exec "$found" && { printf '%s' "$found"; return 0; }
  found="$(known_locations "$name" || true)"
  is_exec "$found" && { printf '%s' "$found"; return 0; }
  return 1
}

NODE_BIN="$(find_node || true)"
if ! is_exec "$NODE_BIN"; then
  say "could not resolve node (set DSH_EXT_NODE to an absolute path)"
  exit 1
fi

NODE_DIR="$(dirname -- "$NODE_BIN")"
NPM_BIN="$(find_tool npm "$NODE_DIR" || true)"
NPX_BIN="$(find_tool npx "$NODE_DIR" || true)"
if ! is_exec "$NPM_BIN" && ! is_exec "$NPX_BIN" && ! is_exec "${DSH_EXT_DSH_BIN:-}"; then
  say "could not resolve npm or npx next to $NODE_BIN (set DSH_EXT_NPM, DSH_EXT_NPX or DSH_EXT_DSH_BIN)"
  exit 1
fi

export DSH_EXT_NODE="$NODE_BIN"
is_exec "$NPM_BIN" && export DSH_EXT_NPM="$NPM_BIN"
is_exec "$NPX_BIN" && export DSH_EXT_NPX="$NPX_BIN"
exec "$NODE_BIN" "$HERE/host.mjs" 2>>"$HOST_LOG"
