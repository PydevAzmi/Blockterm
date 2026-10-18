import type { IDisposable } from '@xterm/headless';

import type { PtyLike } from '../../src/term/session.js';

export class FakePty implements PtyLike {
  readonly process = 'fake-shell';
  readonly written: (string | Buffer)[] = [];
  readonly resizes: [number, number][] = [];
  killed = false;

  private readonly dataListeners = new Set<(d: Buffer | string) => void>();
  private readonly exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();

  onData(cb: (d: Buffer | string) => void): IDisposable {
    this.dataListeners.add(cb);
    return { dispose: () => void this.dataListeners.delete(cb) };
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): IDisposable {
    this.exitListeners.add(cb);
    return { dispose: () => void this.exitListeners.delete(cb) };
  }

  write(d: string | Buffer): void {
    this.written.push(d);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }

  kill(): void {
    this.killed = true;
  }

  emit(d: Buffer | string): void {
    for (const cb of [...this.dataListeners]) cb(d);
  }

  exit(code: number, signal?: number): void {
    for (const cb of [...this.exitListeners]) cb({ exitCode: code, signal });
  }
}
