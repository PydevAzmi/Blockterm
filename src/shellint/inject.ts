import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShellChoice } from '../shell.js';
import { BASH_INTEGRATION, PWSH_INTEGRATION, ZSH_INTEGRATION } from './scripts.js';

export type ShellKind = 'bash' | 'zsh' | 'pwsh' | 'powershell' | 'other';

export function shellKind(file: string): ShellKind {
  const base = file
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '');
  switch (base) {
    case 'bash':
      return 'bash';
    case 'zsh':
      return 'zsh';
    case 'pwsh':
      return 'pwsh';
    case 'powershell':
    case 'powershell_ise':
      return 'powershell';
    default:
      return 'other';
  }
}

export interface Injection {
  file: string;
  args: string[];
  env: Record<string, string>;
  cleanup(): void;
}

const BASH_RC_PREFIX = 'if [ -r ~/.bashrc ]; then . ~/.bashrc; fi\n';

function zshRcPrefix(): string {
  return [
    'if [ -n "${BLOCKTERM_ORIG_ZDOTDIR-}" ]; then',
    '  ZDOTDIR="$BLOCKTERM_ORIG_ZDOTDIR"',
    'else',
    '  unset ZDOTDIR',
    'fi',
    '[ -f "${ZDOTDIR:-$HOME}/.zshrc" ] && source "${ZDOTDIR:-$HOME}/.zshrc"',
    '',
  ].join('\n');
}

// Git Bash / MSYS understands /c/x/y, not C:\x\y.
function msysPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/s.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
}

function pwshQuote(p: string): string {
  return p.replace(/'/g, "''");
}

export function inject(
  shell: ShellChoice,
  env: Record<string, string | undefined>,
  tmpRoot?: string,
): Injection {
  const kind = shellKind(shell.file);
  const noop = (): void => {};
  if (env.BLOCKTERM_NO_INTEGRATION === '1' || kind === 'powershell' || kind === 'other') {
    return { file: shell.file, args: shell.args, env: {}, cleanup: noop };
  }

  const dir = mkdtempSync(join(tmpRoot ?? tmpdir(), `blockterm-${process.pid}-`));
  chmodSync(dir, 0o700);
  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };

  if (kind === 'bash') {
    const rc = join(dir, 'bashrc');
    writeFileSync(rc, BASH_RC_PREFIX + BASH_INTEGRATION, { mode: 0o600 });
    const argPath = process.platform === 'win32' ? msysPath(rc) : rc;
    return { file: shell.file, args: ['--rcfile', argPath], env: {}, cleanup };
  }

  if (kind === 'zsh') {
    const zshrc = join(dir, '.zshrc');
    const orig = env.ZDOTDIR ?? '';
    writeFileSync(zshrc, zshRcPrefix() + ZSH_INTEGRATION, { mode: 0o600 });
    return {
      file: shell.file,
      args: shell.args,
      env: { ZDOTDIR: dir, BLOCKTERM_ORIG_ZDOTDIR: orig },
      cleanup,
    };
  }

  const script = join(dir, 'blockterm.ps1');
  writeFileSync(script, PWSH_INTEGRATION, { mode: 0o600 });
  return {
    file: shell.file,
    args: ['-NoLogo', '-NoExit', '-Command', `. '${pwshQuote(script)}'`],
    env: {},
    cleanup,
  };
}
