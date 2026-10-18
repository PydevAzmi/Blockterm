import type { Config, ProviderPackage } from './config.js';
import { defaultKeyEnv, normalizeBaseURL, saveConfig } from './config.js';

const OPENCODE_GO_HEADER = 'x-opencode-session';

function isOpenCodeGo(url: string | null): boolean {
  if (url === null) return false;
  try {
    const parsed = new URL(url);
    return parsed.host === 'opencode.ai' && parsed.pathname.includes('/inference/go');
  } catch {
    return false;
  }
}

export interface Io {
  ask(question: string, def?: string): Promise<string>;
  print(line: string): void;
}

const PROVIDERS: ProviderPackage[] = [
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
];

const PROVIDER_QUESTION =
  'Provider  1) @ai-sdk/anthropic  2) @ai-sdk/openai  3) @ai-sdk/openai-compatible';

function providerChoice(answer: string): ProviderPackage | null {
  if (answer === '1') return '@ai-sdk/anthropic';
  if (answer === '2') return '@ai-sdk/openai';
  if (answer === '3') return '@ai-sdk/openai-compatible';
  return null;
}

export async function runSetup(io: Io, path: string, existing: Config | null): Promise<Config> {
  const providerDefault =
    existing === null ? '1' : String(PROVIDERS.indexOf(existing.provider) + 1);

  let provider: ProviderPackage;
  for (;;) {
    const answer = (await io.ask(PROVIDER_QUESTION, providerDefault)).trim() || providerDefault;
    const choice = providerChoice(answer);
    if (choice !== null) {
      provider = choice;
      break;
    }
    io.print('enter 1, 2 or 3');
  }

  let model: string;
  for (;;) {
    model = (await io.ask('Model', existing?.model)).trim();
    if (model !== '') break;
    io.print('a model is required');
  }

  const keep = existing !== null && existing.provider === provider;
  const keyDefault = keep ? existing.apiKeyEnv : defaultKeyEnv(provider);
  let apiKeyEnv: string;
  for (;;) {
    const answer = (await io.ask('API key env var', keyDefault)).trim() || keyDefault;
    if (answer === '' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(answer)) {
      apiKeyEnv = answer;
      break;
    }
    io.print('apiKeyEnv must be an environment variable name');
  }

  let baseURL = keep ? existing.baseURL : null;
  let name = keep ? existing.name : null;
  let headers = keep ? existing.headers : null;
  let sessionHeader = keep ? existing.sessionHeader : null;

  if (provider === '@ai-sdk/openai-compatible') {
    for (;;) {
      const answer = (await io.ask('Base URL', baseURL ?? undefined)).trim();
      const value = answer === '' ? baseURL : answer;
      if (value !== null && value !== '') {
        baseURL = value;
        break;
      }
      io.print('a base URL is required');
    }
    const normalized = baseURL === null ? null : normalizeBaseURL(baseURL);
    if (normalized !== null && normalized !== baseURL) {
      baseURL = normalized;
      io.print('removed /chat/completions — the SDK adds it');
    }
    if (isOpenCodeGo(baseURL)) {
      sessionHeader = OPENCODE_GO_HEADER;
      io.print('OpenCode Go: sending x-opencode-session');
    }
    for (;;) {
      const answer = (await io.ask('Name', name ?? undefined)).trim();
      const value = answer === '' ? name : answer;
      if (value !== null && value !== '') {
        name = value;
        break;
      }
      io.print('a name is required');
    }
  }

  const config: Config = {
    provider,
    model,
    apiKeyEnv,
    baseURL,
    name,
    shell: existing?.shell ?? null,
    headers,
    sessionHeader,
  };

  saveConfig(path, config);
  io.print(`saved ${path}`);
  return config;
}
