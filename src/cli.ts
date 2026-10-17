#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runApp } from './app.js';
import { isOnPath, resolveShell } from './shell.js';

export type Cli =
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'run'; shell?: string }
  | { kind: 'error'; message: string };

export function parseArgs(argv: string[]): Cli {
  let shell: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--version' || arg === '-v') return { kind: 'version' };
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--shell') {
      const next = argv[i + 1];
      if (next === undefined) return { kind: 'error', message: '--shell needs a path' };
      shell = next;
      i += 1;
      continue;
    }
    return { kind: 'error', message: `unknown option: ${arg}` };
  }

  return shell === undefined ? { kind: 'run' } : { kind: 'run', shell };
}

export function isMain(argv1: string | undefined, metaUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    const entry = realpathSync(argv1);
    const self = realpathSync(fileURLToPath(metaUrl));
    return entry === self;
  } catch {
    return false;
  }
}

const HELP = [
  'usage: blockterm [--shell <path>] [--version] [--help]',
  '',
  'options:',
  '  --shell <path>  run the given shell instead of the default',
  '  --version, -v   print the version and exit',
  '  --help, -h      print this help and exit',
].join('\n');

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

function hasSize(stdout: NodeJS.WriteStream): boolean {
  return typeof stdout.columns === 'number' && typeof stdout.rows === 'number';
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.kind === 'version') {
    process.stdout.write(`${version()}\n`);
    return;
  }
  if (cli.kind === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (cli.kind === 'error') {
    process.stderr.write(`${cli.message}\n`);
    process.stderr.write('try: blockterm --help\n');
    process.exit(2);
  }

  const { stdin, stdout } = process;
  if (!stdin.isTTY || !hasSize(stdout)) {
    process.stderr.write('blockterm: needs an interactive terminal\n');
    process.exit(1);
  }

  const shell = resolveShell({
    platform: process.platform,
    env: process.env,
    override: cli.shell,
    onPath: exe => isOnPath(exe, process.env, process.platform),
  });

  try {
    const code = await runApp({ shell, stdin, stdout });
    process.exit(code);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`blockterm: cannot start shell ${shell.file}: ${message}\n`);
    process.exit(1);
  }
}

if (isMain(process.argv[1], import.meta.url)) {
  await main();
}
