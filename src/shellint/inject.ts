import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ShellChoice } from '../shell.js';
import {
  BASH_INTEGRATION,
  PWSH_INTEGRATION,
  ZSH_ENV,
  ZSH_INTEGRATION,
  ZSH_LOGIN,
  ZSH_PROFILE,
  ZSH_RC_FOOTER,
  ZSH_RC_HEADER,
} from './scripts.js';

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

// Ruling AF: on win32 only Git for Windows / MSYS bash gets our rcfile; WSL and Cygwin bash
// are left untouched (their paths and startup model differ).
function isGitBash(file: string): boolean {
  return /\\git\\|\\msys/i.test(file.replace(/\//g, '\\'));
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
  platform: NodeJS.Platform = process.platform,
): Injection {
  const kind = shellKind(shell.file);
  const noop = (): void => {};
  const off =
    env.BLOCKTERM_NO_INTEGRATION === '1' ||
    kind === 'powershell' ||
    kind === 'other' ||
    // Ruling AG: on macOS pwsh never runs the typed command, so leave its spawn untouched.
    (kind === 'pwsh' && platform === 'darwin') ||
    (kind === 'bash' && platform === 'win32' && !isGitBash(shell.file));
  if (off) {
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
    const argPath = platform === 'win32' ? msysPath(rc) : rc;
    return { file: shell.file, args: ['--rcfile', argPath], env: {}, cleanup };
  }

  if (kind === 'zsh') {
    const orig = env.ZDOTDIR ?? '';
    writeFileSync(join(dir, '.zshenv'), ZSH_ENV, { mode: 0o600 });
    writeFileSync(join(dir, '.zprofile'), ZSH_PROFILE, { mode: 0o600 });
    writeFileSync(join(dir, '.zlogin'), ZSH_LOGIN, { mode: 0o600 });
    writeFileSync(join(dir, '.zshrc'), ZSH_RC_HEADER + ZSH_INTEGRATION + '\n' + ZSH_RC_FOOTER + '\n', {
      mode: 0o600,
    });
    return {
      file: shell.file,
      args: shell.args,
      env: { ZDOTDIR: dir, BLOCKTERM_ZDOTDIR: dir, BLOCKTERM_ORIG_ZDOTDIR: orig },
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
