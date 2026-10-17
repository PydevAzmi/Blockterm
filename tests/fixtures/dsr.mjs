let reply = '';

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  reply += chunk;
  if (reply.includes('R')) {
    process.stdout.write(JSON.stringify(reply) + '\n');
    process.exit(0);
  }
});
process.stdin.resume();

process.stdout.write('\x1b[6n');

setTimeout(() => process.exit(2), 8000).unref();
