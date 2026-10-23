export type SelectionKey =
  | 'prev'
  | 'next'
  | 'copy-command'
  | 'copy-output'
  | 'rerun'
  | 'explain'
  | 'exit'
  | 'scroll-page-up'
  | 'scroll-page-down'
  | 'scroll-top'
  | 'scroll-bottom'
  | null;

const KEYS: Record<string, Exclude<SelectionKey, null>> = {
  '\x1b[1;5A': 'prev',
  '\x1b[1;5B': 'next',
  c: 'copy-command',
  o: 'copy-output',
  r: 'rerun',
  e: 'explain',
  '\r': 'exit',
  '\x1b': 'exit',
  '\x1b[5~': 'scroll-page-up',
  '\x1b[6~': 'scroll-page-down',
  '\x1b[H': 'scroll-top',
  '\x1b[1~': 'scroll-top',
  '\x1b[F': 'scroll-bottom',
  '\x1b[4~': 'scroll-bottom',
};

export function selectionKey(data: string): SelectionKey {
  return KEYS[data] ?? null;
}

export function moveSelection(
  ids: readonly number[],
  current: number | null,
  dir: 'prev' | 'next',
): number | null {
  if (ids.length === 0) return null;
  const index = current === null ? ids.length : ids.indexOf(current);
  if (index === -1) return dir === 'prev' ? ids[ids.length - 1]! : null;
  if (dir === 'prev') return ids[Math.max(0, index - 1)]!;
  return index + 1 < ids.length ? ids[index + 1]! : null;
}
