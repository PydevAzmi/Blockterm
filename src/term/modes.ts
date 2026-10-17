import type { IDisposable, Terminal } from '@xterm/headless';

export interface TrackedModes {
  mouseSgr: boolean;
  cursorVisible: boolean;
  cursorStyle: number;
}

export interface HostModes {
  appCursor: boolean;
  appKeypad: boolean;
  mouse: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  cursorStyle: number;
}

export const DEFAULT_HOST_MODES: HostModes = {
  appCursor: false,
  appKeypad: false,
  mouse: 'none',
  cursorStyle: 0,
};

const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l';

function mouseEnable(mouse: HostModes['mouse']): string {
  switch (mouse) {
    case 'x10':
    case 'vt200':
      return '\x1b[?1000h';
    case 'drag':
      return '\x1b[?1002h';
    case 'any':
      return '\x1b[?1003h';
    default:
      return '';
  }
}

export function trackModes(
  mirror: Terminal,
): { get(): TrackedModes; dispose(): void } {
  let mouseSgr = false;
  let cursorVisible = true;
  let cursorStyle = 0;

  const setMouseSgr = (params: (number | number[])[], on: boolean): void => {
    for (const param of params) {
      if (param === 1006) mouseSgr = on;
    }
  };

  const setCursorVisible = (params: (number | number[])[], on: boolean): void => {
    for (const param of params) {
      if (param === 25) cursorVisible = on;
    }
  };

  const handlers: IDisposable[] = [
    mirror.parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => {
      setMouseSgr(params, true);
      setCursorVisible(params, true);
      return false;
    }),
    mirror.parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => {
      setMouseSgr(params, false);
      setCursorVisible(params, false);
      return false;
    }),
    mirror.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, params => {
      const ps = params[0];
      cursorStyle = typeof ps === 'number' ? ps : 0;
      return false;
    }),
  ];

  return {
    get: () => ({ mouseSgr, cursorVisible, cursorStyle }),
    dispose: () => {
      for (const h of handlers) h.dispose();
    },
  };
}

// ponytail: RIS/DECSTR resets not tracked
export function hostModesFrom(mirror: Terminal, t: TrackedModes): HostModes {
  return {
    appCursor: mirror.modes.applicationCursorKeysMode,
    appKeypad: mirror.modes.applicationKeypadMode,
    mouse: mirror.modes.mouseTrackingMode,
    cursorStyle: t.cursorStyle,
  };
}

export function hostModeDiff(prev: HostModes | null, next: HostModes): string {
  let out = '';

  if (prev === null || prev.mouse !== next.mouse) {
    out += MOUSE_OFF;
    out += mouseEnable(next.mouse);
  }

  if (prev === null || prev.appCursor !== next.appCursor) {
    out += next.appCursor ? '\x1b[?1h' : '\x1b[?1l';
  }

  if (prev === null || prev.appKeypad !== next.appKeypad) {
    out += next.appKeypad ? '\x1b=' : '\x1b>';
  }

  if (prev === null || prev.cursorStyle !== next.cursorStyle) {
    out += `\x1b[${next.cursorStyle} q`;
  }

  return out;
}
