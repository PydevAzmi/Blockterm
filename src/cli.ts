#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { runApp } from './app.js';
import { configPath, loadConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { type Io, runSetup } from './setup.js';
import { isOnPath, resolveShell, shellExists } from './shell.js';

export { shellExists };

export type Cli =
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'run'; shell?: string }
  | { kind: 'setup' }
  | { kind: 'doctor' }
  | { kind: 'error'; message: string };

export function parseArgs(argv: string[]): Cli {
  if (argv[0] === 'setup' || argv[0] === 'doctor') {
    if (argv.length > 1) return { kind: 'error', message: `unexpected argument: ${argv[1]}` };
    return argv[0] === 'setup' ? { kind: 'setup' } : { kind: 'doctor' };
  }

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
  'usage: blockterm [setup | doctor] [--shell <path>] [--version] [--help]',
  '',
  'commands:',
  '  setup           choose the model and save the config',
  '  doctor          check node, pty, shell, config, key and model',
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

export interface ReadlineIo extends Io {
  close(): void;
}

export function createIo(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): ReadlineIo {
  const rl = createInterface({ input, output });
  const buffered: string[] = [];
  let pending: ((line: string) => void) | null = null;
  let closed = false;

  rl.on('line', line => {
    if (pending !== null) {
      const resolve = pending;
      pending = null;
      resolve(line);
    } else {
      buffered.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    if (pending !== null) {
      const resolve = pending;
      pending = null;
      resolve('');
    }
  });

  return {
    ask: (question, def) => {
      rl.setPrompt(def === undefined ? `${question}: ` : `${question} [${def}]: `);
      rl.prompt();
      return new Promise<string>(resolve => {
        const finish = (line: string): void => {
          const answer = line.trim();
          resolve(answer === '' && def !== undefined ? def : answer);
        };
        const next = buffered.shift();
        if (next !== undefined) finish(next);
        else if (closed) finish('');
        else pending = finish;
      });
    },
    print: line => {
      output.write(`${line}\n`);
    },
    close: () => {
      rl.close();
    },
  };
}

async function runSetupCommand(): Promise<void> {
  const io = createIo(process.stdin, process.stdout);
  try {
    const path = process.env.BLOCKTERM_CONFIG || configPath(process.platform, process.env, homedir());
    const loaded = loadConfig(path);
    await runSetup(io, path, loaded.ok ? loaded.config : null);
  } finally {
    io.close();
  }
}

async function runDoctorCommand(): Promise<number> {
  const path = process.env.BLOCKTERM_CONFIG || configPath(process.platform, process.env, homedir());
  const loaded = loadConfig(path);
  const shell = resolveShell({
    platform: process.platform,
    env: process.env,
    override: loaded.ok ? loaded.config.shell ?? undefined : undefined,
    onPath: exe => isOnPath(exe, process.env, process.platform),
  });

  const checks = await runDoctor({
    configPath: path,
    env: process.env,
    platform: process.platform,
    shellFile: shell.file,
  });

  let failed = false;
  for (const check of checks) {
    if (!check.ok) failed = true;
    process.stdout.write(`${check.ok ? '✔' : '✘'} ${check.name} — ${check.detail}\n`);
  }
  return failed ? 1 : 0;
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
  if (cli.kind === 'setup') {
    await runSetupCommand();
    return;
  }
  if (cli.kind === 'doctor') {
    process.exit(await runDoctorCommand());
  }

  const { stdin, stdout } = process;
  if (!stdin.isTTY || !hasSize(stdout)) {
    process.stderr.write('blockterm: needs an interactive terminal\n');
    process.exit(1);
  }

  const path = process.env.BLOCKTERM_CONFIG || configPath(process.platform, process.env, homedir());
  const loaded = loadConfig(path);
  const configShell = loaded.ok ? loaded.config.shell : null;
  const shell = resolveShell({
    platform: process.platform,
    env: process.env,
    override: cli.shell ?? configShell ?? undefined,
    onPath: exe => isOnPath(exe, process.env, process.platform),
  });

  if (!shellExists(shell.file, process.env, process.platform)) {
    process.stderr.write(`blockterm: cannot start shell ${shell.file}: not found\n`);
    process.exit(1);
  }

  try {
    const code = await runApp({ shell, stdin, stdout, loadConfig: () => loaded });
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
