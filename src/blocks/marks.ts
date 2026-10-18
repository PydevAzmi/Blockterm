import type { IBufferLine, IDisposable, IMarker, Terminal } from '@xterm/headless';

export type Mark =
  | { kind: 'prompt'; row: number }
  | { kind: 'command'; row: number; col: number }
  | { kind: 'output'; row: number; commandText: string }
  | { kind: 'done'; row: number; exitCode: number }
  | { kind: 'cwd'; path: string };

const OSC_133 = 133;
const OSC_7 = 7;

function currentRow(mirror: Terminal): number {
  const buffer = mirror.buffer.active;
  return buffer.baseY + buffer.cursorY;
}

function markerRow(mirror: Terminal, marker: IMarker | null): number {
  return marker && marker.line >= 0 ? marker.line : currentRow(mirror);
}

function snapshotRow(mirror: Terminal): number {
  const marker = mirror.registerMarker(0);
  if (!marker) return currentRow(mirror);
  const row = marker.line;
  marker.dispose();
  return row;
}

function lastContentColumn(line: IBufferLine, from: number, limit: number): number {
  let end = Math.min(limit, line.length);
  while (end > from) {
    const cell = line.getCell(end - 1);
    if (cell && cell.getCode() !== 0) break;
    end--;
  }
  return end;
}

function rowText(line: IBufferLine, from: number): string {
  const end = lastContentColumn(line, from, line.length);
  return line.translateToString(false, from, end);
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
    if (row > startRow && !line.isWrapped) text += '\n';
    const from = row === startRow ? startCol : 0;
    text += row === endRow ? line.translateToString(true, from, endCol) : rowText(line, from);
  }
  return text;
}

function decodeCwd(data: string): string | null {
  if (!data.startsWith('file://')) return null;
  const rest = data.slice('file://'.length);
  const slash = rest.indexOf('/');
  const path = slash === -1 ? '' : rest.slice(slash);
  if (path === '') return null;
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

  const releaseCommand = (): void => {
    commandMarker?.dispose();
    commandMarker = null;
  };

  const onOsc133 = (data: string): boolean => {
    const semi = data.indexOf(';');
    const sub = semi === -1 ? data : data.slice(0, semi);
    const param = semi === -1 ? '' : data.slice(semi + 1);

    if (sub === 'A') {
      if (promptPending) return true;
      promptPending = true;
      commandPending = false;
      running = false;
      onMark({ kind: 'prompt', row: snapshotRow(mirror) });
      return true;
    }

    if (sub === 'B') {
      if (commandPending) return true;
      releaseCommand();
      commandCol = mirror.buffer.active.cursorX;
      commandMarker = mirror.registerMarker(0) ?? null;
      commandPending = true;
      promptPending = false;
      onMark({ kind: 'command', row: markerRow(mirror, commandMarker), col: commandCol });
      return true;
    }

    if (sub === 'C') {
      if (running) return true;
      const commandText = readText(
        mirror,
        markerRow(mirror, commandMarker),
        commandMarker ? commandCol : 0,
        currentRow(mirror),
        mirror.buffer.active.cursorX,
      ).trim();
      releaseCommand();
      running = true;
      commandPending = false;
      promptPending = false;
      onMark({ kind: 'output', row: currentRow(mirror), commandText });
      return true;
    }

    if (sub === 'D') {
      if (!running) return true;
      const parsed = param === '' ? 0 : Number.parseInt(param, 10);
      running = false;
      commandPending = false;
      promptPending = false;
      const row = snapshotRow(mirror);
      releaseCommand();
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
      releaseCommand();
    },
  };
}
