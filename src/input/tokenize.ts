export type MouseAction = 'press' | 'release' | 'motion';

export interface MouseInput {
  type: 'mouse';
  button: number;
  col: number;
  row: number;
  action: MouseAction;
}

export type InputEvent =
  | { type: 'bytes'; data: string }
  | MouseInput
  | { type: 'paste'; text: string }
  | { type: 'focus'; focused: boolean }
  | { type: 'agent-key' }
  | { type: 'help-key' };

const ESC = '\x1b';
const AGENT_KEY = '\x0b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

type Parsed =
  | { kind: 'hold' }
  | { kind: 'none' }
  | { kind: 'event'; length: number; event: InputEvent }
  | { kind: 'paste-start'; length: number };

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function mouseAction(button: number, final: string): MouseAction {
  if (final === 'm') return 'release';
  if ((button & 32) !== 0) return 'motion';
  return 'press';
}

function classifyEscape(s: string, i: number): Parsed {
  const rest = s.slice(i);
  if (rest.length === 1) return { kind: 'hold' };

  const c1 = rest[1];

  if (c1 === 'O') {
    if (rest.length === 2) return { kind: 'hold' };
    if (rest[2] === 'P') {
      return { kind: 'event', length: 3, event: { type: 'help-key' } };
    }
    return { kind: 'none' };
  }

  if (c1 !== '[') return { kind: 'none' };
  if (rest.length === 2) return { kind: 'hold' };

  const first = rest[2];

  if (first === '<') {
    let k = 3;
    while (k < rest.length) {
      const ch = rest[k];
      if (ch === 'M' || ch === 'm') {
        const fields = rest.slice(3, k).split(';');
        if (fields.length !== 3 || !fields.every(f => /^[0-9]+$/.test(f))) {
          return { kind: 'none' };
        }
        const button = Number(fields[0]);
        const col = Number(fields[1]);
        const row = Number(fields[2]);
        return {
          kind: 'event',
          length: k + 1,
          event: { type: 'mouse', button, col: col - 1, row: row - 1, action: mouseAction(button, ch) },
        };
      }
      if (ch === ';' || isDigit(ch)) {
        k++;
        continue;
      }
      return { kind: 'none' };
    }
    if (rest.length - 3 > 32) return { kind: 'none' };
    return { kind: 'hold' };
  }

  if (first === 'I') {
    return { kind: 'event', length: 3, event: { type: 'focus', focused: true } };
  }
  if (first === 'O') {
    return { kind: 'event', length: 3, event: { type: 'focus', focused: false } };
  }

  if (isDigit(first)) {
    let k = 2;
    while (k < rest.length && isDigit(rest[k] as string)) k++;
    const num = rest.slice(2, k);
    if (k === rest.length) {
      if ('11'.startsWith(num) || '200'.startsWith(num)) return { kind: 'hold' };
      return { kind: 'none' };
    }
    if (rest[k] === '~') {
      if (num === '11') {
        return { kind: 'event', length: k + 1, event: { type: 'help-key' } };
      }
      if (num === '200') return { kind: 'paste-start', length: k + 1 };
      return { kind: 'none' };
    }
    return { kind: 'none' };
  }

  return { kind: 'none' };
}

function suffixPrefixLength(s: string, start: number, target: string): number {
  const max = Math.min(target.length - 1, s.length - start);
  for (let k = max; k > 0; k--) {
    if (s.slice(s.length - k) === target.slice(0, k)) return k;
  }
  return 0;
}

export class InputTokenizer {
  private pending = '';
  private pasteMode = false;
  private pasteBuf = '';

  push(chunk: string): InputEvent[] {
    const events: InputEvent[] = [];
    let plain = '';
    const flushPlain = (): void => {
      if (plain !== '') {
        events.push({ type: 'bytes', data: plain });
        plain = '';
      }
    };

    const buf = this.pending + chunk;
    this.pending = '';
    let i = 0;

    while (i < buf.length) {
      if (this.pasteMode) {
        const idx = buf.indexOf(PASTE_END, i);
        if (idx === -1) {
          const k = suffixPrefixLength(buf, i, PASTE_END);
          this.pasteBuf += buf.slice(i, buf.length - k);
          this.pending = buf.slice(buf.length - k);
          i = buf.length;
          break;
        }
        this.pasteBuf += buf.slice(i, idx);
        events.push({ type: 'paste', text: this.pasteBuf });
        this.pasteBuf = '';
        this.pasteMode = false;
        i = idx + PASTE_END.length;
        continue;
      }

      const c = buf[i] as string;
      if (c === AGENT_KEY) {
        flushPlain();
        events.push({ type: 'agent-key' });
        i++;
        continue;
      }
      if (c === ESC) {
        const parsed = classifyEscape(buf, i);
        if (parsed.kind === 'hold') {
          flushPlain();
          this.pending = buf.slice(i);
          i = buf.length;
          break;
        }
        if (parsed.kind === 'event') {
          flushPlain();
          events.push(parsed.event);
          i += parsed.length;
          continue;
        }
        if (parsed.kind === 'paste-start') {
          flushPlain();
          this.pasteMode = true;
          this.pasteBuf = '';
          i += parsed.length;
          continue;
        }
        plain += c;
        i++;
        continue;
      }
      plain += c;
      i++;
    }

    flushPlain();
    return events;
  }

  flush(): InputEvent[] {
    if (this.pasteMode) return [];
    const events: InputEvent[] = [];
    if (this.pending !== '') {
      events.push({ type: 'bytes', data: this.pending });
      this.pending = '';
    }
    return events;
  }
}
