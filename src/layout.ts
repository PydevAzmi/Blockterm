export interface Size {
  cols: number;
  rows: number;
}

export type PanelMode = 'hidden' | 'docked';

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

// The shell gets the full width. The last host row is the mode line; when the agent is open,
// a fixed strip above it holds the transcript (fixed so streaming text never resizes the pty).
export function computeLayout(host: Size, panelOpen = false): Layout {
  const strip = panelOpen ? Math.min(clamp(Math.floor(host.rows / 4), 2, 10), Math.max(0, host.rows - 2)) : 0;
  const ptyRows = Math.max(1, host.rows - 1 - strip);
  const pty = { cols: Math.max(1, host.cols), rows: ptyRows };

  if (!panelOpen) {
    return { host, pty, origin: { row: 0, col: 0 }, panel: { mode: 'hidden', rect: null } };
  }

  return {
    host,
    pty,
    origin: { row: 0, col: 0 },
    panel: {
      mode: 'docked',
      rect: { row: ptyRows, col: 0, rows: Math.max(1, host.rows - ptyRows), cols: host.cols },
    },
  };
}
