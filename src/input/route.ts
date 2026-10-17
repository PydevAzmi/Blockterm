import { Buffer } from 'node:buffer';

import type { IModes } from '@xterm/headless';

import type { InputEvent, MouseInput } from './tokenize.js';
import type { Layout } from '../layout.js';
import type { TrackedModes } from '../term/modes.js';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export function encodeMouse(
  e: MouseInput,
  mode: IModes['mouseTrackingMode'],
  sgr: boolean,
  layout: Layout,
): string | Buffer | null {
  const x = e.col - layout.origin.col;
  const y = e.row - layout.origin.row;
  if (x < 0 || x >= layout.pty.cols || y < 0 || y >= layout.pty.rows) return null;

  if (mode === 'none') return null;

  const release = e.action === 'release';
  const motion = e.action === 'motion';

  if (release && mode === 'x10') return null;
  if (motion) {
    if (mode === 'drag') {
      if ((e.button & 3) === 3) return null;
    } else if (mode !== 'any') {
      return null;
    }
  }

  if (sgr) {
    return `\x1b[<${e.button};${x + 1};${y + 1}${release ? 'm' : 'M'}`;
  }

  const cb = release ? (e.button & ~3) | 3 : e.button;
  const cx = 32 + x + 1;
  const cy = 32 + y + 1;
  if (cx > 255 || cy > 255) return null;
  return Buffer.from(`\x1b[M${String.fromCharCode(32 + cb, cx, cy)}`, 'latin1');
}

export function encodePaste(text: string, bracketed: boolean): string {
  const clean = text.split(PASTE_END).join('');
  return bracketed ? `${PASTE_START}${clean}${PASTE_END}` : clean;
}

export function routeToPty(
  e: InputEvent,
  ctx: { modes: IModes; tracked: TrackedModes; layout: Layout },
): string | Buffer | null {
  switch (e.type) {
    case 'bytes':
      return e.data;
    case 'mouse':
      return encodeMouse(e, ctx.modes.mouseTrackingMode, ctx.tracked.mouseSgr, ctx.layout);
    case 'paste':
      return encodePaste(e.text, ctx.modes.bracketedPasteMode);
    case 'focus':
      if (!ctx.modes.sendFocusMode) return null;
      return e.focused ? '\x1b[I' : '\x1b[O';
    case 'agent-key':
    case 'help-key':
      return null;
  }
}
