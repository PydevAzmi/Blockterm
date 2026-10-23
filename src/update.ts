import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

export type InstallKind = { kind: 'git'; root: string } | { kind: 'npm' };

export interface Step {
  cmd: string;
  args: string[];
}

const DONE = 'blockterm is up to date. Restart any open blockterm windows.';
const DIVERGED =
  'Local changes or a diverged branch stopped the update. Commit or stash them, then run blockterm update again.';

export function detectInstall(cliFile: string, exists: (p: string) => boolean): InstallKind {
  const root = dirname(dirname(cliFile));
  return exists(join(root, '.git')) ? { kind: 'git', root } : { kind: 'npm' };
}

export function updateSteps(install: InstallKind): Step[] {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (install.kind === 'git') {
    return [
      { cmd: 'git', args: ['pull', '--ff-only'] },
      { cmd: npm, args: ['install'] },
      { cmd: npm, args: ['run', 'build'] },
    ];
  }
  // Node 24's npm blocks dependency install scripts; node-pty needs its script on Linux (no prebuild).
  return [{ cmd: npm, args: ['install', '-g', '--allow-scripts=node-pty', 'blockterm@latest'] }];
}

export function spawnStep(step: Step, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const useCmd = process.platform === 'win32' && step.cmd === 'npm.cmd';
    const file = useCmd ? (process.env.ComSpec ?? 'cmd.exe') : step.cmd;
    const args = useCmd ? ['/d', '/s', '/c', step.cmd, ...step.args] : step.args;
    const child = spawn(file, args, { stdio: 'inherit', cwd });
    child.on('error', error => {
      reject(new Error(`could not run ${step.cmd}: ${error.message}`));
    });
    child.on('exit', code => resolve(code ?? 1));
  });
}

export async function runUpdate(o: {
  install: InstallKind;
  run: (step: Step, cwd: string) => Promise<number>;
  print: (line: string) => void;
}): Promise<number> {
  const cwd = o.install.kind === 'git' ? o.install.root : process.cwd();

  for (const step of updateSteps(o.install)) {
    o.print(`$ ${step.cmd} ${step.args.join(' ')}`);
    let code: number;
    try {
      code = await o.run(step, cwd);
    } catch (err) {
      o.print(err instanceof Error ? err.message : String(err));
      return 1;
    }
    if (code !== 0) {
      if (step.cmd === 'git' && step.args[0] === 'pull') o.print(DIVERGED);
      return code;
    }
  }

  o.print(DONE);
  return 0;
}
