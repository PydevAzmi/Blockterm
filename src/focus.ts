import type { Decision } from './agent/loop.js';
import type { InputEvent } from './input/tokenize.js';

export interface PanelUi {
  open: boolean;
  focus: 'terminal' | 'panel';
  input: string;
  cursor?: number;
  history?: string[];
  historyAt?: number;
  draft?: string;
  inputTruncated?: boolean;
  inputShown?: boolean;
  help?: boolean;
  mode: 'idle' | 'busy';
  card: null | {
    keys: string;
    target: string;
    editing: boolean;
    denying: boolean;
    truncated?: boolean;
  };
}

export type Action =
  | { type: 'to-pty'; event: InputEvent }
  | { type: 'submit'; text: string }
  | { type: 'cancel-task' }
  | { type: 'decide'; decision: Decision }
  | { type: 'layout-changed' };

const ESC = '\x1b';
const DEL = '\x7f';
const BS = '\b';

export function initialUi(): PanelUi {
  return { open: false, focus: 'terminal', input: '', mode: 'idle', card: null };
}

function isPrintable(ch: string): boolean {
  return ch >= ' ' && ch !== DEL;
}

type CursorKey = 'left' | 'right' | 'home' | 'end' | 'up' | 'down';

const CURSOR_KEYS: Record<string, CursorKey> = {
  '\x1b[D': 'left',
  '\x1bOD': 'left',
  '\x1b[C': 'right',
  '\x1bOC': 'right',
  '\x1b[H': 'home',
  '\x1bOH': 'home',
  '\x1b[1~': 'home',
  '\x1b[F': 'end',
  '\x1bOF': 'end',
  '\x1b[4~': 'end',
  '\x1b[A': 'up',
  '\x1bOA': 'up',
  '\x1b[B': 'down',
  '\x1bOB': 'down',
};

function cursorAt(ui: PanelUi, points: string[]): number {
  const cursor = ui.cursor ?? points.length;
  return Math.max(0, Math.min(cursor, points.length));
}

function withInput(ui: PanelUi, input: string, cursor?: number): PanelUi {
  return { ...ui, input, cursor };
}

function insertInput(ui: PanelUi, text: string, stripLineBreaks = false): PanelUi {
  const points = Array.from(ui.input);
  const at = cursorAt(ui, points);
  const inserted = Array.from(stripLineBreaks ? text.replace(/[\r\n]/g, '') : text);
  return withInput(
    ui,
    [...points.slice(0, at), ...inserted, ...points.slice(at)].join(''),
    at + inserted.length,
  );
}

function deleteBefore(ui: PanelUi): PanelUi {
  const points = Array.from(ui.input);
  const at = cursorAt(ui, points);
  if (at === 0) return { ...ui, cursor: 0 };
  points.splice(at - 1, 1);
  return withInput(ui, points.join(''), at - 1);
}

function moveCursor(ui: PanelUi, key: CursorKey): PanelUi {
  const points = Array.from(ui.input);
  const at = cursorAt(ui, points);
  const cursor =
    key === 'left'
      ? Math.max(0, at - 1)
      : key === 'right'
        ? Math.min(points.length, at + 1)
        : key === 'home'
          ? 0
          : points.length;
  return { ...ui, cursor };
}

function historyUp(ui: PanelUi): { ui: PanelUi; actions: Action[] } {
  const history = ui.history ?? [];
  if (history.length === 0) return { ui, actions: [] };
  if (ui.historyAt === undefined) {
    const at = history.length - 1;
    return {
      ui: { ...withInput(ui, history[at]!), historyAt: at, draft: ui.input },
      actions: [],
    };
  }
  const at = Math.min(Math.max(0, ui.historyAt - 1), history.length - 1);
  return { ui: { ...withInput(ui, history[at]!), historyAt: at }, actions: [] };
}

function historyDown(ui: PanelUi): { ui: PanelUi; actions: Action[] } {
  const history = ui.history ?? [];
  if (ui.historyAt === undefined || history.length === 0) return { ui, actions: [] };
  const at = Math.min(Math.max(0, ui.historyAt), history.length - 1);
  if (at < history.length - 1) {
    return { ui: { ...withInput(ui, history[at + 1]!), historyAt: at + 1 }, actions: [] };
  }
  return {
    ui: { ...withInput(ui, ui.draft ?? ''), historyAt: undefined, draft: undefined },
    actions: [],
  };
}

function decide(ui: PanelUi, decision: Decision): { ui: PanelUi; actions: Action[] } {
  return {
    ui: { ...withInput(ui, ''), card: null },
    actions: [{ type: 'decide', decision }],
  };
}

function toggle(ui: PanelUi): { ui: PanelUi; actions: Action[] } {
  if (ui.focus === 'panel') return { ui: { ...ui, focus: 'terminal' }, actions: [] };
  const actions: Action[] = ui.open ? [] : [{ type: 'layout-changed' }];
  return { ui: { ...ui, open: true, focus: 'panel' }, actions };
}

function submit(ui: PanelUi): { ui: PanelUi; actions: Action[] } {
  if (ui.mode === 'busy' || ui.input.trim() === '') return { ui, actions: [] };
  const history = ui.history ?? [];
  const nextHistory =
    history.length > 0 && history[history.length - 1] === ui.input
      ? history
      : [...history, ui.input];
  return {
    ui: {
      ...withInput(ui, ''),
      mode: 'busy',
      history: nextHistory,
      historyAt: undefined,
      draft: undefined,
    },
    actions: [{ type: 'submit', text: ui.input }],
  };
}

function plainBytes(ui: PanelUi, data: string): { ui: PanelUi; actions: Action[] } {
  if (data === ESC) {
    if (ui.mode === 'busy') return { ui, actions: [{ type: 'cancel-task' }] };
    return {
      ui: {
        ...withInput(ui, ''),
        open: false,
        focus: 'terminal',
        historyAt: undefined,
        draft: undefined,
      },
      actions: [{ type: 'layout-changed' }],
    };
  }
  const key = CURSOR_KEYS[data];
  if (key !== undefined) {
    if (key === 'up') return historyUp(ui);
    if (key === 'down') return historyDown(ui);
    return { ui: moveCursor(ui, key), actions: [] };
  }
  if (data.startsWith(ESC)) return { ui, actions: [] };

  let next = ui;
  const actions: Action[] = [];
  for (const ch of Array.from(data)) {
    if (ch === DEL || ch === BS) {
      next = deleteBefore(next);
    } else if (ch === '\r') {
      const result = submit(next);
      next = result.ui;
      actions.push(...result.actions);
    } else if (isPrintable(ch)) {
      next = insertInput(next, ch);
    }
  }
  return { ui: next, actions };
}

function cardBytes(ui: PanelUi, data: string): { ui: PanelUi; actions: Action[] } {
  if (data === ESC) return decide(ui, { kind: 'deny', reason: '' });
  const key = CURSOR_KEYS[data];
  if (key !== undefined) {
    const card = ui.card;
    if (card !== null && (card.editing || card.denying) && key !== 'up' && key !== 'down') {
      return { ui: moveCursor(ui, key), actions: [] };
    }
    return { ui, actions: [] };
  }
  if (data.startsWith(ESC)) return { ui, actions: [] };

  let next = ui;
  for (const ch of Array.from(data)) {
    const card = next.card;
    if (card === null) return { ui: next, actions: [] };

    if (card.editing || card.denying) {
      if (ch === DEL || ch === BS) {
        next = { ...deleteBefore(next), inputShown: false };
      } else if (ch === '\r') {
        if (next.inputTruncated !== false) continue;
        if (card.editing && next.inputShown !== true) continue;
        const decision: Decision = card.editing
          ? { kind: 'approve', keys: next.input, allowRest: false }
          : { kind: 'deny', reason: next.input };
        return decide(next, decision);
      } else if (isPrintable(ch)) {
        next = { ...insertInput(next, ch), inputShown: false };
      }
    } else if (ch === 'y' && card.truncated !== true) {
      return decide(next, { kind: 'approve', keys: card.keys, allowRest: false });
    } else if (ch === 'a' && card.truncated !== true) {
      return decide(next, { kind: 'approve', keys: card.keys, allowRest: true });
    } else if (ch === 'n') {
      next = {
        ...withInput(next, ''),
        inputTruncated: true,
        inputShown: false,
        card: { ...card, denying: true },
      };
    } else if (ch === 'e') {
      next = {
        ...withInput(next, card.keys),
        inputTruncated: true,
        inputShown: false,
        card: { ...card, editing: true },
      };
    }
  }
  return { ui: next, actions: [] };
}

function panelPaste(ui: PanelUi, text: string): { ui: PanelUi; actions: Action[] } {
  if (ui.card !== null && (ui.card.editing || ui.card.denying)) {
    return { ui: { ...insertInput(ui, text, true), inputShown: false }, actions: [] };
  }
  if (ui.card === null) {
    return { ui: insertInput(ui, text), actions: [] };
  }
  return { ui, actions: [] };
}

export function reduce(ui: PanelUi, e: InputEvent): { ui: PanelUi; actions: Action[] } {
  if (ui.help === true) {
    if (e.type === 'help-key') return { ui: { ...ui, help: false }, actions: [] };
    if (e.type === 'agent-key') return toggle(ui);
    if (e.type === 'bytes' && e.data === ESC) return { ui: { ...ui, help: false }, actions: [] };
    return { ui, actions: [] };
  }

  switch (e.type) {
    case 'agent-key':
      return toggle(ui);
    case 'focus':
      if (ui.focus === 'panel') return { ui, actions: [] };
      return { ui, actions: [{ type: 'to-pty', event: e }] };
    case 'help-key':
      return { ui: { ...ui, help: true }, actions: [] };
    case 'page-key':
      if (ui.focus === 'terminal') return { ui, actions: [{ type: 'to-pty', event: e }] };
      return { ui, actions: [] };
    case 'mouse':
      if (ui.focus === 'panel') return { ui, actions: [] };
      return { ui, actions: [{ type: 'to-pty', event: e }] };
    case 'paste':
      if (ui.focus === 'terminal') return { ui, actions: [{ type: 'to-pty', event: e }] };
      return panelPaste(ui, e.text);
    case 'bytes':
      if (ui.focus === 'terminal') return { ui, actions: [{ type: 'to-pty', event: e }] };
      return ui.card === null ? plainBytes(ui, e.data) : cardBytes(ui, e.data);
  }
}
