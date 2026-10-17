import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface ShellChoice {
  file: string;
  args: string[];
}

const DEFAULT_PATHEXT = '.EXE;.CMD;.BAT';

export function isOnPath(
  exe: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): boolean {
  const win = platform === 'win32';
  const delimiter = win ? path.win32.delimiter : path.posix.delimiter;
  const join = win ? path.win32.join : path.posix.join;
  const dirs = (env.PATH ?? '').split(delimiter);
  const exts = (env.PATHEXT ?? DEFAULT_PATHEXT).split(delimiter);

  for (const dir of dirs) {
    if (dir === '') continue;
    if (win) {
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
