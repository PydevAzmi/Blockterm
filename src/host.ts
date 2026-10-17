export const ENTER_HOST = '\x1b[?1049h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[H\x1b[2J';

export const LEAVE_HOST =
  '\x1b[?1004l\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1l\x1b>\x1b[0 q\x1b[0m\x1b[?25h\x1b[?1049l';

export function installRestore(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): () => void {
  let restored = false;

  const restore = (): void => {
    if (restored) return;
    restored = true;
    stdout.write(LEAVE_HOST);
    stdin.setRawMode(false);
    stdin.pause();
  };

  process.on('exit', restore);
  process.on('uncaughtException', err => {
    restore();
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    restore();
    process.exit(143);
  });
  process.on('SIGHUP', () => {
    restore();
    process.exit(129);
  });

  return restore;
}
