import { randomUUID } from 'node:crypto';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import type { Config } from '../config.js';

export type ModelResult =
  | { ok: true; model: LanguageModel; label: string }
  | { ok: false; missingKeyEnv: string };

export interface CreateModelOptions {
  sessionId?: string;
  fetch?: typeof globalThis.fetch;
}

function buildHeaders(
  config: Config,
  sessionId: string | undefined,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  if (config.sessionHeader !== null && config.sessionHeader !== '') {
    headers[config.sessionHeader] = sessionId ?? randomUUID();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function createModel(
  config: Config,
  env: Record<string, string | undefined>,
  opts: CreateModelOptions = {},
): ModelResult {
  const requiresKey = config.apiKeyEnv !== '';
  const apiKey = requiresKey ? env[config.apiKeyEnv] : undefined;
  if (requiresKey && (apiKey === undefined || apiKey === '')) {
    return { ok: false, missingKeyEnv: config.apiKeyEnv };
  }

  const headers = buildHeaders(config, opts.sessionId);
  const fetch = opts.fetch;

  switch (config.provider) {
    case '@ai-sdk/anthropic': {
      const provider = createAnthropic({
        apiKey,
        ...(config.baseURL !== null ? { baseURL: config.baseURL } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(fetch !== undefined ? { fetch } : {}),
      });
      return { ok: true, model: provider(config.model), label: config.model };
    }
    case '@ai-sdk/openai': {
      const provider = createOpenAI({
        apiKey,
        ...(config.baseURL !== null ? { baseURL: config.baseURL } : {}),
        ...(headers !== undefined ? { headers } : {}),
        ...(fetch !== undefined ? { fetch } : {}),
      });
      return { ok: true, model: provider(config.model), label: config.model };
    }
    case '@ai-sdk/openai-compatible': {
      const provider = createOpenAICompatible({
        name: config.name ?? '',
        baseURL: config.baseURL ?? '',
        apiKey,
        ...(headers !== undefined ? { headers } : {}),
        ...(fetch !== undefined ? { fetch } : {}),
      });
      return { ok: true, model: provider(config.model), label: config.model };
    }
  }
}

export function keyHint(platform: NodeJS.Platform, varName: string): string[] {
  if (platform === 'win32') {
    return [`setx ${varName} "<your key>"`, 'then open a new terminal'];
  }
  return [
    `export ${varName}="<your key>"`,
    'add it to ~/.bashrc or ~/.zshrc to keep it',
  ];
}

const SK_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}/g;

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('***');
  }
  return out.replace(SK_TOKEN, '***');
}
