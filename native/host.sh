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

# npx lives next to node in every standard layout.
find_npx() {
  local node_dir found
  node_dir="$(dirname -- "$1")"
  is_exec "${DSH_EXT_NPX:-}" && { printf '%s' "$DSH_EXT_NPX"; return 0; }
  is_exec "$node_dir/npx" && { printf '%s' "$node_dir/npx"; return 0; }
  found="$(command -v npx 2>/dev/null || true)"
  is_exec "$found" && { printf '%s' "$found"; return 0; }
  found="$(known_locations npx || true)"
  is_exec "$found" && { printf '%s' "$found"; return 0; }
  return 1
}

NODE_BIN="$(find_node || true)"
if ! is_exec "$NODE_BIN"; then
  say "could not resolve node (set DSH_EXT_NODE to an absolute path)"
  exit 1
fi
NPX_BIN="$(find_npx "$NODE_BIN" || true)"
if ! is_exec "$NPX_BIN"; then
  say "could not resolve npx next to $NODE_BIN (set DSH_EXT_NPX)"
  exit 1
fi

export DSH_EXT_NODE="$NODE_BIN"
export DSH_EXT_NPX="$NPX_BIN"
exec "$NODE_BIN" "$HERE/host.mjs" 2>>"$HOST_LOG"
