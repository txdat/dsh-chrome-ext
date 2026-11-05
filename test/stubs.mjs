/**
 * Filesystem fixtures shared by the native-host and CLI tests.
 *
 * Nothing here touches the network: an installed tree is faked, and `npm` is a
 * shell stub that either materialises such a tree or fails on purpose.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function writeExecutable(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

/** Bin script that records its argv, then runs the launcher stub named by $FAKE_LAUNCHER. */
function binScript(argvFile) {
  return [
    '#!/bin/sh',
    `for a in "$@"; do printf '%s\\n' "$a"; done >"${argvFile}"`,
    'exec "$FAKE_NODE" "$FAKE_LAUNCHER"',
    '',
  ].join('\n');
}

/** A pre-installed dsh tree, as `npm install --prefix` would leave it. */
export function fakeTree(dir, version, { name = '@deepseek-ai/dsh', bin = 'dsh' } = {}) {
  const pkgDir = path.join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), `${JSON.stringify({ name, version })}\n`);
  const argvFile = path.join(dir, 'bin-argv.txt');
  const binPath = writeExecutable(path.join(dir, 'node_modules', '.bin', bin), binScript(argvFile));
  return { dir, argvFile, binPath };
}

/**
 * An `npm` stub. It records its argv to $FAKE_INSTALL_ARGV, then installs the
 * version named in `<prefix>/package.json` (or fails when $FAKE_INSTALL_FAIL=1),
 * exactly like a real install would leave the tree.
 */
export function stubInstaller(dir, { fail = false, delayMs = 0 } = {}) {
  const file = path.join(dir, 'npm');
  const body = [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" >"$FAKE_INSTALL_ARGV"',
    ...(delayMs ? [`sleep ${(delayMs / 1000).toFixed(1)}`] : []),
    ...(fail ? ['echo "npm error simulated failure" >&2', 'exit 1'] : []),
    'prefix=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--prefix" ]; then prefix="$arg"; fi',
    '  prev="$arg"',
    'done',
    'version="$(node -p "require(\'$prefix/package.json\').dependencies[\'@deepseek-ai/dsh\']")" || exit 1',
    'mkdir -p "$prefix/node_modules/@deepseek-ai/dsh" "$prefix/node_modules/.bin" || exit 1',
    'printf \'{"name":"@deepseek-ai/dsh","version":"%s"}\\n\' "$version" >"$prefix/node_modules/@deepseek-ai/dsh/package.json"',
    `printf '#!/bin/sh\\nfor a in "$@"; do printf "%%s\\\\n" "$a"; done >"$FAKE_ARGV"\\nexec "$FAKE_NODE" "$FAKE_LAUNCHER"\\n' >"$prefix/node_modules/.bin/dsh"`,
    'chmod +x "$prefix/node_modules/.bin/dsh"',
    '',
  ].join('\n');
  return { file: writeExecutable(file, body), argvFileEnv: 'FAKE_INSTALL_ARGV' };
}
