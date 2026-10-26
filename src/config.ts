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
  /** Extra arguments for `shell`, e.g. ["--login"]. */
  shellArgs?: string[];
  /** Color of agent replies: a name (cyan, bright-magenta, ...), 0-255, or #rrggbb. */
  agentColor?: string;
  /** Arabic/RTL shaping and bidi: auto-detect, on, or off. */
  rtl?: 'auto' | 'on' | 'off';
  headers: Record<string, string> | null;
  sessionHeader: string | null;
}

const HEADER_NAME = /^[A-Za-z0-9-]+$/;

const COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/** SGR parameters for a color spec; null for an unknown spec. */
export function parseColor(spec: string): string | null {
  const name = spec.trim().toLowerCase();
  const base = COLOR_NAMES.indexOf(name);
  if (base >= 0) return String(30 + base);
  const bright = name.startsWith('bright-') ? COLOR_NAMES.indexOf(name.slice(7)) : -1;
  if (bright >= 0) return String(90 + bright);
  if (name === 'gray' || name === 'grey') return '90';
  if (/^\d{1,3}$/.test(name) && Number(name) <= 255) return `38;5;${Number(name)}`;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(name);
  if (hex !== null) return `38;2;${parseInt(hex[1]!, 16)};${parseInt(hex[2]!, 16)};${parseInt(hex[3]!, 16)}`;
  return null;
}

/** SGR for agent replies; cyan when unset. */
export function colorSgr(spec: string | null): string {
  return (spec === null ? null : parseColor(spec)) ?? '36';
}

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

  const shellArgs = raw.shellArgs;
  if (
    shellArgs !== undefined &&
    (!Array.isArray(shellArgs) || !shellArgs.every(arg => typeof arg === 'string'))
  ) {
    return invalid('shellArgs must be an array of strings');
  }

  const rawColor = raw.agentColor;
  const agentColor = typeof rawColor === 'number' ? String(rawColor) : rawColor;
  if (agentColor !== undefined && (typeof agentColor !== 'string' || parseColor(agentColor) === null)) {
    return invalid('agentColor must be a color name, 0-255, or #rrggbb');
  }

  const rtl = raw.rtl;
  if (rtl !== undefined && rtl !== 'auto' && rtl !== 'on' && rtl !== 'off') {
    return invalid('rtl must be "auto", "on" or "off"');
  }

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
    config: {
      provider: pkg,
      model,
      apiKeyEnv,
      baseURL,
      name,
      shell,
      ...(shellArgs !== undefined ? { shellArgs: shellArgs as string[] } : {}),
      ...(agentColor !== undefined ? { agentColor } : {}),
      ...(rtl !== undefined ? { rtl } : {}),
      headers,
      sessionHeader,
    },
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
