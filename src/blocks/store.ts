import type { IDisposable, IMarker, Terminal } from '@xterm/headless';

import { cellFrom, type Cell } from '../render/frame.js';
import { watchMarks, type Mark } from './marks.js';

export interface SnapLine {
  cells: Cell[];
  wrapped: boolean;
}

export interface Block {
  id: number;
  command: string;
  cwd: string | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  lines: SnapLine[];
  omitted: number;
}

const MAX_LINES = 10000;
const HALF = MAX_LINES / 2;

function cap(lines: SnapLine[]): { kept: SnapLine[]; omitted: number } {
  if (lines.length <= MAX_LINES) return { kept: lines, omitted: 0 };
  return {
    kept: [...lines.slice(0, HALF), ...lines.slice(lines.length - HALF)],
    omitted: lines.length - MAX_LINES,
  };
}

function isBlank(cell: Cell): boolean {
  return cell.ch === '' || cell.ch === ' ';
}

export class BlockStore {
  private readonly mirror: Terminal;
  private readonly now: () => number;
  private readonly watcher: IDisposable;
  private readonly listeners = new Set<() => void>();

  private finished: Block[] = [];
  private nextId = 1;
  private currentCwd: string | null = null;
  private seen = false;

  private promptMarker: IMarker | null = null;
  private commandMarker: IMarker | null = null;
  private commandCol = 0;
  private outputMarker: IMarker | null = null;
  private outputStartRow = 0;
  private commandPending = false;

  private live: { command: string; startedAt: number } | null = null;

  constructor(mirror: Terminal, now: () => number = () => Date.now()) {
    this.mirror = mirror;
    this.now = now;
    this.watcher = watchMarks(mirror, m => this.onMark(m));
  }

  get blocks(): readonly Block[] {
    return this.finished;
  }

  get running(): { command: string; startedAt: number; startRow: number } | null {
    if (!this.live) return null;
    return {
      command: this.live.command,
      startedAt: this.live.startedAt,
      startRow: this.outputMarker && this.outputMarker.line >= 0 ? this.outputMarker.line : 0,
    };
  }

  get promptRow(): number | null {
    if (this.live) return null;
    if (!this.promptMarker || this.promptMarker.line < 0) return null;
    return this.promptMarker.line;
  }

  get cwd(): string | null {
    return this.currentCwd;
  }

  get integrated(): boolean {
    return this.seen;
  }

  isIdlePrompt(): boolean {
    if (!this.commandPending || !this.commandMarker || this.commandMarker.line < 0) return false;
    const buffer = this.mirror.buffer.active;
    const fromRow = this.commandMarker.line;
    const toRow = buffer.baseY + buffer.cursorY;
    const toCol = buffer.cursorX;
    if (toRow < fromRow) return false;

    for (let row = fromRow; row <= toRow; row++) {
      const line = buffer.getLine(row);
      if (!line) return false;
      const start = row === fromRow ? this.commandCol : 0;
      const end = row === toRow ? toCol : this.mirror.cols;
      for (let col = start; col < end; col++) {
        const cell = line.getCell(col);
        if (!cell) continue;
        const code = cell.getCode();
        if (code !== 0 && code !== 32) return false;
      }
    }
    return true;
  }

  clear(): void {
    this.finished = [];
    this.commandPending = false;
    this.releaseMarkers();
    this.emitChange();
  }

  onChange(cb: () => void): IDisposable {
    this.listeners.add(cb);
    return { dispose: () => void this.listeners.delete(cb) };
  }

  dispose(): void {
    this.watcher.dispose();
    this.releaseMarkers();
    this.listeners.clear();
  }

  private onMark(mark: Mark): void {
    this.seen = true;
    switch (mark.kind) {
      case 'prompt':
        this.commandPending = false;
        this.promptMarker?.dispose();
        this.promptMarker = this.mark(mark.row);
        break;
      case 'command':
        this.commandPending = true;
        this.commandCol = mark.col;
        this.commandMarker?.dispose();
        this.commandMarker = this.mark(mark.row);
        break;
      case 'output':
        this.commandPending = false;
        this.outputMarker?.dispose();
        this.outputMarker = this.mark(mark.row);
        this.outputStartRow = mark.row;
        this.live = { command: mark.commandText, startedAt: this.now() };
        break;
      case 'done':
        this.finish(mark.row, mark.exitCode);
        break;
      case 'cwd':
        this.currentCwd = mark.path;
        break;
    }
    this.emitChange();
  }

  private finish(dRow: number, exitCode: number): void {
    if (!this.live) {
      this.releaseMarkers();
      return;
    }
    const start = this.outputMarker && this.outputMarker.line >= 0 ? this.outputMarker.line : 0;
    const evicted = !this.outputMarker || this.outputMarker.line < 0;
    const { kept, omitted } = cap(this.capture(start, dRow));
    this.finished.push({
      id: this.nextId++,
      command: this.live.command,
      cwd: this.currentCwd,
      exitCode,
      startedAt: this.live.startedAt,
      endedAt: this.now(),
      lines: kept,
      omitted: omitted + (evicted ? this.outputStartRow + 1 : 0),
    });
    this.live = null;
    this.releaseMarkers();
  }

  private capture(start: number, dRow: number): SnapLine[] {
    const buffer = this.mirror.buffer.active;
    const end = dRow - 1;
    if (end < start) return [];
    const lines: SnapLine[] = [];
    const reCell = buffer.getNullCell();
    const cols = this.mirror.cols;
    for (let row = start; row <= end; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const cells: Cell[] = [];
      for (let col = 0; col < cols; col++) {
        const cell = line.getCell(col, reCell);
        cells.push(cell ? cellFrom(cell) : { ch: ' ', width: 1, sgr: '' });
      }
      while (cells.length > 0 && isBlank(cells[cells.length - 1]!)) cells.pop();
      const next = buffer.getLine(row + 1);
      lines.push({ cells, wrapped: next ? next.isWrapped : false });
    }
    return lines;
  }

  private mark(row: number): IMarker | null {
    const buffer = this.mirror.buffer.active;
    return this.mirror.registerMarker(row - (buffer.baseY + buffer.cursorY)) ?? null;
  }

  private releaseMarkers(): void {
    this.promptMarker?.dispose();
    this.commandMarker?.dispose();
    this.outputMarker?.dispose();
    this.promptMarker = null;
    this.commandMarker = null;
    this.outputMarker = null;
  }

  private emitChange(): void {
    for (const cb of [...this.listeners]) cb();
  }
}
