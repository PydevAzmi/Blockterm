import type { Terminal } from '@xterm/headless';

import type { Size } from '../layout.js';
import type { TerminalSession, View } from '../term/session.js';

export interface ScreenInfo {
  text: string;
  cursor: { row: number; col: number };
  view: View;
  buffer: 'normal' | 'alternate';
  program: string;
  size: Size;
}

export function readScreen(
  session: Pick<TerminalSession, 'mirror' | 'view' | 'program'>,
): ScreenInfo {
  const { mirror } = session;
  const buffer = mirror.buffer.active;
  const viewportY = buffer.viewportY;

  const rows: string[] = [];
  for (let y = 0; y < mirror.rows; y++) {
    const line = buffer.getLine(viewportY + y);
    rows.push(line ? line.translateToString(true) : '');
  }
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();

  return {
    text: rows.join('\n'),
    cursor: { row: buffer.cursorY, col: buffer.cursorX },
    view: session.view,
    buffer: buffer.type,
    program: session.program,
    size: { cols: mirror.cols, rows: mirror.rows },
  };
}

export function readScrollback(mirror: Terminal, lines: number): string {
  const count = Math.min(500, Math.max(0, lines));
  const buffer = mirror.buffer.active;
  const start = Math.max(0, buffer.length - count);

  const out: string[] = [];
  for (let y = start; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    out.push(line ? line.translateToString(true) : '');
  }
  return out.join('\n');
}

export function waitForQuiet(
  session: Pick<TerminalSession, 'onParsed'>,
  maxMs: number,
  quietMs = 400,
  signal?: AbortSignal,
): Promise<void> {
  const cap = Math.min(maxMs, 15000);

  return new Promise<void>(resolve => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let max: ReturnType<typeof setTimeout> | undefined;
    let sub: { dispose(): void } | undefined;
    let onAbort: (() => void) | undefined;

    const done = (): void => {
      if (quiet !== undefined) clearTimeout(quiet);
      if (max !== undefined) clearTimeout(max);
      sub?.dispose();
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      resolve();
    };

    if (signal?.aborted) {
      resolve();
      return;
    }

    sub = session.onParsed(() => {
      if (quiet !== undefined) clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    });

    quiet = setTimeout(done, quietMs);
    max = setTimeout(done, cap);

    if (signal !== undefined) {
      onAbort = done;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
