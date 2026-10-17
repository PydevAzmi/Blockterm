import { ENTER_HOST, installRestore } from './host.js';
import type { InputEvent } from './input/tokenize.js';
import { InputTokenizer } from './input/tokenize.js';
import { routeToPty } from './input/route.js';
import { computeLayout } from './layout.js';
import { renderDiff } from './render/diff.js';
import { FOOTER, composeFrame } from './render/frame.js';
import type { Frame } from './render/frame.js';
import { createFrameScheduler } from './render/schedule.js';
import type { ShellChoice } from './shell.js';
import { hostModeDiff, hostModesFrom, trackModes } from './term/modes.js';
import type { HostModes } from './term/modes.js';
import { spawnSession } from './term/session.js';

export async function runApp(o: {
  shell: ShellChoice;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}): Promise<number> {
  const { shell, stdin, stdout } = o;

  stdin.setRawMode(true);
  const restore = installRestore(stdin, stdout);

  let cleanup = (): void => {};

  try {
    stdout.write(ENTER_HOST);

    let layout = computeLayout({ cols: stdout.columns, rows: stdout.rows });

    const session = spawnSession(shell, layout.pty, {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'blockterm',
    });
    const tracked = trackModes(session.mirror);
    const tokenizer = new InputTokenizer();

    let lastFrame: Frame | null = null;
    let lastHostModes: HostModes | null = null;
    let inputTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const render = (): void => {
      const trackedModes = tracked.get();
      const frame = composeFrame(
        session.mirror,
        layout,
        { title: 'blockterm', footer: FOOTER, view: session.view },
        trackedModes.cursorVisible,
      );
      const hostModes = hostModesFrom(session.mirror, trackedModes);
      const out = hostModeDiff(lastHostModes, hostModes) + renderDiff(lastFrame, frame);
      if (out !== '') stdout.write(out);
      lastHostModes = hostModes;
      lastFrame = frame;
    };

    const scheduler = createFrameScheduler(render, 16);

    const route = (event: InputEvent): void => {
      const out = routeToPty(event, {
        modes: session.mirror.modes,
        tracked: tracked.get(),
        layout,
      });
      if (out !== null) session.write(out);
    };

    const flushInput = (): void => {
      inputTimer = null;
      for (const event of tokenizer.flush()) route(event);
    };

    const onData = (chunk: Buffer | string): void => {
      for (const event of tokenizer.push(chunk.toString())) route(event);
      if (inputTimer !== null) clearTimeout(inputTimer);
      inputTimer = setTimeout(flushInput, 10);
    };

    const onResize = (): void => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        layout = computeLayout({ cols: stdout.columns, rows: stdout.rows });
        session.resize(layout.pty);
        lastFrame = null;
        scheduler.request();
      }, 50);
    };

    const parsed = session.onParsed(() => scheduler.request());
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    scheduler.request();

    cleanup = (): void => {
      scheduler.dispose();
      if (inputTimer !== null) clearTimeout(inputTimer);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      stdin.off('data', onData);
      stdout.off('resize', onResize);
      parsed.dispose();
      tracked.dispose();
      session.dispose();
    };

    const exitCode = await new Promise<number>(resolve => {
      session.onExit(code => resolve(code));
    });

    cleanup();
    restore();
    return exitCode;
  } catch (err) {
    cleanup();
    restore();
    throw err;
  }
}
