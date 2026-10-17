process.stdout.write('\x1b[?1049h');
setTimeout(() => {
  process.stdout.write('\x1b[?1049l');
  setTimeout(() => process.exit(0), 300);
}, 300);
