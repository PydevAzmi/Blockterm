import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface ShellChoice {
  file: string;
  args: string[];
}

const DEFAULT_PATHEXT = '.EXE;.CMD;.BAT';

function lookupEnv(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name];
  const target = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === target) return env[key];
  }
  return undefined;
}

export function isOnPath(
  exe: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): boolean {
  const win = platform === 'win32';
  const delimiter = win ? path.win32.delimiter : path.posix.delimiter;
  const join = win ? path.win32.join : path.posix.join;
  const dirs = (lookupEnv(env, 'PATH', platform) ?? '').split(delimiter);
  const exts = (lookupEnv(env, 'PATHEXT', platform) ?? DEFAULT_PATHEXT).split(delimiter);

  for (const dir of dirs) {
    if (dir === '') continue;
    if (win) {
      if (existsSync(join(dir, exe))) return true;
      for (const ext of exts) {
        if (existsSync(join(dir, exe + ext))) return true;
      }
    } else if (existsSync(join(dir, exe))) {
      return true;
    }
  }
  return false;
}

export function resolveShell(o: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  override?: string;
  onPath: (exe: string) => boolean;
}): ShellChoice {
  if (o.override) return { file: o.override, args: [] };

  if (o.platform === 'win32') {
    return o.onPath('pwsh')
      ? { file: 'pwsh.exe', args: ['-NoLogo'] }
      : { file: 'powershell.exe', args: ['-NoLogo'] };
  }

  return { file: o.env.SHELL || '/bin/sh', args: [] };
}
