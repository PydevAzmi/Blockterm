import type { Decision } from './agent/loop.js';
import type { InputEvent } from './input/tokenize.js';

export interface PanelUi {
  open: boolean;
  focus: 'terminal' | 'panel';
  input: string;
  inputTruncated?: boolean;
  inputShown?: boolean;
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

function deleteLast(text: string): string {
  const points = Array.from(text);
  points.pop();
  return points.join('');
}

function decide(ui: PanelUi, decision: Decision): { ui: PanelUi; actions: Action[] } {
  return { ui: { ...ui, input: '', card: null }, actions: [{ type: 'decide', decision }] };
}

function toggle(ui: PanelUi): { ui: PanelUi; actions: Action[] } {
  if (ui.focus === 'panel') return { ui: { ...ui, focus: 'terminal' }, actions: [] };
  const actions: Action[] = ui.open ? [] : [{ type: 'layout-changed' }];
  return { ui: { ...ui, open: true, focus: 'panel' }, actions };
}

function submit(ui: PanelUi): { ui: PanelUi; actions: Action[] } {
  if (ui.mode === 'busy' || ui.input.trim() === '') return { ui, actions: [] };
  return { ui: { ...ui, input: '', mode: 'busy' }, actions: [{ type: 'submit', text: ui.input }] };
}

function plainBytes(ui: PanelUi, data: string): { ui: PanelUi; actions: Action[] } {
  if (data === ESC) {
    if (ui.mode === 'busy') return { ui, actions: [{ type: 'cancel-task' }] };
    return {
      ui: { ...ui, open: false, focus: 'terminal', input: '' },
      actions: [{ type: 'layout-changed' }],
    };
  }
  if (data.startsWith(ESC)) return { ui, actions: [] };

  let next = ui;
  const actions: Action[] = [];
  for (const ch of Array.from(data)) {
    if (ch === DEL || ch === BS) {
      next = { ...next, input: deleteLast(next.input) };
    } else if (ch === '\r') {
      const result = submit(next);
      next = result.ui;
      actions.push(...result.actions);
    } else if (isPrintable(ch)) {
      next = { ...next, input: next.input + ch };
    }
  }
  return { ui: next, actions };
}

function cardBytes(ui: PanelUi, data: string): { ui: PanelUi; actions: Action[] } {
  if (data === ESC) return decide(ui, { kind: 'deny', reason: '' });
  if (data.startsWith(ESC)) return { ui, actions: [] };

  let next = ui;
  for (const ch of Array.from(data)) {
    const card = next.card;
    if (card === null) return { ui: next, actions: [] };

    if (card.editing || card.denying) {
      if (ch === DEL || ch === BS) {
        next = { ...next, input: deleteLast(next.input), inputShown: false };
      } else if (ch === '\r') {
        if (next.inputTruncated !== false) continue;
        if (card.editing && next.inputShown !== true) continue;
        const decision: Decision = card.editing
          ? { kind: 'approve', keys: next.input, allowRest: false }
          : { kind: 'deny', reason: next.input };
        return decide(next, decision);
      } else if (isPrintable(ch)) {
        next = { ...next, input: next.input + ch, inputShown: false };
      }
    } else if (ch === 'y' && card.truncated !== true) {
      return decide(next, { kind: 'approve', keys: card.keys, allowRest: false });
    } else if (ch === 'a' && card.truncated !== true) {
      return decide(next, { kind: 'approve', keys: card.keys, allowRest: true });
    } else if (ch === 'n') {
      next = {
        ...next,
        input: '',
        inputTruncated: true,
        inputShown: false,
        card: { ...card, denying: true },
      };
    } else if (ch === 'e') {
      next = {
        ...next,
        input: card.keys,
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
    return {
      ui: { ...ui, input: ui.input + text.replace(/[\r\n]/g, ''), inputShown: false },
      actions: [],
    };
  }
  if (ui.card === null) {
    return { ui: { ...ui, input: ui.input + text }, actions: [] };
  }
  return { ui, actions: [] };
}

export function reduce(ui: PanelUi, e: InputEvent): { ui: PanelUi; actions: Action[] } {
  switch (e.type) {
    case 'agent-key':
      return toggle(ui);
    case 'focus':
      if (ui.focus === 'panel') return { ui, actions: [] };
      return { ui, actions: [{ type: 'to-pty', event: e }] };
    case 'help-key':
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
