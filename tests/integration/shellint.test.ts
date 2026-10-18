import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, expect, test } from 'vitest';

import { BlockStore } from '../../src/blocks/store.js';
import type { Block } from '../../src/blocks/store.js';
import { isOnPath } from '../../src/shell.js';
import { inject } from '../../src/shellint/inject.js';
import { healSpawnHelper, spawnSession } from '../../src/term/session.js';
import type { TerminalSession } from '../../src/term/session.js';

beforeAll(() => {
  healSpawnHelper();
});

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

const bashPath =
  process.platform === 'win32'
    ? firstExisting(['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'])
    : isOnPath('bash', process.env, process.platform)
      ? 'bash'
      : firstExisting(['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']);

const zshPath = isOnPath('zsh', process.env, process.platform)
  ? 'zsh'
  : firstExisting(['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh']);

const pwshPath =
  process.platform === 'win32'
    ? isOnPath('pwsh.exe', process.env, process.platform)
      ? 'pwsh.exe'
      : null
    : isOnPath('pwsh', process.env, process.platform)
      ? 'pwsh'
      : null;

// PS0 only exists in bash >= 4.4 (macOS ships 3.2), so the ps0 variants must skip there.
function bashSupportsPs0(file: string): boolean {
  try {
    const v = execFileSync(file, ['-c', 'echo ${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}'], {
      encoding: 'utf8',
    }).trim();
    const [major, minor] = v.split('.').map(n => Number.parseInt(n, 10));
    return (major ?? 0) > 4 || ((major ?? 0) === 4 && (minor ?? 0) >= 4);
  } catch {
    return false;
  }
}

const bashPs0 = bashPath !== null && bashSupportsPs0(bashPath);

function screenText(session: TerminalSession): string {
  const buffer = session.mirror.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
}

function blockText(block: Block): string {
  return block.lines
    .map(line => line.cells.map(cell => cell.ch).join('').replace(/\s+$/, ''))
    .join('\n');
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface Launched {
  session: TerminalSession;
  store: BlockStore;
  injection: ReturnType<typeof inject>;
}

function launch(
  shellFile: string,
  rcName: string,
  rcContent: string,
  extraEnv: Record<string, string> = {},
): Launched {
  const home = tempDir('blockterm-int-home-');
  const work = tempDir('blockterm-int-work-');
  if (rcName !== '') writeFileSync(join(home, rcName), rcContent);

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...extraEnv,
    HOME: home,
    USERPROFILE: home,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'blockterm',
  };
  const injection = inject({ file: shellFile, args: [] }, env, work);
  const session = spawnSession({ file: injection.file, args: injection.args }, { cols: 100, rows: 30 }, {
    ...env,
    ...injection.env,
  });
  const store = new BlockStore(session.mirror);
  return { session, store, injection };
}

function stop(launched: Launched): void {
  launched.store.dispose();
  launched.session.dispose();
  launched.injection.cleanup();
}

// Diagnostic for CI: on failure print what the mirror actually showed and which blocks/marks were seen.
function dump(launched: Launched, label: string): void {
  const lines = screenText(launched.session).split('\n');
  const blocks = launched.store.blocks.map(b => ({ command: b.command, exitCode: b.exitCode }));
  console.log(
    `\n=== ${label} FAILURE ===\n` +
      `integrated=${launched.store.integrated} promptRow=${launched.store.promptRow} blocks=${JSON.stringify(blocks)}\n` +
      `--- last 30 screen lines ---\n${lines.slice(-30).join('\n')}\n=== end ${label} ===`,
  );
}

async function driveRc(
  shellFile: string,
  rcName: string,
  rcContent: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const { session, store, injection } = launch(shellFile, rcName, rcContent, extraEnv);
  const launched = { session, store, injection };
  try {
    await waitFor(() => store.integrated && store.promptRow !== null, 20000);

    session.write('echo hi\r');
    await waitFor(() => store.blocks.length >= 1 && store.promptRow !== null, 20000);

    session.write('false\r');
    await waitFor(() => store.blocks.length >= 2, 20000);

    const [first, second] = store.blocks;
    expect(first!.command).toContain('echo hi');
    expect(first!.exitCode).toBe(0);
    expect(blockText(first!)).toContain('hi');
    expect(second!.command).toContain('false');
    expect(second!.exitCode).toBe(1);
    expect(screenText(session)).toContain('hello-rc');
  } catch (err) {
    dump(launched, `driveRc ${shellFile}`);
    throw err;
  } finally {
    stop(launched);
  }
}

const BASH_MODES: { name: string; env: Record<string, string>; prelude: string }[] = [
  { name: 'ps0', env: {}, prelude: '' },
  { name: 'debug', env: { BLOCKTERM_FORCE_BASH_DEBUG: '1' }, prelude: 'set +o history\n' },
];

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

for (const mode of BASH_MODES) {
  test.skipIf(bashPath === null || (mode.name === 'ps0' && !bashPs0))(
    `bash [${mode.name}]: integration survives a noisy failing rc and records blocks`,
    async () => {
      await driveRc(bashPath!, '.bashrc', mode.prelude + 'echo hello-rc\nfalse\n', mode.env);
    },
    40000,
  );

  test.skipIf(bashPath === null || (mode.name === 'ps0' && !bashPs0))(
    `bash [${mode.name}]: the user DEBUG trap keeps working`,
    async () => {
      const launched = launch(bashPath!, '.bashrc', "trap 'echo userdebug-trap' DEBUG\n", mode.env);
      const { session, store } = launched;
      try {
        await waitFor(() => store.integrated && store.promptRow !== null, 20000);
        if (mode.name === 'ps0') {
          session.write('trap -p DEBUG\r');
          await waitFor(() => screenText(session).includes("'echo userdebug-trap' DEBUG"), 20000);
        } else {
          const before = count(screenText(session), 'userdebug-trap');
          session.write('echo bt-ping\r');
          await waitFor(() => store.blocks.length >= 1, 20000);
          expect(count(screenText(session), 'userdebug-trap')).toBeGreaterThan(before);
        }
      } catch (err) {
        dump(launched, `bash [${mode.name}] DEBUG trap`);
        throw err;
      } finally {
        stop(launched);
      }
    },
    40000,
  );

  test.skipIf(bashPath === null || (mode.name === 'ps0' && !bashPs0))(
    `bash [${mode.name}]: the user PROMPT_COMMAND sees the real exit status`,
    async () => {
      const launched = launch(
        bashPath!,
        '.bashrc',
        "PROMPT_COMMAND='echo user-pc-status=$?'\n",
        mode.env,
      );
      const { session, store } = launched;
      try {
        await waitFor(() => store.integrated && store.promptRow !== null, 20000);
        session.write('false\r');
        await waitFor(() => store.blocks.length >= 1, 20000);
        await waitFor(() => screenText(session).includes('user-pc-status=1'), 20000);
      } catch (err) {
        dump(launched, `bash [${mode.name}] PROMPT_COMMAND status`);
        throw err;
      } finally {
        stop(launched);
      }
    },
    40000,
  );

  test.skipIf(bashPath === null || (mode.name === 'ps0' && !bashPs0))(
    `bash [${mode.name}]: an empty Enter does not create a block`,
    async () => {
      const launched = launch(bashPath!, '.bashrc', '', mode.env);
      const { session, store } = launched;
      try {
        await waitFor(() => store.integrated && store.promptRow !== null, 20000);

        session.write('\r');
        await sleep(400);
        session.write('\r');
        await sleep(400);
        expect(store.blocks.length).toBe(0);

        session.write('true\r');
        await waitFor(() => store.blocks.length >= 1, 20000);
        expect(store.blocks.length).toBe(1);
        expect(store.blocks[0]!.command).toContain('true');
        expect(store.blocks[0]!.exitCode).toBe(0);
      } catch (err) {
        dump(launched, `bash [${mode.name}] empty Enter`);
        throw err;
      } finally {
        stop(launched);
      }
    },
    40000,
  );
}

test.skipIf(zshPath === null)('zsh: integration survives a noisy failing rc and records blocks', async () => {
  await driveRc(zshPath!, '.zshrc', 'echo hello-rc\nfalse\n');
}, 40000);

test.skipIf(pwshPath === null)('pwsh: integration records blocks, exit codes and ends the session', async () => {
  const launched = launch(pwshPath!, '', '');
  const { session, store } = launched;
  let exited: number | undefined;
  session.onExit(code => {
    exited = code;
  });
  try {
    await waitFor(() => store.integrated && store.promptRow !== null, 40000);

    session.write('Write-Output hi\r');
    await waitFor(() => store.blocks.length >= 1 && store.promptRow !== null, 40000);
    const ok = store.blocks[0]!;
    expect(ok.command).toContain('Write-Output hi');
    expect(ok.exitCode).toBe(0);
    expect(blockText(ok)).toContain('hi');

    const failCommand = process.platform === 'win32' ? 'cmd /c exit 2' : "sh -c 'exit 2'";
    session.write(`${failCommand}\r`);
    await waitFor(() => store.blocks.length >= 2 && store.promptRow !== null, 40000);
    expect(store.blocks[1]!.exitCode).toBe(2);

    session.write('exit 3\r');
    await waitFor(() => exited !== undefined, 40000);
    expect(exited).toBe(3);
  } catch (err) {
    dump(launched, 'pwsh');
    throw err;
  } finally {
    stop(launched);
  }
}, 60000);
