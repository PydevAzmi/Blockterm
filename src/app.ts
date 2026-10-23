import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import type { LanguageModel, ModelMessage } from 'ai';

import { displayTokens, escapeControl, parseKeys } from './agent/keys.js';
import { runTask } from './agent/loop.js';
import type { AgentEvent, Decision } from './agent/loop.js';
import { createModel, keyHint, redact } from './agent/model.js';
import type { ModelResult } from './agent/model.js';
import { buildSystemPrompt } from './agent/prompt.js';
import type { ToolContext } from './agent/tools.js';
import { BlockStore } from './blocks/store.js';
import { configPath, loadConfig as readConfigFile } from './config.js';
import type { Config, LoadResult } from './config.js';
import { initialUi, reduce } from './focus.js';
import type { Action } from './focus.js';
import { ENTER_HOST, installRestore } from './host.js';
import type { InputEvent } from './input/tokenize.js';
import { InputTokenizer } from './input/tokenize.js';
import { routeToPty } from './input/route.js';
import { computeLayout } from './layout.js';
import type { Size } from './layout.js';
import { renderDiff } from './render/diff.js';
import { FOOTER, composeFrame } from './render/frame.js';
import type { Frame } from './render/frame.js';
import { gitBranch, headerText } from './render/header.js';
import { drawPanel } from './render/panel.js';
import type { CardView, Transcript } from './render/panel.js';
import { createFrameScheduler, createRunningTicker } from './render/schedule.js';
import type { ShellChoice } from './shell.js';
import { inject } from './shellint/inject.js';
import { hostModeDiff, hostModesFrom, trackModes } from './term/modes.js';
import type { HostModes } from './term/modes.js';
import { spawnSession } from './term/session.js';
import type { TerminalSession } from './term/session.js';

const CONFIG_HINT = 'Run `blockterm setup` to choose a model';
const APPROVAL_QUIET_MS = 400;
const APPROVE_KEYS = new Set(['y', 'a', 'e']);

export function cardTokens(keys: string): { kind: 'text' | 'key'; label: string }[] {
  const parsed = parseKeys(keys);
  if (parsed.ok) return displayTokens(parsed.tokens);
  return [{ kind: 'text', label: `invalid keys: ${escapeControl(parsed.message)}` }];
}

export async function runApp(o: {
  shell: ShellChoice;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  createSession?: (
    shell: ShellChoice,
    size: Size,
    env: Record<string, string | undefined>,
  ) => TerminalSession;
  loadConfig?: () => LoadResult;
  modelFactory?: (config: Config, sessionId?: string) => ModelResult;
}): Promise<number> {
  const { shell, stdin, stdout } = o;
  globalThis.AI_SDK_LOG_WARNINGS = false;
  const load = o.loadConfig ?? ((): LoadResult =>
    readConfigFile(configPath(process.platform, process.env, homedir())));
  const factory =
    o.modelFactory ??
    ((config: Config, sessionId?: string): ModelResult =>
      createModel(config, process.env, sessionId !== undefined ? { sessionId } : {}));

  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  const restore = installRestore(stdin, stdout);

  let cleanup = (): void => {};

  try {
    stdout.write(ENTER_HOST);

    const loaded = load();
    const config: Config | null = loaded.ok ? loaded.config : null;
    let model: LanguageModel | null = null;
    let modelLabel: string | undefined = config?.model;
    let missingKeyEnv: string | null = null;

    let ui = initialUi();
    const transcript: Transcript[] = [];
    let card: CardView | null = null;
    let cardVisibleAt: number | null = null;
    let cardDrawnAt: number | null = null;
    let inputVisibleAt: number | null = null;
    let lastKeyAt = Number.NEGATIVE_INFINITY;
    let pendingDecision: ((decision: Decision) => void) | null = null;
    let taskController: AbortController | null = null;
    let history: ModelMessage[] = [];
    let sessionId: string | null = null;
    let configNoticeShown = false;
    let agentOpen = false;
    let stopped = false;

    let layout = computeLayout({ cols: stdout.columns, rows: stdout.rows });
    const startSession = o.createSession ?? spawnSession;

    const sessionEnv: Record<string, string | undefined> = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'blockterm',
    };
    const injection = inject(shell, sessionEnv);
    let session: TerminalSession;
    try {
      session = startSession({ file: injection.file, args: injection.args }, layout.pty, {
        ...sessionEnv,
        ...injection.env,
      });
    } catch (err) {
      injection.cleanup();
      throw err;
    }
    const tracked = trackModes(session.mirror);
    const tokenizer = new InputTokenizer();
    const store = new BlockStore(session.mirror);

    let scroll = 0;
    let newOutput = false;
    let lastDocHeight = 0;
    let branch: string | null = null;
    let knownCwd: string | null = null;
    let lastBlockId = 0;

    let lastFrame: Frame | null = null;
    let lastHostModes: HostModes | null = null;
    let inputTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let resizePending = false;

    const statusText = (): string => {
      if (config === null) return 'run blockterm setup';
      if (missingKeyEnv !== null) return `set ${missingKeyEnv}`;
      if (card !== null) return 'approval pending (ctrl+k)';
      if (ui.mode === 'busy') return 'agent busy';
      return '';
    };

    const render = (): void => {
      if (stopped || resizePending) return;
      ticker.sync(store.running !== null);
      const trackedModes = tracked.get();
      const status = statusText();
      const footerStatus =
        status !== '' ? status : scroll > 0 && newOutput ? '↓ new output' : '';
      const frame = composeFrame(
        session.mirror,
        layout,
        {
          title: headerText({
            folder: store.cwd,
            home: homedir(),
            branch,
            model: modelLabel ?? null,
          }),
          footer: FOOTER,
          footerStatus,
          view: session.view,
          blocks: { store, scroll },
        },
        trackedModes.cursorVisible,
      );
      if (frame.blocksDocHeight !== undefined) {
        const height = frame.blocksDocHeight;
        const before = scroll;
        if (scroll > 0 && height > lastDocHeight) scroll += height - lastDocHeight;
        lastDocHeight = height;
        const max = Math.max(0, lastDocHeight - layout.pty.rows);
        if (scroll > max) scroll = max;
        if (scroll === 0) newOutput = false;
        if (scroll !== before) requestRender();
      }
      const overlay = layout.panel.mode === 'overlay';
      const drawPanelNow =
        layout.panel.mode !== 'hidden' && layout.panel.rect !== null && (!overlay || ui.focus === 'panel');
      if (drawPanelNow) {
        const panel = drawPanel(
          frame.cells,
          frame.cols,
          layout.panel.rect!,
          { ...ui, model: modelLabel },
          transcript,
          card,
        );
        if (card !== null) {
          const now = Date.now();
          if (cardDrawnAt === null) cardDrawnAt = now;
          if (panel.cardTruncated) cardVisibleAt = null;
          else if (cardVisibleAt === null) cardVisibleAt = now;
        } else {
          cardVisibleAt = null;
          cardDrawnAt = null;
        }
        const editingCard = ui.card !== null && (ui.card.editing || ui.card.denying);
        if (editingCard && !panel.inputTruncated) {
          if (inputVisibleAt === null) inputVisibleAt = Date.now();
        } else {
          inputVisibleAt = null;
        }
        if (ui.focus === 'panel' && panel.cursor !== null) {
          frame.cursor = { row: panel.cursor.row, col: panel.cursor.col, visible: true };
        }
        if (ui.card !== null && (ui.card.truncated ?? false) !== panel.cardTruncated) {
          ui = { ...ui, card: { ...ui.card, truncated: panel.cardTruncated } };
        }
        if ((ui.inputTruncated ?? false) !== panel.inputTruncated) {
          ui = { ...ui, inputTruncated: panel.inputTruncated };
        }
        if (ui.inputShown !== true) ui = { ...ui, inputShown: true };
      } else if (card !== null) {
        cardVisibleAt = null;
        cardDrawnAt = null;
        inputVisibleAt = null;
        if (ui.card !== null && ui.card.truncated !== true) {
          ui = { ...ui, card: { ...ui.card, truncated: true } };
        }
        if (ui.inputShown !== false) ui = { ...ui, inputShown: false };
      }
      const hostModes = hostModesFrom(
        session.mirror,
        trackedModes,
        session.view === 'blocks' && store.integrated,
      );
      const out = hostModeDiff(lastHostModes, hostModes) + renderDiff(lastFrame, frame);
      if (out !== '') stdout.write(out);
      lastHostModes = hostModes;
      lastFrame = frame;
    };

    const scheduler = createFrameScheduler(render, 16);
    const requestRender = (): void => {
      if (!stopped) scheduler.request();
    };
    const ticker = createRunningTicker(requestRender);

    const syncBranch = (): void => {
      branch = knownCwd === null ? null : gitBranch(knownCwd);
    };

    const syncCwd = (): void => {
      if (store.cwd === knownCwd) return;
      knownCwd = store.cwd;
      syncBranch();
    };

    const scrollBy = (delta: number): void => {
      const max = Math.max(0, lastDocHeight - layout.pty.rows);
      scroll = Math.max(0, Math.min(scroll + delta, max));
      if (scroll === 0) newOutput = false;
      requestRender();
    };

    const route = (event: InputEvent): void => {
      if (event.type === 'page-key' && session.view === 'blocks' && store.integrated) {
        scrollBy(event.direction === 'up' ? layout.pty.rows - 1 : -(layout.pty.rows - 1));
        return;
      }

      if (
        event.type === 'mouse' &&
        session.view === 'blocks' &&
        store.integrated &&
        session.mirror.modes.mouseTrackingMode === 'none'
      ) {
        const rect = layout.panel.rect;
        const overPanel =
          rect !== null &&
          event.row >= rect.row &&
          event.row < rect.row + rect.rows &&
          event.col >= rect.col &&
          event.col < rect.col + rect.cols;
        const x = event.col - layout.origin.col;
        const y = event.row - layout.origin.row;
        const inPty = x >= 0 && x < layout.pty.cols && y >= 0 && y < layout.pty.rows;
        if (!overPanel && inPty) {
          const wheel = event.button & ~(4 | 8 | 16);
          if (wheel === 64) scrollBy(3);
          else if (wheel === 65) scrollBy(-3);
          return;
        }
      }

      if (
        event.type === 'bytes' &&
        event.data === '\x0c' &&
        session.view === 'blocks' &&
        store.integrated &&
        store.isIdlePrompt()
      ) {
        store.clear();
        scroll = 0;
        newOutput = false;
        requestRender();
        return;
      }

      const out = routeToPty(event, {
        modes: session.mirror.modes,
        tracked: tracked.get(),
        layout,
      });
      if (out !== null) {
        session.write(out);
        if (event.type === 'bytes' || event.type === 'paste') {
          scroll = 0;
          newOutput = false;
        }
      }
    };

    const applyLayout = (): void => {
      const next = computeLayout({ cols: stdout.columns, rows: stdout.rows }, ui.open);
      const sizeChanged = next.pty.cols !== layout.pty.cols || next.pty.rows !== layout.pty.rows;
      layout = next;
      if (sizeChanged) session.resize(layout.pty);
      lastFrame = null;
      requestRender();
    };

    const decideCard = (decision: Decision): void => {
      const resolve = pendingDecision;
      pendingDecision = null;
      card = null;
      cardVisibleAt = null;
      cardDrawnAt = null;
      inputVisibleAt = null;
      if (resolve !== null) resolve(decision);
      requestRender();
    };

    const abortTask = (): void => {
      taskController?.abort();
    };

    const pushAgentText = (delta: string): void => {
      const last = transcript[transcript.length - 1];
      if (agentOpen && last !== undefined && last.who === 'agent') last.text += delta;
      else {
        transcript.push({ who: 'agent', text: delta });
        agentOpen = true;
      }
    };

    const handleAgentEvent = (event: AgentEvent): void => {
      switch (event.type) {
        case 'text':
          pushAgentText(event.delta);
          break;
        case 'tool':
          agentOpen = false;
          transcript.push({ who: 'tool', text: event.name });
          break;
        case 'sent':
          agentOpen = false;
          transcript.push({ who: 'note', text: `sent ${event.keys}${event.auto ? ' (auto)' : ''}` });
          break;
        case 'approval':
          agentOpen = false;
          break;
        case 'done':
          agentOpen = false;
          break;
        case 'cancelled':
          agentOpen = false;
          transcript.push({ who: 'note', text: 'cancelled' });
          break;
        case 'error':
          agentOpen = false;
          transcript.push({ who: 'error', text: event.message });
          transcript.push({ who: 'note', text: 'check your model with blockterm doctor' });
          break;
        case 'limit':
          agentOpen = false;
          transcript.push({ who: 'note', text: event.message });
          break;
      }
      requestRender();
    };

    const submit = async (text: string): Promise<void> => {
      if (config === null) {
        if (!configNoticeShown) {
          configNoticeShown = true;
          transcript.push({ who: 'note', text: CONFIG_HINT });
        }
        ui = { ...ui, mode: 'idle' };
        requestRender();
        return;
      }

      if (model === null) {
        if (sessionId === null) sessionId = randomUUID();
        const result = factory(config, sessionId);
        if (!result.ok) {
          missingKeyEnv = result.missingKeyEnv;
          transcript.push({ who: 'error', text: `Set ${result.missingKeyEnv}` });
          for (const line of keyHint(process.platform, result.missingKeyEnv)) {
            transcript.push({ who: 'note', text: line });
          }
          ui = { ...ui, mode: 'idle' };
          requestRender();
          return;
        }
        model = result.model;
        modelLabel = result.label;
        missingKeyEnv = null;
      }

      transcript.push({ who: 'you', text });
      agentOpen = false;

      const controller = new AbortController();
      taskController = controller;
      const key = config.apiKeyEnv === '' ? '' : (process.env[config.apiKeyEnv] ?? '');
      const ctx: ToolContext = {
        session,
        appCursor: () => session.mirror.modes.applicationCursorKeysMode,
        get blocks() {
          return store.integrated ? store : null;
        },
      };
      requestRender();

      try {
        history = await runTask({
          model,
          system: buildSystemPrompt({
            os: process.platform,
            shell: shell.file,
            cwd: process.cwd(),
            view: session.view,
            program: session.program,
          }),
          history,
          prompt: text,
          ctx,
          target: () => session.program,
          approve: (keys) =>
            new Promise<Decision>((resolve) => {
              pendingDecision = resolve;
              const tokens = cardTokens(keys);
              card = { target: session.program, tokens };
              cardVisibleAt = null;
              cardDrawnAt = null;
              inputVisibleAt = null;
              ui = {
                ...ui,
                input: '',
                inputShown: false,
                card: {
                  keys,
                  target: session.program,
                  editing: false,
                  denying: false,
                  truncated: true,
                },
              };
              requestRender();
            }),
          onEvent: handleAgentEvent,
          signal: controller.signal,
          secrets: key === '' ? [] : [key],
        });
      } finally {
        if (taskController === controller) taskController = null;
        card = null;
        cardVisibleAt = null;
        cardDrawnAt = null;
        inputVisibleAt = null;
        pendingDecision = null;
        if (!stopped) {
          ui = { ...ui, mode: 'idle', card: null };
          requestRender();
        }
      }
    };

    const runAction = (action: Action): void => {
      switch (action.type) {
        case 'to-pty':
          route(action.event);
          break;
        case 'layout-changed':
          applyLayout();
          break;
        case 'submit':
          void submit(action.text).catch((error: unknown) => {
            const key =
              config === null || config.apiKeyEnv === ''
                ? ''
                : (process.env[config.apiKeyEnv] ?? '');
            transcript.push({
              who: 'error',
              text: redact(error instanceof Error ? error.message : String(error), key === '' ? [] : [key]),
            });
            card = null;
            cardVisibleAt = null;
            cardDrawnAt = null;
            inputVisibleAt = null;
            pendingDecision = null;
            ui = { ...ui, mode: 'idle', card: null };
            requestRender();
          });
          break;
        case 'cancel-task':
          abortTask();
          break;
        case 'decide':
          decideCard(action.decision);
          break;
      }
    };

    const blocksApprove = (event: InputEvent, now: number, quiet: number): boolean => {
      if (event.type !== 'bytes') return false;
      if (ui.focus !== 'panel') return false;
      const c = ui.card;
      if (c === null) return false;

      if (c.editing) {
        if (!event.data.includes('\r')) return false;
        if (inputVisibleAt === null) return true;
        return now - inputVisibleAt < APPROVAL_QUIET_MS || quiet < APPROVAL_QUIET_MS;
      }
      if (c.denying) return false;

      const keys = [...event.data];
      if (!keys.some(ch => APPROVE_KEYS.has(ch))) return false;
      const approve = keys.some(ch => ch === 'y' || ch === 'a');
      const seenAt = approve ? cardVisibleAt : cardDrawnAt;
      if (seenAt === null) return true;
      return now - seenAt < APPROVAL_QUIET_MS || quiet < APPROVAL_QUIET_MS;
    };

    const handleEvent = (event: InputEvent): void => {
      if (event.type === 'mouse' && ui.focus === 'panel' && layout.panel.mode === 'overlay') {
        const rect = layout.panel.rect;
        if (
          rect !== null &&
          event.row >= rect.row &&
          event.row < rect.row + rect.rows &&
          event.col >= rect.col &&
          event.col < rect.col + rect.cols
        ) {
          return;
        }
      }
      const now = Date.now();
      const quiet = now - lastKeyAt;
      if (blocksApprove(event, now, quiet)) {
        lastKeyAt = now;
        return;
      }
      lastKeyAt = now;
      if (
        ui.card !== null &&
        (ui.card.editing || ui.card.denying) &&
        (event.type === 'paste' || (event.type === 'bytes' && !event.data.startsWith('\x1b')))
      ) {
        inputVisibleAt = null;
      }
      const result = reduce(ui, event);
      ui = result.ui;
      if (ui.open && config === null && !configNoticeShown) {
        configNoticeShown = true;
        transcript.push({ who: 'note', text: CONFIG_HINT });
      }
      for (const action of result.actions) runAction(action);
      requestRender();
    };

    const flushInput = (): void => {
      inputTimer = null;
      for (const event of tokenizer.flush()) handleEvent(event);
    };

    const onData = (chunk: string): void => {
      for (const event of tokenizer.push(chunk)) handleEvent(event);
      if (inputTimer !== null) clearTimeout(inputTimer);
      inputTimer = setTimeout(flushInput, 10);
    };

    const onResize = (): void => {
      resizePending = true;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        resizePending = false;
        applyLayout();
      }, 50);
    };

    store.onChange(() => {
      syncCwd();
      const newest = store.blocks.at(-1)?.id ?? lastBlockId;
      if (newest !== lastBlockId) syncBranch();
      lastBlockId = newest;
      if (scroll > 0) newOutput = true;
      requestRender();
    });
    const parsed = session.onParsed(() => {
      if (scroll > 0) newOutput = true;
      requestRender();
    });
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    scheduler.request();

    cleanup = (): void => {
      stopped = true;
      scheduler.dispose();
      ticker.dispose();
      if (inputTimer !== null) clearTimeout(inputTimer);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      stdin.off('data', onData);
      stdout.off('resize', onResize);
      parsed.dispose();
      tracked.dispose();
      store.dispose();
      session.dispose();
      injection.cleanup();
    };

    const exitCode = await new Promise<number>((resolve) => {
      session.onExit((code) => resolve(code));
    });

    abortTask();
    cleanup();
    restore();
    return exitCode;
  } catch (err) {
    cleanup();
    restore();
    throw err;
  }
}
