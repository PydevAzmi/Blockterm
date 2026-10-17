let done = false;

function report() {
  process.stdout.write(`cols:${process.stdout.columns}\n`);
}

function finish(code) {
  if (done) return;
  done = true;
  clearInterval(refresh);
  clearTimeout(timer);
  process.exit(code);
}

// On Windows ConPTY no SIGWINCH arrives and Node caches the TTY size at
// startup, so 'resize' never fires. Poll the live console size (the same hook
// Node wires to SIGWINCH on POSIX) to surface the event on every platform.
const refresh = setInterval(() => process.stdout._refreshSize?.(), 100);

process.stdout.on('resize', report);

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', () => finish(0));
process.stdin.resume();

const timer = setTimeout(() => finish(0), 5000);

report();
