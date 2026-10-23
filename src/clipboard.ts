import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface NativeTool {
  cmd: string;
  args: string[];
  encoding: 'utf8' | 'utf16le';
}

export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

export function nativeTool(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  has: (cmd: string) => boolean,
): NativeTool | null {
  if (platform === 'win32') {
    return has('clip') ? { cmd: 'clip', args: [], encoding: 'utf16le' } : null;
  }
  if (platform === 'darwin') {
    return has('pbcopy') ? { cmd: 'pbcopy', args: [], encoding: 'utf8' } : null;
  }
  if (platform === 'linux') {
    if ((env.WAYLAND_DISPLAY ?? '') !== '' && has('wl-copy')) {
      return { cmd: 'wl-copy', args: [], encoding: 'utf8' };
    }
    if (has('xclip')) {
      return { cmd: 'xclip', args: ['-selection', 'clipboard'], encoding: 'utf8' };
    }
  }
  return null;
}

function hasCommand(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  cmd: string,
): boolean {
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(delimiter);
  const names = [cmd];

  if (platform === 'win32') {
    const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map(ext => ext.trim())
      .filter(ext => ext !== '');
    for (const ext of exts) names.push(`${cmd}${ext}`);
  }

  return dirs.some(raw => {
    const dir = raw.replace(/^"(.*)"$/, '$1');
    if (dir === '') return false;
    return names.some(name => existsSync(join(dir, name)));
  });
}

export function copyText(
  text: string,
  o: {
    writeHost: (s: string) => void;
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    spawn?: typeof import('node:child_process').spawn;
    has?: (cmd: string) => boolean;
  },
): void {
  o.writeHost(osc52(text));

  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const tool = nativeTool(
    platform,
    env,
    o.has ?? (cmd => hasCommand(platform, env, cmd)),
  );
  if (tool === null) return;

  const spawn = o.spawn ?? nodeSpawn;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(tool.cmd, tool.args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return;
  }

  child.on('error', () => {});
  const stdin = child.stdin;
  if (stdin === null || stdin === undefined) return;
  stdin.on('error', () => {});

  const payload =
    tool.encoding === 'utf16le'
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
      : Buffer.from(text, 'utf8');
  try {
    stdin.end(payload);
  } catch {
    return;
  }
}
