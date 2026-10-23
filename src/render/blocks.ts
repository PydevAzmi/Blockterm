import type { Terminal } from '@xterm/headless';

import type { Block, BlockStore, SnapLine } from '../blocks/store.js';
import type { Size } from '../layout.js';
import { cellFrom, type Cell } from './frame.js';

export interface BlocksView {
  store: BlockStore;
  scroll: number;
  hash?: { text: string; cursor: boolean } | null;
  selected?: number | null;
}

export interface BlockRow {
  id: number;
  top: number;
  height: number;
}

export interface BlockAction {
  row: number;
  col: number;
  width: number;
  blockId: number;
  kind: 'explain';
}

export interface BlocksResult {
  rows: Cell[][];
  cursor: { row: number; col: number } | null;
  docHeight: number;
  actions: BlockAction[];
  blockRows: BlockRow[];
}

const EXPLAIN_LABEL = '[Explain error]';
const EXPLAIN_WIDTH = 15;
const SELECTED_SGR = '1;36';
const BORDER_CHARS = new Set(['┌', '┐', '└', '┘', '│', '─']);

function blank(sgr = ''): Cell {
  return { ch: ' ', width: 1, sgr };
}

function highlighted(rows: Cell[][]): Cell[][] {
  return rows.map(row =>
    row.map(cell =>
      BORDER_CHARS.has(cell.ch) ? { ...cell, sgr: SELECTED_SGR } : cell,
    ),
  );
}

function charWidth(ch: string): 1 | 2 {
  const code = ch.codePointAt(0)!;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function textWidth(text: string): number {
  let width = 0;
  for (const ch of Array.from(text)) width += charWidth(ch);
  return width;
}

function pushText(row: Cell[], text: string, sgr = ''): void {
  for (const ch of Array.from(text)) {
    const width = charWidth(ch);
    row.push({ ch, width, sgr });
    if (width === 2) row.push({ ch: '', width: 0, sgr });
  }
}

function truncateText(text: string, max: number): string {
  if (max <= 0) return '';
  if (textWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const ch of Array.from(text)) {
    const w = charWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

function fitRow(row: Cell[], cols: number): Cell[] {
  const fitted = row.slice(0, cols);
  if (fitted.length > 0 && fitted[fitted.length - 1]!.width === 2) {
    fitted[fitted.length - 1] = blank();
  }
  while (fitted.length < cols) fitted.push(blank());
  return fitted;
}

function durationText(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
}

function topBorder(block: Block, cols: number, now: number): Cell[] {
  const running = block.endedAt === null;
  const elapsed = (block.endedAt ?? now) - block.startedAt;
  const duration = durationText(elapsed);
  let status: string;
  if (block.exitCode === null) status = running ? ` ${duration} ` : ` ✘ ? ${duration} `;
  else if (block.exitCode === 0) status = ` ✔ ${duration} `;
  else status = ` ✘ ${block.exitCode} ${duration} `;

  const statusWidth = textWidth(status);
  const maxPrefix = Math.max(0, cols - statusWidth - 1);
  const command = block.command.replace(/[\r\n\t]/g, ' ');
  let prefix = `┌ $ ${command} `;
  if (textWidth(prefix) > maxPrefix) {
    prefix = `┌ $ ${truncateText(command, maxPrefix - 5)} `;
  }
  if (textWidth(prefix) > maxPrefix) prefix = truncateText(prefix, maxPrefix);

  const row: Cell[] = [];
  pushText(row, prefix);
  const fill = Math.max(0, cols - textWidth(prefix) - statusWidth - 1);
  pushText(row, '─'.repeat(fill));
  const sgr = block.exitCode === null ? '' : block.exitCode === 0 ? '32' : '31';
  pushText(row, status, sgr);
  pushText(row, '┐');
  return fitRow(row, cols);
}

function bottomBorder(block: Block, cols: number, inner: number): Cell[] {
  const row: Cell[] = [];
  if (block.exitCode !== 0 && inner >= EXPLAIN_WIDTH + 2) {
    pushText(row, `└ ${EXPLAIN_LABEL} `);
    pushText(row, '─'.repeat(Math.max(0, cols - row.length - 1)));
  } else {
    pushText(row, '└');
    pushText(row, '─'.repeat(Math.max(0, cols - 2)));
  }
  pushText(row, '┘');
  return fitRow(row, cols);
}

function bordered(inner: Cell[], cols: number): Cell[] {
  const row: Cell[] = [];
  pushText(row, '│');
  row.push(...inner);
  pushText(row, '│');
  return fitRow(row, cols);
}

function markerRow(innerWidth: number, omitted: number): Cell[] {
  const row: Cell[] = [];
  const text = truncateText(`… ${omitted} lines …`, innerWidth);
  pushText(row, text, '2');
  while (row.length < innerWidth) row.push(blank('2'));
  return row;
}

function reflow(lines: SnapLine[], inner: number): Cell[][] {
  if (inner <= 0) return [];
  reflows += 1;

  const logical: Cell[][] = [];
  let joined: Cell[] = [];
  for (const line of lines) {
    for (const cell of line.cells) {
      if (cell.width !== 0) joined.push(cell);
    }
    if (!line.wrapped) {
      logical.push(joined);
      joined = [];
    }
  }
  if (joined.length > 0 || (lines.length > 0 && lines[lines.length - 1]!.wrapped)) {
    logical.push(joined);
  }

  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let used = 0;
  const flush = (): void => {
    while (used < inner) {
      row.push(blank());
      used += 1;
    }
    rows.push(row);
    row = [];
    used = 0;
  };

  for (const cells of logical) {
    for (const cell of cells) {
      const width = cell.width === 2 ? 2 : 1;
      if (width > inner) {
        row.push(blank(cell.sgr));
        used += 1;
        flush();
        continue;
      }
      if (used + width > inner) flush();
      row.push({ ch: cell.ch === '' ? ' ' : cell.ch, width, sgr: cell.sgr });
      if (width === 2) row.push({ ch: '', width: 0, sgr: cell.sgr });
      used += width;
    }
    flush();
  }

  return rows;
}

function cappedBody(block: Block, cols: number, inner: number, areaRows: number): Cell[][] {
  const body = reflow(block.lines, inner);
  if (body.length <= areaRows * 2) return body.map(row => bordered(row, cols));

  const content = Math.max(0, areaRows - 3);
  const head = Math.ceil(content / 2);
  const tail = content - head;
  const omitted = body.length - head - tail + block.omitted;
  const shown: Cell[][] = [];
  for (let i = 0; i < head; i += 1) shown.push(body[i]!);
  shown.push(markerRow(inner, omitted));
  for (let i = 0; i < tail; i += 1) shown.push(body[body.length - tail + i]!);
  return shown.map(row => bordered(row, cols));
}

function liveRow(mirror: Terminal, row: number, inner: number): Cell[] {
  const buffer = mirror.buffer.active;
  const line = buffer.getLine(row);
  const reCell = buffer.getNullCell();
  const cells: Cell[] = [];
  for (let col = 0; col < inner; col += 1) {
    const cell = line?.getCell(col, reCell);
    if (!cell) {
      cells.push(blank());
      continue;
    }
    const copied = cellFrom(cell);
    if (copied.width === 2 && col === inner - 1) {
      cells.push(blank());
      continue;
    }
    cells.push(copied);
  }
  return bordered(cells, inner + 2);
}

interface CachedBlock {
  inner: number;
  areaRows: number;
  rows: Cell[][];
  actions: BlockAction[];
}

const blockCache = new WeakMap<Block, CachedBlock>();
let reflows = 0;

export function reflowCount(): number {
  return reflows;
}

function cachedRows(
  block: Block,
  cols: number,
  inner: number,
  areaRows: number,
  now: number,
): CachedBlock {
  const hit = blockCache.get(block);
  if (hit !== undefined && hit.inner === inner && hit.areaRows === areaRows) return hit;

  const rows = [
    topBorder(block, cols, block.endedAt ?? now),
    ...cappedBody(block, cols, inner, areaRows),
    bottomBorder(block, cols, inner),
  ];
  const actions: BlockAction[] =
    block.exitCode !== 0 && inner >= EXPLAIN_WIDTH + 2
      ? [
          {
            row: rows.length - 1,
            col: 2,
            width: EXPLAIN_WIDTH,
            blockId: block.id,
            kind: 'explain',
          },
        ]
      : [];
  const cached = { inner, areaRows, rows, actions };
  if (block.endedAt !== null) blockCache.set(block, cached);
  return cached;
}

export function composeBlocks(
  mirror: Terminal,
  view: BlocksView,
  area: Size,
  now: number,
): BlocksResult {
  const cols = area.cols;
  const inner = Math.max(0, cols - 2);
  const buffer = mirror.buffer.active;
  const running = view.store.running;

  const sections: {
    start: number;
    rows: Cell[][];
    actions: BlockAction[];
  }[] = [];
  const blockRows: BlockRow[] = [];
  let docHeight = 0;
  for (const block of view.store.blocks) {
    const cached = cachedRows(block, cols, inner, area.rows, now);
    const rows =
      view.selected === block.id ? highlighted(cached.rows) : cached.rows;
    sections.push({ start: docHeight, rows, actions: cached.actions });
    blockRows.push({ id: block.id, top: docHeight, height: rows.length });
    docHeight += rows.length;
  }

  let headerAt = -1;
  let liveHeader: Cell[] | null = null;
  if (running !== null) {
    liveHeader = topBorder(
      {
        id: 0,
        command: running.command,
        cwd: null,
        exitCode: null,
        startedAt: running.startedAt,
        endedAt: null,
        lines: [],
        omitted: 0,
      },
      cols,
      now,
    );
    headerAt = docHeight;
    docHeight += 1;
  }

  const hash = view.hash ?? null;
  const liveStart = running?.startRow ?? view.store.promptRow;
  let liveFrom = 0;
  let liveBase = docHeight;
  let liveCount = 0;
  let cursorDoc: { row: number; col: number } | null = null;
  let hashRow: Cell[] | null = null;
  let hashDocRow = -1;
  if (liveStart !== null) {
    const cursorRow = buffer.baseY + buffer.cursorY;
    liveFrom = Math.max(0, Math.min(liveStart, cursorRow));
    liveCount = cursorRow - liveFrom + 1;
    liveBase = docHeight;
    docHeight += liveCount;
    hashDocRow = docHeight - 1;
    if (hash !== null) {
      const text = truncateText(hash.text, inner);
      const row: Cell[] = [];
      pushText(row, text);
      while (row.length < inner) row.push(blank());
      hashRow = bordered(row, cols);
      cursorDoc = hash.cursor
        ? {
            row: hashDocRow,
            col: Math.min(1 + textWidth(text), Math.max(0, cols - 2)),
          }
        : null;
    } else {
      cursorDoc = {
        row: hashDocRow,
        col: Math.min(1 + buffer.cursorX, Math.max(0, cols - 2)),
      };
    }
  }

  const maxScroll = Math.max(0, docHeight - area.rows);
  const scroll = Math.min(Math.max(0, Math.floor(view.scroll)), maxScroll);
  const start = Math.max(0, docHeight - area.rows - scroll);
  const end = Math.min(docHeight, start + area.rows);

  const rows: Cell[][] = [];
  const take = (from: number, to: number, source: (offset: number) => Cell[] | undefined): void => {
    const first = Math.max(start, from);
    const last = Math.min(end, to);
    for (let at = first; at < last; at += 1) {
      const row = source(at - from);
      if (row !== undefined) rows.push(row);
    }
  };

  for (const section of sections) {
    take(section.start, section.start + section.rows.length, offset => section.rows[offset]);
  }
  if (liveHeader !== null) take(headerAt, headerAt + 1, () => liveHeader!);
  if (liveStart !== null) {
    take(liveBase, liveBase + liveCount, offset =>
      hashRow !== null && liveBase + offset === hashDocRow
        ? hashRow
        : liveRow(mirror, liveFrom + offset, inner),
    );
  }

  const cursor =
    cursorDoc !== null && cursorDoc.row >= start && cursorDoc.row < end
      ? { row: cursorDoc.row - start, col: cursorDoc.col }
      : null;

  const actions: BlockAction[] = [];
  for (const section of sections) {
    for (const action of section.actions) {
      const docRow = section.start + action.row;
      if (docRow >= start && docRow < end) {
        actions.push({ ...action, row: docRow - start });
      }
    }
  }

  return { rows, cursor, docHeight, actions, blockRows };
}
