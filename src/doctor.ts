import { generateText, isStepCount, jsonSchema } from 'ai';
import type { LanguageModel } from 'ai';

import { createModel, redact } from './agent/model.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { shellExists } from './shell.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const NODE_MAJOR_MIN = 24;

function nodeCheck(): Check {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  const ok = Number.isFinite(major) && major >= NODE_MAJOR_MIN;
  return {
    name: 'node',
    ok,
    detail: ok ? `v${process.versions.node}` : `node ${NODE_MAJOR_MIN}+ required, found v${process.versions.node}`,
  };
}

async function ptyCheck(): Promise<Check> {
  try {
    await import('node-pty');
    return { name: 'pty', ok: true, detail: 'node-pty loaded' };
  } catch (err) {
    return { name: 'pty', ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function skipped(name: string): Check {
  return { name, ok: false, detail: 'skipped' };
}

export async function runDoctor(o: {
  configPath: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  shellFile: string;
  modelOverride?: LanguageModel;
}): Promise<Check[]> {
  const checks: Check[] = [];

  checks.push(nodeCheck());
  checks.push(await ptyCheck());

  checks.push(
    shellExists(o.shellFile, o.env, o.platform)
      ? { name: 'shell', ok: true, detail: o.shellFile }
      : { name: 'shell', ok: false, detail: `not found: ${o.shellFile}` },
  );

  const loaded = loadConfig(o.configPath);
  if (!loaded.ok) {
    checks.push({
      name: 'config',
      ok: false,
      detail: loaded.reason === 'missing' ? 'run blockterm setup' : loaded.message,
    });
    checks.push(skipped('key'));
    checks.push(skipped('model'));
    return checks;
  }

  const config: Config = loaded.config;
  checks.push({ name: 'config', ok: true, detail: o.configPath });

  const needsKey = config.apiKeyEnv !== '';
  const keyValue = needsKey ? o.env[config.apiKeyEnv] : undefined;
  const keyOk = !needsKey || (keyValue !== undefined && keyValue !== '');
  if (keyOk) {
    checks.push({
      name: 'key',
      ok: true,
      detail: needsKey ? `found ${config.apiKeyEnv}` : 'no key needed',
    });
  } else {
    checks.push({ name: 'key', ok: false, detail: `set ${config.apiKeyEnv}` });
    checks.push(skipped('model'));
    return checks;
  }

  let model: LanguageModel;
  if (o.modelOverride !== undefined) {
    model = o.modelOverride;
  } else {
    const created = createModel(config, o.env);
    if (!created.ok) {
      checks.push({ name: 'model', ok: false, detail: `set ${created.missingKeyEnv}` });
      return checks;
    }
    model = created.model;
  }

  try {
    const result = await generateText({
      model,
      tools: {
        ping: {
          description: 'Ping the terminal agent.',
          inputSchema: jsonSchema({ type: 'object', properties: {} }),
          execute: async () => 'pong',
        },
      },
      stopWhen: isStepCount(2),
      prompt: 'Call the ping tool once.',
      abortSignal: AbortSignal.timeout(20000),
    });
    checks.push(
      result.toolCalls.length > 0
        ? { name: 'model', ok: true, detail: 'tool calls work' }
        : {
            name: 'model',
            ok: false,
            detail: 'model answered but did not call the tool — the agent needs a tool-capable model',
          },
    );
  } catch (err) {
    const secrets = config.apiKeyEnv !== '' ? [o.env[config.apiKeyEnv] ?? ''] : [];
    const message = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'model', ok: false, detail: redact(message, secrets) });
  }

  return checks;
}
