import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const recordFile = process.argv[2];

const BASE = {
  id: 'chatcmpl-fake',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'fake-1',
};

const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function chunk(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function toolCallStream(includeUsage) {
  const parts = [
    chunk({
      ...BASE,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'send_keys',
                  arguments: '{"keys":"echo AGENT_OK<Enter>"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    chunk({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ];
  if (includeUsage) {
    parts.push(chunk({ ...BASE, choices: [], usage: USAGE }));
  }
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}

function contentStream(includeUsage) {
  const parts = [
    chunk({
      ...BASE,
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null },
      ],
    }),
    chunk({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  ];
  if (includeUsage) {
    parts.push(chunk({ ...BASE, choices: [], usage: USAGE }));
  }
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}

let requests = 0;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (data) => {
    body += data;
  });
  req.on('end', () => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    if (recordFile !== undefined) {
      appendFileSync(recordFile, `${body}\n`);
    }

    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    const includeUsage = parsed?.stream_options?.include_usage === true;

    requests += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.end(requests === 1 ? toolCallStream(includeUsage) : contentStream(includeUsage));
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`PORT ${address.port}\n`);
});
