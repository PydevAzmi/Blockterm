import { expect, test } from 'vitest';

import { rtlMode } from '../src/rtl-mode.js';

test.each([
  [{ WT_SESSION: 'x' }, 'win32', true, 'Windows Terminal'],
  [{}, 'win32', true, 'Windows console'],
  [{ TERM_PROGRAM: 'vscode' }, 'linux', true, 'VS Code'],
  [{ TERM_PROGRAM: 'vscode' }, 'win32', true, 'VS Code'],
  [{ TERM_PROGRAM: 'iTerm.app' }, 'darwin', true, 'iTerm2'],
  [{ TERM_PROGRAM: 'WezTerm' }, 'linux', true, 'WezTerm'],
  [{ TERM_PROGRAM: 'WezTerm' }, 'win32', true, 'WezTerm'],
  [{ TERM_PROGRAM: 'alacritty' }, 'linux', true, 'Alacritty'],
  [{ TERM_PROGRAM: 'alacritty' }, 'win32', true, 'Alacritty'],
  [{ VTE_VERSION: '7200' }, 'linux', false, 'VTE does bidi'],
  [{ KONSOLE_VERSION: '230800' }, 'linux', false, 'Konsole does bidi'],
  [{ TERM_PROGRAM: 'mintty' }, 'win32', false, 'mintty does bidi'],
  [{ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin', false, 'Terminal.app does bidi'],
  [{}, 'linux', false, 'unknown terminal'],
])('auto %j on %s', (env, platform, on, reason) => {
  expect(rtlMode('auto', env, platform as NodeJS.Platform)).toEqual({ on, reason });
});

test('on and off override detection', () => {
  expect(rtlMode('on', { VTE_VERSION: '1' }, 'linux')).toEqual({ on: true, reason: 'set in config' });
  expect(rtlMode('off', { WT_SESSION: 'x' }, 'win32')).toEqual({ on: false, reason: 'set in config' });
});
