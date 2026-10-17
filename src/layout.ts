export interface Size {
  cols: number;
  rows: number;
}

export interface Layout {
  host: Size;
  pty: Size;
  origin: { row: number; col: number };
}

export function computeLayout(host: Size): Layout {
  return {
    host,
    pty: {
      cols: Math.max(1, host.cols - 4),
      rows: Math.max(1, host.rows - 3),
    },
    origin: { row: 1, col: 2 },
  };
}
