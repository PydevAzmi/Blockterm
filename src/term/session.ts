import { Buffer } from 'node:buffer';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { Unicode11Addon } from '@xterm/addon-unicode11';
import { spawn } from 'node-pty';
import xterm from '@xterm/headless';
import type { IDisposable, Terminal as XtermTerminal } from '@xterm/headless';

import type { Size } from '../layout.js';
import type { ShellChoice } from '../shell.js';

const { Terminal } = xterm;

export type View = 'blocks' | 'fullscreen';

export interface PtyLike {
  onData(cb: (d: Buffer | string) => void): IDisposable;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): IDisposable;
  write(d: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly process: string;
}

class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  event(cb: (value: T) => void): IDisposable {
    this.listeners.add(cb);
    return { dispose: () => void this.listeners.delete(cb) };
  }

  fire(value: T): void {
    for (const cb of [...this.listeners]) cb(value);
  }
}

export class TerminalSession {
  readonly mirror: XtermTerminal;

  private readonly parsed = new Emitter<void>();
  private readonly viewChanged = new Emitter<View>();
  private readonly exit = new Emitter<number>();
  private readonly disposables: IDisposable[] = [];

  constructor(
    private readonly pty: PtyLike,
    size: Size,
  ) {
    this.mirror = new Terminal({
      allowProposedApi: true,
      scrollback: 10000,
      cols: size.cols,
      rows: size.rows,
    });
    this.mirror.loadAddon(new Unicode11Addon());
    this.mirror.unicode.activeVersion = '11';

    this.disposables.push(
      this.pty.onData(d => {
        this.mirror.write(d instanceof Buffer ? new Uint8Array(d) : d, () => this.parsed.fire(undefined));
      }),
      this.pty.onExit(({ exitCode, signal }) =>
        this.exit.fire(signal ? 128 + signal : exitCode),
      ),
      this.mirror.onData(d => this.pty.write(d)),
      this.mirror.buffer.onBufferChange(() => this.viewChanged.fire(this.view)),
      // ponytail: fixed colours; probe host OSC 10/11 at startup if light themes look wrong
      this.mirror.parser.registerOscHandler(10, data => {
        if (data !== '?') return false;
        this.pty.write('\x1b]10;rgb:ffff/ffff/ffff\x07');
        return true;
      }),
      this.mirror.parser.registerOscHandler(11, data => {
        if (data !== '?') return false;
        this.pty.write('\x1b]11;rgb:0000/0000/0000\x07');
        return true;
      }),
    );
  }

  get view(): View {
    return this.mirror.buffer.active.type === 'alternate' ? 'fullscreen' : 'blocks';
  }

  get program(): string {
    return this.pty.process;
  }

  onParsed(cb: () => void): IDisposable {
    return this.parsed.event(() => cb());
  }

  onViewChange(cb: (v: View) => void): IDisposable {
    return this.viewChanged.event(cb);
  }

  onExit(cb: (code: number) => void): IDisposable {
    return this.exit.event(cb);
  }

  write(data: string | Buffer): void {
    this.pty.write(data);
  }

  resize(size: Size): void {
    this.pty.resize(size.cols, size.rows);
    this.mirror.resize(size.cols, size.rows);
  }

  kill(): void {
    this.pty.kill();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.mirror.dispose();
  }
}

export function ensureExecutable(file: string): void {
  try {
    if (existsSync(file) && (statSync(file).mode & 0o111) === 0) {
      chmodSync(file, 0o755);
    }
  } catch {
    // best effort only
  }
}

const nodeRequire = createRequire(import.meta.url);

// ponytail: self-heal for blocked install scripts; drop once packaging (slice 8) guarantees the exec bit
export function healSpawnHelper(): void {
  try {
    const root = dirname(nodeRequire.resolve('node-pty/package.json'));
    ensureExecutable(join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'));
    ensureExecutable(join(root, 'build', 'Release', 'spawn-helper'));
  } catch {
    // node-pty not resolvable; nothing to heal
  }
}

export function spawnSession(
  shell: ShellChoice,
  size: Size,
  env: Record<string, string | undefined>,
): TerminalSession {
  if (process.platform === 'darwin') healSpawnHelper();

  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) cleanEnv[key] = value;
  }

  const pty = spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.cwd(),
    env: cleanEnv,
    encoding: process.platform === 'win32' ? null : 'utf8',
  });

  return new TerminalSession(pty, size);
}
