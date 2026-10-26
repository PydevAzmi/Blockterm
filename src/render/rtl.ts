import { createRequire } from 'node:module';

import type { Bidi } from 'bidi-js';

import type { Cell } from './frame.js';

const require = createRequire(import.meta.url);
const bidi = (require('bidi-js') as () => Bidi)();

export type Base = 'auto' | 'ltr' | 'rtl';

/** Logical cells of a reordered host row plus visual→logical column map (absolute columns). */
export interface LogicalRow {
  cells: Cell[];
  map: number[];
}

type Join = 'D' | 'R' | 'U' | 'T' | 'C';

interface Shaping {
  join: Join;
  forms: readonly [string | null, string | null, string | null, string | null];
}

const SHAPING = new Map<string, Shaping>();

function define(
  letter: string,
  join: Join,
  isolated?: string,
  final?: string,
  initial?: string,
  medial?: string,
): void {
  SHAPING.set(letter, { join, forms: [isolated ?? null, final ?? null, initial ?? null, medial ?? null] });
}

define('\u0621', 'U', '\uFE80');
define('\u0622', 'R', '\uFE81', '\uFE82');
define('\u0623', 'R', '\uFE83', '\uFE84');
define('\u0624', 'R', '\uFE85', '\uFE86');
define('\u0625', 'R', '\uFE87', '\uFE88');
define('\u0626', 'D', '\uFE89', '\uFE8A', '\uFE8B', '\uFE8C');
define('\u0627', 'R', '\uFE8D', '\uFE8E');
define('\u0628', 'D', '\uFE8F', '\uFE90', '\uFE91', '\uFE92');
define('\u0629', 'R', '\uFE93', '\uFE94');
define('\u062A', 'D', '\uFE95', '\uFE96', '\uFE97', '\uFE98');
define('\u062B', 'D', '\uFE99', '\uFE9A', '\uFE9B', '\uFE9C');
define('\u062C', 'D', '\uFE9D', '\uFE9E', '\uFE9F', '\uFEA0');
define('\u062D', 'D', '\uFEA1', '\uFEA2', '\uFEA3', '\uFEA4');
define('\u062E', 'D', '\uFEA5', '\uFEA6', '\uFEA7', '\uFEA8');
define('\u062F', 'R', '\uFEA9', '\uFEAA');
define('\u0630', 'R', '\uFEAB', '\uFEAC');
define('\u0631', 'R', '\uFEAD', '\uFEAE');
define('\u0632', 'R', '\uFEAF', '\uFEB0');
define('\u0633', 'D', '\uFEB1', '\uFEB2', '\uFEB3', '\uFEB4');
define('\u0634', 'D', '\uFEB5', '\uFEB6', '\uFEB7', '\uFEB8');
define('\u0635', 'D', '\uFEB9', '\uFEBA', '\uFEBB', '\uFEBC');
define('\u0636', 'D', '\uFEBD', '\uFEBE', '\uFEBF', '\uFEC0');
define('\u0637', 'D', '\uFEC1', '\uFEC2', '\uFEC3', '\uFEC4');
define('\u0638', 'D', '\uFEC5', '\uFEC6', '\uFEC7', '\uFEC8');
define('\u0639', 'D', '\uFEC9', '\uFECA', '\uFECB', '\uFECC');
define('\u063A', 'D', '\uFECD', '\uFECE', '\uFECF', '\uFED0');
define('\u0640', 'C');
define('\u0641', 'D', '\uFED1', '\uFED2', '\uFED3', '\uFED4');
define('\u0642', 'D', '\uFED5', '\uFED6', '\uFED7', '\uFED8');
define('\u0643', 'D', '\uFED9', '\uFEDA', '\uFEDB', '\uFEDC');
define('\u0644', 'D', '\uFEDD', '\uFEDE', '\uFEDF', '\uFEE0');
define('\u0645', 'D', '\uFEE1', '\uFEE2', '\uFEE3', '\uFEE4');
define('\u0646', 'D', '\uFEE5', '\uFEE6', '\uFEE7', '\uFEE8');
define('\u0647', 'D', '\uFEE9', '\uFEEA', '\uFEEB', '\uFEEC');
define('\u0648', 'R', '\uFEED', '\uFEEE');
define('\u0649', 'R', '\uFEEF', '\uFEF0');
define('\u064A', 'D', '\uFEF1', '\uFEF2', '\uFEF3', '\uFEF4');
define('\u067E', 'D', '\uFB56', '\uFB57', '\uFB58', '\uFB59');
define('\u0686', 'D', '\uFB7A', '\uFB7B', '\uFB7C', '\uFB7D');
define('\u0698', 'R', '\uFB8A', '\uFB8B');
define('\u06A9', 'D', '\uFB8E', '\uFB8F', '\uFB90', '\uFB91');
define('\u06AF', 'D', '\uFB92', '\uFB93', '\uFB94', '\uFB95');
define('\u06CC', 'D', '\uFBFC', '\uFBFD', '\uFBFE', '\uFBFF');

for (let cp = 0x064b; cp <= 0x065f; cp += 1) define(String.fromCodePoint(cp), 'T');
define('\u0670', 'T');

function previousJoiner(chars: readonly string[], index: number): Shaping | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const entry = SHAPING.get(chars[i]!);
    if (entry === undefined) return null;
    if (entry.join === 'T') continue;
    return entry;
  }
  return null;
}

function nextJoiner(chars: readonly string[], index: number): Shaping | null {
  for (let i = index + 1; i < chars.length; i += 1) {
    const entry = SHAPING.get(chars[i]!);
    if (entry === undefined) return null;
    if (entry.join === 'T') continue;
    return entry;
  }
  return null;
}

function joinsLeft(entry: Shaping): boolean {
  return entry.join === 'D' || entry.join === 'C';
}

function joinsRight(entry: Shaping): boolean {
  return entry.join === 'D' || entry.join === 'R' || entry.join === 'C';
}

/** Contextual forms for the Arabic letters in `chars` (logical order); same length, non-Arabic unchanged. */
export function shapeArabic(chars: readonly string[]): string[] {
  const out = chars.slice();
  for (let i = 0; i < chars.length; i += 1) {
    const entry = SHAPING.get(chars[i]!);
    if (entry === undefined || entry.join === 'T' || entry.join === 'C') continue;

    const prev = previousJoiner(chars, i);
    const next = nextJoiner(chars, i);
    const joinsPrev = prev !== null && joinsLeft(prev) && joinsRight(entry);
    const joinsNext = next !== null && joinsLeft(entry) && joinsRight(next);

    let form: number;
    if (joinsPrev && joinsNext) form = 3;
    else if (joinsPrev) form = 1;
    else if (joinsNext) form = 2;
    else form = 0;

    const shaped = entry.forms[form] ?? entry.forms[0];
    if (shaped !== null) out[i] = shaped;
  }
  return out;
}

function isRtlClass(ch: string): boolean {
  const type = bidi.getBidiCharTypeName(ch);
  return type === 'R' || type === 'AL';
}

export function hasRtl(text: string): boolean {
  for (const ch of text) {
    if (isRtlClass(ch)) return true;
  }
  return false;
}

interface Unit {
  indices: number[];
  lead: Cell;
}

function placeholder(ch: string): string {
  const first = Array.from(ch)[0];
  return first !== undefined && isRtlClass(first) ? '\u05D0' : 'a';
}

export function reorderSpan(
  cells: Cell[],
  frameCols: number,
  row: number,
  col: number,
  width: number,
  base: Base,
  logical: Map<number, LogicalRow>,
): boolean {
  if (frameCols <= 0 || row < 0 || col < 0 || col >= frameCols) return false;
  const spanWidth = Math.min(width, frameCols - col);
  if (spanWidth <= 0) return false;

  const rowStart = row * frameCols;
  if (rowStart + frameCols > cells.length) return false;

  let spanText = '';
  for (let i = col; i < col + spanWidth; i += 1) spanText += cells[rowStart + i]!.ch;
  if (!hasRtl(spanText)) return false;

  const before: Cell[] = [];
  for (let i = 0; i < frameCols; i += 1) before.push({ ...cells[rowStart + i]! });

  const units: Unit[] = [];
  for (let i = col; i < col + spanWidth; i += 1) {
    const abs = rowStart + i;
    const cell = cells[abs]!;
    const previous = units[units.length - 1];
    if (cell.width === 0 && previous !== undefined && previous.indices[previous.indices.length - 1] === abs - 1) {
      previous.indices.push(abs);
      continue;
    }
    units.push({ indices: [abs], lead: cell });
  }

  const shaped = shapeArabic(units.map(unit => unit.lead.ch));
  for (let i = 0; i < units.length; i += 1) units[i]!.lead.ch = shaped[i]!;

  const text = units.map(unit => (unit.lead.ch.length === 1 ? unit.lead.ch : placeholder(unit.lead.ch))).join('');
  const levels = bidi.getEmbeddingLevels(text, base === 'auto' ? undefined : base);

  for (let i = 0; i < units.length; i += 1) {
    if ((levels.levels[i]! & 1) === 1) {
      const unit = units[i]!;
      if (unit.lead.ch.length === 1) {
        const mirrored = bidi.getMirroredCharacter(unit.lead.ch);
        if (mirrored !== null) unit.lead.ch = mirrored;
      }
    }
  }

  const ordered = units.slice();
  for (const segment of bidi.getReorderSegments(text, levels)) {
    let start = segment[0]!;
    let end = segment[1]!;
    while (start < end) {
      const swap = ordered[start]!;
      ordered[start] = ordered[end]!;
      ordered[end] = swap;
      start += 1;
      end -= 1;
    }
  }

  const visualCells: Cell[] = [];
  const visualLogical: number[] = [];
  for (const unit of ordered) {
    for (const abs of unit.indices) {
      visualCells.push(cells[abs]!);
      visualLogical.push(abs - rowStart);
    }
  }

  const map = Array.from({ length: frameCols }, (_, i) => i);
  for (let i = 0; i < visualCells.length; i += 1) {
    cells[rowStart + col + i] = visualCells[i]!;
    map[col + i] = visualLogical[i]!;
  }

  logical.set(row, { cells: before, map });
  return true;
}

/** Visual column for logical column `logicalCol` on a reordered row; `end` when logicalCol is past the text. */
export function visualCol(map: readonly number[], logicalCol: number, end: number): number {
  const found = map.indexOf(logicalCol);
  return found === -1 ? end : found;
}
