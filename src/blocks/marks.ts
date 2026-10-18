import type { IDisposable, IMarker, Terminal } from '@xterm/headless';

export type Mark =
  | { kind: 'prompt'; row: number }
  | { kind: 'command'; row: number; col: number }
  | { kind: 'output'; row: number; commandText: string }
  | { kind: 'done'; row: number; exitCode: number }
  | { kind: 'cwd'; path: string };

const OSC_133 = 133;
const OSC_7 = 7;

function absoluteRow(mirror: Terminal, marker: IMarker | null): number {
  if (marker && marker.line >= 0) return marker.line;
  const buffer = mirror.buffer.active;
  return buffer.baseY + buffer.cursorY;
}

function readText(
  mirror: Terminal,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const buffer = mirror.buffer.active;
  let text = '';
  for (let row = startRow; row <= endRow; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const from = row === startRow ? startCol : 0;
    const to = row === endRow ? endCol : undefined;
    text += line.translateToString(true, from, to);
  }
  return text;
}

function decodeCwd(data: string): string | null {
  if (!data.startsWith('file://')) return null;
  const rest = data.slice('file://'.length);
  const slash = rest.indexOf('/');
  const path = slash === -1 ? '' : rest.slice(slash);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

export function watchMarks(mirror: Terminal, onMark: (m: Mark) => void): IDisposable {
  let promptPending = false;
  let commandPending = false;
  let running = false;
  let commandMarker: IMarker | null = null;
  let commandCol = 0;

  const onOsc133 = (data: string): boolean => {
    if (data === 'A') {
      if (promptPending) return true;
      promptPending = true;
      commandPending = false;
      onMark({ kind: 'prompt', row: absoluteRow(mirror, mirror.registerMarker(0) ?? null) });
      return true;
    }

    if (data === 'B') {
      if (commandPending) return true;
      const buffer = mirror.buffer.active;
      commandCol = buffer.cursorX;
      commandMarker = mirror.registerMarker(0) ?? null;
      commandPending = true;
      promptPending = false;
      onMark({ kind: 'command', row: absoluteRow(mirror, commandMarker), col: commandCol });
      return true;
    }

    if (data === 'C') {
      const buffer = mirror.buffer.active;
      const startRow = absoluteRow(mirror, commandMarker);
      const commandText = readText(
        mirror,
        startRow,
        commandMarker ? commandCol : 0,
        buffer.baseY + buffer.cursorY,
        buffer.cursorX,
      ).trim();
      running = true;
      commandPending = false;
      promptPending = false;
      onMark({ kind: 'output', row: buffer.baseY + buffer.cursorY, commandText });
      return true;
    }

    if (data === 'D' || data.startsWith('D;')) {
      if (!running) return true;
      const parsed = data === 'D' ? 0 : Number.parseInt(data.slice(2), 10);
      running = false;
      commandPending = false;
      promptPending = false;
      const row = absoluteRow(mirror, mirror.registerMarker(0) ?? null);
      commandMarker = null;
      onMark({ kind: 'done', row, exitCode: Number.isNaN(parsed) ? 0 : parsed });
      return true;
    }

    return false;
  };

  const onOsc7 = (data: string): boolean => {
    const path = decodeCwd(data);
    if (path === null) return false;
    onMark({ kind: 'cwd', path });
    return true;
  };

  const handlers = [
    mirror.parser.registerOscHandler(OSC_133, onOsc133),
    mirror.parser.registerOscHandler(OSC_7, onOsc7),
  ];

  return {
    dispose: () => {
      for (const handler of handlers) handler.dispose();
    },
  };
}
