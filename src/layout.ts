export interface Size {
  cols: number;
  rows: number;
}

export type PanelMode = 'hidden' | 'docked' | 'overlay';

export interface Rect {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface Layout {
  host: Size;
  pty: Size;
  origin: { row: number; col: number };
  panel: { mode: PanelMode; rect: Rect | null };
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function computeLayout(host: Size, panelOpen = false): Layout {
  const ptyRows = Math.max(1, host.rows - 3);
  const hiddenCols = Math.max(1, host.cols - 4);

  if (!panelOpen) {
    return {
      host,
      pty: { cols: hiddenCols, rows: ptyRows },
      origin: { row: 1, col: 2 },
      panel: { mode: 'hidden', rect: null },
    };
  }

  const width = clamp(Math.floor(host.cols / 3), 36, 60);
  const dockedCols = host.cols - 4 - width;

  if (dockedCols >= 60) {
    return {
      host,
      pty: { cols: dockedCols, rows: ptyRows },
      origin: { row: 1, col: 2 },
      panel: {
        mode: 'docked',
        rect: { row: 1, col: 4 + dockedCols, rows: ptyRows, cols: width },
      },
    };
  }

  return {
    host,
    pty: { cols: hiddenCols, rows: ptyRows },
    origin: { row: 1, col: 2 },
    panel: {
      mode: 'overlay',
      rect: { row: 1, col: 1, rows: ptyRows, cols: Math.max(0, host.cols - 2) },
    },
  };
}
