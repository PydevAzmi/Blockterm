export type RtlSetting = 'auto' | 'on' | 'off';

export interface RtlMode {
  on: boolean;
  reason: string;
}

function has(env: Record<string, string | undefined>, name: string): boolean {
  const value = env[name];
  return value !== undefined && value !== '';
}

/**
 * Decides whether blockterm should shape and reorder Arabic itself.
 * `auto` turns it on only for hosts known to do no bidi of their own.
 */
export function rtlMode(
  setting: RtlSetting | undefined,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): RtlMode {
  if (setting === 'on' || setting === 'off') {
    return { on: setting === 'on', reason: 'set in config' };
  }

  if (has(env, 'VTE_VERSION')) return { on: false, reason: 'VTE does bidi' };
  if (has(env, 'KONSOLE_VERSION')) return { on: false, reason: 'Konsole does bidi' };
  if (env.TERM_PROGRAM === 'mintty') return { on: false, reason: 'mintty does bidi' };
  if (env.TERM_PROGRAM === 'Apple_Terminal') return { on: false, reason: 'Terminal.app does bidi' };

  if (has(env, 'WT_SESSION')) return { on: true, reason: 'Windows Terminal' };
  if (platform === 'win32') return { on: true, reason: 'Windows console' };
  if (env.TERM_PROGRAM === 'vscode') return { on: true, reason: 'VS Code' };
  if (env.TERM_PROGRAM === 'iTerm.app') return { on: true, reason: 'iTerm2' };
  if (env.TERM_PROGRAM === 'WezTerm') return { on: true, reason: 'WezTerm' };
  if (env.TERM_PROGRAM === 'alacritty') return { on: true, reason: 'Alacritty' };

  return { on: false, reason: 'unknown terminal' };
}
