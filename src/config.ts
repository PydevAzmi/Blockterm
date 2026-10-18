import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

export type ProviderPackage =
  | '@ai-sdk/anthropic'
  | '@ai-sdk/openai'
  | '@ai-sdk/openai-compatible';

export interface Config {
  provider: ProviderPackage;
  model: string;
  apiKeyEnv: string;
  baseURL: string | null;
  name: string | null;
  shell: string | null;
  headers: Record<string, string> | null;
  sessionHeader: string | null;
}

const HEADER_NAME = /^[A-Za-z0-9-]+$/;

export function normalizeBaseURL(url: string): string {
  return url.replace(/\/chat\/completions\/?$/, '');
}

export type LoadResult =
  | { ok: true; config: Config }
  | { ok: false; reason: 'missing' | 'invalid'; message: string };

const PROVIDERS: ProviderPackage[] = [
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
];

export function defaultKeyEnv(provider: ProviderPackage): string {
  switch (provider) {
    case '@ai-sdk/anthropic':
      return 'ANTHROPIC_API_KEY';
    case '@ai-sdk/openai':
      return 'OPENAI_API_KEY';
    case '@ai-sdk/openai-compatible':
      return '';
  }
}

export function configPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA ?? path.win32.join(home, '.config');
    return path.win32.join(appData, 'blockterm', 'config.json');
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.posix.join(home, '.config');
  return path.posix.join(base, 'blockterm', 'config.json');
}

function invalid(message: string): LoadResult {
  return { ok: false, reason: 'invalid', message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateConfig(raw: unknown): LoadResult {
  if (!isRecord(raw)) return invalid('config must be an object');

  const provider = raw.provider;
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider as ProviderPackage)) {
    return invalid(`provider must be one of ${PROVIDERS.join(', ')}`);
  }
  const pkg = provider as ProviderPackage;

  const model = raw.model;
  if (typeof model !== 'string' || model.length === 0) return invalid('model is required');

  const apiKeyEnv = raw.apiKeyEnv === undefined ? defaultKeyEnv(pkg) : raw.apiKeyEnv;
  if (
    typeof apiKeyEnv !== 'string' ||
    (apiKeyEnv !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv))
  ) {
    return invalid('apiKeyEnv must be an environment variable name');
  }

  const rawBaseURL = raw.baseURL === undefined ? null : raw.baseURL;
  const name = raw.name === undefined ? null : raw.name;
  const shell = raw.shell === undefined ? null : raw.shell;

  if (rawBaseURL !== null && typeof rawBaseURL !== 'string') return invalid('baseURL must be a string');
  if (name !== null && typeof name !== 'string') return invalid('name must be a string');
  if (shell !== null && typeof shell !== 'string') return invalid('shell must be a string');

  const baseURL = rawBaseURL === null ? null : normalizeBaseURL(rawBaseURL);

  const rawHeaders = raw.headers === undefined ? null : raw.headers;
  let headers: Record<string, string> | null = null;
  if (rawHeaders !== null) {
    if (!isRecord(rawHeaders)) return invalid('headers must be an object of header names to strings');
    headers = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (!HEADER_NAME.test(key) || typeof value !== 'string') {
        return invalid('headers must be an object of header names to strings');
      }
      headers[key] = value;
    }
  }

  const sessionHeader = raw.sessionHeader === undefined ? null : raw.sessionHeader;
  if (sessionHeader !== null && (typeof sessionHeader !== 'string' || !HEADER_NAME.test(sessionHeader))) {
    return invalid('sessionHeader must be a header name');
  }

  if (pkg === '@ai-sdk/openai-compatible' && (!baseURL || !name)) {
    return invalid('baseURL and name are required for @ai-sdk/openai-compatible');
  }

  return {
    ok: true,
    config: { provider: pkg, model, apiKeyEnv, baseURL, name, shell, headers, sessionHeader },
  };
}

export function loadConfig(filePath: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'missing', message: `no config at ${filePath}` };
    }
    return invalid('could not read config');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('config is not valid JSON');
  }

  return validateConfig(parsed);
}

export function saveConfig(filePath: string, config: Config): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, filePath);
}
