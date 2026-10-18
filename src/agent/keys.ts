export type KeyToken = { kind: 'text'; value: string } | { kind: 'key'; name: string };
export type ParseResult = { ok: true; tokens: KeyToken[] } | { ok: false; message: string };

const NAMED = new Set([
  'Enter',
  'Esc',
  'Tab',
  'BS',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PgUp',
  'PgDn',
  'Space',
  'lt',
]);

function isNamed(name: string): boolean {
  if (NAMED.has(name)) return true;
  return /^C-[a-z]$/.test(name);
}

export function parseKeys(syntax: string): ParseResult {
  if (syntax === '') return { ok: false, message: 'keys is empty' };

  const tokens: KeyToken[] = [];
  let text = '';

  const flush = (): void => {
    if (text !== '') {
      tokens.push({ kind: 'text', value: text });
      text = '';
    }
  };

  let i = 0;
  while (i < syntax.length) {
    const ch = syntax[i]!;
    if (ch === '<') {
      const close = syntax.indexOf('>', i + 1);
      if (close === -1) return { ok: false, message: 'unterminated key' };
      const name = syntax.slice(i + 1, close);
      if (!isNamed(name)) return { ok: false, message: `unknown key <${name}>` };
      flush();
      tokens.push({ kind: 'key', name });
      i = close + 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  flush();
  return { ok: true, tokens };
}

const SIMPLE: Record<string, string> = {
  Enter: '\r',
  Esc: '\x1b',
  Tab: '\t',
  BS: '\x7f',
  Space: ' ',
  lt: '<',
  PgUp: '\x1b[5~',
  PgDn: '\x1b[6~',
};

const CURSOR_NORMAL: Record<string, string> = {
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
};

const CURSOR_APP: Record<string, string> = {
  Up: '\x1bOA',
  Down: '\x1bOB',
  Right: '\x1bOC',
  Left: '\x1bOD',
  Home: '\x1bOH',
  End: '\x1bOF',
};

function keyBytes(name: string, appCursor: boolean): string {
  if (Object.hasOwn(SIMPLE, name)) return SIMPLE[name]!;
  const cursorMap = appCursor ? CURSOR_APP : CURSOR_NORMAL;
  if (Object.hasOwn(cursorMap, name)) return cursorMap[name]!;
  const control = /^C-([a-z])$/.exec(name);
  if (control) return String.fromCharCode(control[1]!.charCodeAt(0) - 96);
  return '';
}

export function keysToBytes(tokens: KeyToken[], appCursor: boolean): string {
  let out = '';
  for (const token of tokens) {
    out += token.kind === 'text' ? token.value : keyBytes(token.name, appCursor);
  }
  return out;
}

const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;

export function escapeControl(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else if (code === 0x5c) {
      out += '\\\\';
    } else if (HIDDEN.test(ch)) {
      const hex = code.toString(16).toUpperCase();
      out += code <= 0xffff ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function keyLabel(name: string): string {
  if (name === 'Enter') return '⏎ Enter';
  if (name === 'Esc') return '⎋ Esc';
  if (name === 'Tab') return '⇥ Tab';
  const control = /^C-([a-z])$/.exec(name);
  if (control) return `^${control[1]!.toUpperCase()}`;
  return name;
}

export function displayTokens(
  tokens: KeyToken[],
): { kind: 'text' | 'key'; label: string }[] {
  return tokens.map(token =>
    token.kind === 'text'
      ? { kind: 'text' as const, label: escapeControl(token.value) }
      : { kind: 'key' as const, label: keyLabel(token.name) },
  );
}
