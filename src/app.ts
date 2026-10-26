import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import type { LanguageModel, ModelMessage } from 'ai';

import { displayTokens, escapeControl, parseKeys } from './agent/keys.js';
import { runTask } from './agent/loop.js';
import type { AgentEvent, Decision } from './agent/loop.js';
import { createModel, keyHint, redact } from './agent/model.js';
import type { ModelResult } from './agent/model.js';
import { suggestCommand, explainError } from './agent/oneshot.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { snapText } from './agent/tools.js';
import type { ToolContext } from './agent/tools.js';
import { BlockStore } from './blocks/store.js';
import { copyText } from './clipboard.js';
import { colorSgr, configPath, loadConfig as readConfigFile } from './config.js';
import type { Config, LoadResult } from './config.js';
import { initialUi, reduce } from './focus.js';
import type { Action } from './focus.js';
import { reduceHash, stripControl } from './hash.js';
import type { HashState } from './hash.js';
import { ENTER_HOST, installRestore } from './host.js';
import type { InputEvent } from './input/tokenize.js';
import { InputTokenizer } from './input/tokenize.js';
import { routeToPty } from './input/route.js';
import { computeLayout } from './layout.js';
import type { Size } from './layout.js';
import {
  extendSelection,
  highlight,
  paneAt,
  selectedText,
  startSelection,
} from './mouse-select.js';
import type { MouseSelection } from './mouse-select.js';
import { renderDiff } from './render/diff.js';
import { FOOTER, composeFrame } from './render/frame.js';
import type { Frame } from './render/frame.js';
import { gitBranch, headerText } from './render/header.js';
import { drawHelp } from './render/help.js';
import { drawPanel } from './render/panel.js';
import type { CardView, Transcript } from './render/panel.js';
import { createFrameScheduler, createRunningTicker } from './render/schedule.js';
import { rtlMode } from './rtl-mode.js';
import { moveSelection, selectionKey } from './selection.js';
import type { SelectionKey } from './selection.js';
import { shellName } from './shell.js';
import type { ShellChoice } from './shell.js';
import { inject } from './shellint/inject.js';
import { hostModeDiff, hostModesFrom, trackModes } from './term/modes.js';
import type { HostModes } from './term/modes.js';
import { spawnSession } from './term/session.js';
import type { TerminalSession } from './term/session.js';

const CONFIG_HINT = 'Run `blockterm setup` to choose a model';
const APPROVAL_QUIET_MS = 400;
const APPROVE_KEYS = new Set(['y', 'a', 'e', '\r']);
const SELECTION_HINT = 'c copy · o output · r rerun · e explain · Esc back';

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
  copy?: (text: string) => void;
  rtl?: boolean;
}): Promise<number> {
  const { shell, stdin, stdout } = o;
  const copy = o.copy ?? ((text: string): void => copyText(text, { writeHost: s => stdout.write(s) }));
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
    const agentColor = colorSgr(config?.agentColor ?? null);
    const rtl = o.rtl ?? rtlMode(config?.rtl, process.env, process.platform).on;
    const mode = shellName(shell.file);
    let model: LanguageModel | null = null;
    let modelLabel: string | undefined = config?.model;
    let missingKeyEnv: string | null = null;

    let ui = initialUi();
    let hash: HashState | null = null;
    let hashController: AbortController | null = null;
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
    let agentScroll = 0;
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
    let selected: number | null = null;
    let mouseSel: MouseSelection | null = null;
    let dragging = false;
    let revealSelected = false;
    let selectionNotice: string | null = null;
    let selectionNoticeTimer: ReturnType<typeof setTimeout> | null = null;
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

    const hashView = (): { text: string; cursor: boolean } | null => {
      if (hash === null) return null;
      if (hash.status === 'editing') return { text: `# ${hash.input}`, cursor: true };
      if (hash.status === 'busy') return { text: `# ${hash.input}  …`, cursor: false };
      return { text: `# ${hash.input}  ${stripControl(hash.status.error)}`, cursor: false };
    };

    const render = (): void => {
      if (stopped || resizePending) return;
      ticker.sync(store.running !== null);
      const trackedModes = tracked.get();
      const status = statusText();
      const footerStatus =
        selectionNotice !== null && (status === '' || status === 'agent busy')
          ? selectionNotice
          : status !== ''
            ? status
            : selected !== null
              ? SELECTION_HINT
              : scroll > 0 && newOutput
                ? '↓ new output'
                : '';
      const frame = composeFrame(
        session.mirror,
        layout,
        {
          mode,
          title: headerText({
            folder: store.cwd,
            home: homedir(),
            branch,
            model: modelLabel ?? null,
          }),
          footer: selected !== null && status === '' ? '' : FOOTER,
          footerStatus,
          view: session.view,
          blocks: { store, scroll, hash: hashView(), selected },
          rtl,
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
      if (revealSelected) {
        revealSelected = false;
        if (
          selected !== null &&
          frame.blockRows !== undefined &&
          frame.blocksDocHeight !== undefined
        ) {
          const row = frame.blockRows.find(block => block.id === selected);
          if (row !== undefined) {
            const viewport = layout.pty.rows;
            const max = Math.max(0, frame.blocksDocHeight - viewport);
            const current = Math.min(Math.max(0, Math.floor(scroll)), max);
            let next = current;
            if (row.height >= viewport) {
              next = frame.blocksDocHeight - viewport - row.top;
            } else {
              const viewStart = Math.max(0, frame.blocksDocHeight - viewport - current);
              const viewEnd = viewStart + viewport;
              if (row.top < viewStart) {
                next = frame.blocksDocHeight - viewport - row.top;
              } else if (row.top + row.height > viewEnd) {
                next = frame.blocksDocHeight - row.top - row.height;
              }
            }
            next = Math.max(0, Math.min(max, next));
            if (next !== scroll) {
              scroll = next;
              requestRender();
            }
          }
        }
      }
      if (layout.panel.rect !== null) {
        const panel = drawPanel(
          frame.cells,
          frame.cols,
          layout.panel.rect,
          { ...ui, model: modelLabel, color: agentColor, status: footerStatus, scroll: agentScroll },
          transcript,
          card,
        );
        agentScroll = panel.scroll;
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
      if (mouseSel !== null && ui.help !== true) highlight(frame, mouseSel);
      if (ui.help === true) {
        drawHelp(frame.cells, frame.cols, frame.rows);
        frame.cursor = { ...frame.cursor, visible: false };
        cardVisibleAt = null;
        inputVisibleAt = null;
      }
      const hostModes = hostModesFrom(session.mirror, trackedModes);
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

    const clearSelectionNotice = (): void => {
      selectionNotice = null;
      if (selectionNoticeTimer !== null) {
        clearTimeout(selectionNoticeTimer);
        selectionNoticeTimer = null;
      }
    };

    const showSelectionNotice = (text: string, ttlMs = 0): void => {
      if (selectionNoticeTimer !== null) {
        clearTimeout(selectionNoticeTimer);
        selectionNoticeTimer = null;
      }
      selectionNotice = text;
      if (ttlMs > 0) {
        selectionNoticeTimer = setTimeout(() => {
          selectionNoticeTimer = null;
          if (selectionNotice === text) {
            selectionNotice = null;
            requestRender();
          }
        }, ttlMs);
      }
    };

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
        event.type === 'bytes' &&
        event.data === '\x1b[1;5A' &&
        session.view === 'blocks' &&
        store.integrated &&
        ui.focus === 'terminal' &&
        hash === null &&
        store.blocks.length > 0
      ) {
        selected = moveSelection(
          store.blocks.map(block => block.id),
          selected,
          'prev',
        );
        revealSelected = selected !== null;
        clearSelectionNotice();
        requestRender();
        return;
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

      if (
        event.type === 'bytes' &&
        event.data === '#' &&
        session.view === 'blocks' &&
        store.integrated &&
        store.isIdlePrompt()
      ) {
        hash = { input: '', status: 'editing' };
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
      mouseSel = null;
      dragging = false;
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

    const ensureModel = ():
      | { ok: true; model: LanguageModel }
      | { ok: false; error: string; missingKeyEnv?: string } => {
      if (config === null) return { ok: false, error: CONFIG_HINT };
      let current = model;
      if (current === null) {
        if (sessionId === null) sessionId = randomUUID();
        const result = factory(config, sessionId);
        if (!result.ok) {
          missingKeyEnv = result.missingKeyEnv;
          return {
            ok: false,
            error: `Set ${result.missingKeyEnv}`,
            missingKeyEnv: result.missingKeyEnv,
          };
        }
        model = result.model;
        modelLabel = result.label;
        missingKeyEnv = null;
        current = result.model;
      }
      return { ok: true, model: current };
    };

    const submit = async (text: string): Promise<void> => {
      const ensured = ensureModel();
      if (!ensured.ok) {
        if (config === null) {
          if (!configNoticeShown) {
            configNoticeShown = true;
            transcript.push({ who: 'note', text: CONFIG_HINT });
          }
        } else {
          transcript.push({ who: 'error', text: ensured.error });
          if (ensured.missingKeyEnv !== undefined) {
            for (const line of keyHint(process.platform, ensured.missingKeyEnv)) {
              transcript.push({ who: 'note', text: line });
            }
          }
        }
        ui = { ...ui, mode: 'idle' };
        requestRender();
        return;
      }

      const activeModel = ensured.model;
      transcript.push({ who: 'you', text });
      agentScroll = 0;
      agentOpen = false;

      const controller = new AbortController();
      taskController = controller;
      const key =
        config === null || config.apiKeyEnv === ''
          ? ''
          : (process.env[config.apiKeyEnv] ?? '');
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
          model: activeModel,
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
                  ignored: false,
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

    const submitHash = async (request: string): Promise<void> => {
      if (hash === null) return;
      const controller = new AbortController();
      hashController?.abort();
      hashController = controller;
      const key =
        config === null || config.apiKeyEnv === ''
          ? ''
          : (process.env[config.apiKeyEnv] ?? '');

      try {
        const ensured = ensureModel();
        if (!ensured.ok) {
          if (!controller.signal.aborted && hash !== null) {
            hash = { ...hash, status: { error: ensured.error } };
            requestRender();
          }
          return;
        }

        const text = await suggestCommand({
          model: ensured.model,
          ctx: { os: process.platform, shell: shell.file, folder: store.cwd },
          request,
          signal: controller.signal,
        });

        if (controller.signal.aborted || hash === null) return;
        if (!store.isIdlePrompt()) {
          hash = { ...hash, status: { error: 'prompt changed — suggestion not typed' } };
          requestRender();
          return;
        }
        if (text === '') {
          hash = { ...hash, status: { error: 'no command suggested' } };
          requestRender();
          return;
        }

        session.write(text);
        scroll = 0;
        newOutput = false;
        hash = null;
        hashController = null;
        requestRender();
      } catch (error) {
        if (controller.signal.aborted || hash === null) return;
        hash = {
          ...hash,
          status: {
            error: redact(
              error instanceof Error ? error.message : String(error),
              key === '' ? [] : [key],
            ),
          },
        };
        requestRender();
      } finally {
        if (hashController === controller) hashController = null;
      }
    };

    const explainBlock = (blockId: number): void => {
      if (ui.mode === 'busy' || taskController !== null) return;
      const block = store.blocks.find(candidate => candidate.id === blockId);
      if (block === undefined) return;

      if (!ui.open) {
        ui = { ...ui, open: true, focus: 'panel' };
        applyLayout();
      } else {
        ui = { ...ui, focus: 'panel' };
      }
      transcript.push({
        who: 'note',
        text: `Explain error: $ ${block.command} (exit ${block.exitCode ?? '?'})`,
      });
      agentOpen = false;

      const ensured = ensureModel();
      if (!ensured.ok) {
        if (config === null) {
          configNoticeShown = true;
          transcript.push({ who: 'note', text: CONFIG_HINT });
        } else {
          transcript.push({ who: 'error', text: ensured.error });
          if (ensured.missingKeyEnv !== undefined) {
            for (const line of keyHint(process.platform, ensured.missingKeyEnv)) {
              transcript.push({ who: 'note', text: line });
            }
          }
        }
        ui = { ...ui, mode: 'idle' };
        requestRender();
        return;
      }

      const controller = new AbortController();
      taskController = controller;
      const key =
        config === null || config.apiKeyEnv === ''
          ? ''
          : (process.env[config.apiKeyEnv] ?? '');
      ui = { ...ui, mode: 'busy', card: null };
      requestRender();

      void (async (): Promise<void> => {
        try {
          const text = await explainError({
            model: ensured.model,
            ctx: { os: process.platform, shell: shell.file, folder: store.cwd },
            block,
            signal: controller.signal,
          });
          if (stopped) return;
          transcript.push({ who: 'agent', text });
        } catch (error) {
          if (stopped) return;
          if (controller.signal.aborted) {
            transcript.push({ who: 'note', text: 'cancelled' });
          } else {
            transcript.push({
              who: 'error',
              text: redact(error instanceof Error ? error.message : String(error), key === '' ? [] : [key]),
            });
          }
        } finally {
          if (taskController === controller) taskController = null;
          if (!stopped) {
            ui = { ...ui, mode: 'idle' };
            requestRender();
          }
        }
      })();
    };

    const selectionBlock = (): (typeof store.blocks)[number] | null => {
      if (selected === null) return null;
      return store.blocks.find(block => block.id === selected) ?? null;
    };

    const rerunSelected = (block: (typeof store.blocks)[number]): void => {
      if (!store.isIdlePrompt()) {
        showSelectionNotice('not at an idle prompt');
        return;
      }
      if (block.command.includes('\n') || block.command.includes('\r')) {
        if (!session.mirror.modes.bracketedPasteMode) {
          showSelectionNotice('multi-line rerun needs bracketed paste');
          return;
        }
        session.write(`\x1b[200~${block.command}\x1b[201~\r`);
      } else {
        session.write(`${block.command}\r`);
      }
      scroll = 0;
      newOutput = false;
      selected = null;
      revealSelected = false;
      clearSelectionNotice();
      requestRender();
    };

    const handleSelectionKey = (key: SelectionKey): void => {
      clearSelectionNotice();
      switch (key) {
        case 'prev':
        case 'next': {
          selected = moveSelection(
            store.blocks.map(block => block.id),
            selected,
            key,
          );
          revealSelected = selected !== null;
          break;
        }
        case 'copy-command':
        case 'copy-output': {
          const block = selectionBlock();
          if (block !== null) {
            copy(key === 'copy-command' ? block.command : snapText(block.lines).join('\n'));
            showSelectionNotice('copied', 2000);
          }
          break;
        }
        case 'rerun': {
          const block = selectionBlock();
          if (block !== null) rerunSelected(block);
          break;
        }
        case 'explain': {
          const block = selectionBlock();
          if (block !== null) {
            if (block.exitCode !== 0) {
              if (ui.mode !== 'busy' && taskController === null) {
                explainBlock(block.id);
                selected = null;
                revealSelected = false;
              }
            } else {
              showSelectionNotice('nothing to explain', 2000);
            }
          }
          break;
        }
        case 'exit':
          selected = null;
          revealSelected = false;
          break;
        case 'scroll-page-up':
          scrollBy(layout.pty.rows - 1);
          break;
        case 'scroll-page-down':
          scrollBy(-(layout.pty.rows - 1));
          break;
        case 'scroll-top':
          scrollBy(lastDocHeight);
          break;
        case 'scroll-bottom':
          scrollBy(-lastDocHeight);
          break;
        case null:
          break;
      }
      requestRender();
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
        case 'clear-chat':
          if (taskController !== null) {
            showSelectionNotice('Esc to cancel first', 2000);
            requestRender();
            break;
          }
          transcript.length = 0;
          history = [];
          sessionId = null;
          model = null;
          agentOpen = false;
          agentScroll = 0;
          transcript.push({ who: 'note', text: 'chat cleared' });
          requestRender();
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
      const enterApproves = ui.input === '' && c.ignored !== true;
      const approve = keys.some(
        ch => ch === 'y' || ch === 'a' || (ch === '\r' && enterApproves),
      );
      const seenAt = approve ? cardVisibleAt : cardDrawnAt;
      if (seenAt === null) return true;
      return now - seenAt < APPROVAL_QUIET_MS || quiet < APPROVAL_QUIET_MS;
    };

    // The wheel scrolls whichever area it is over; blockterm also asks for drag reports to select
    // in its panes. Other reports are dropped; a program that asked for the mouse itself gets them
    // in the shell area. With no tracking, a shell-area wheel emulates the host's alternate scroll.
    const wheelEvent = (event: Extract<InputEvent, { type: 'mouse' }>): boolean => {
      const wheel = event.button & ~(4 | 8 | 16);
      const step = wheel === 64 ? 3 : wheel === 65 ? -3 : 0;
      const rect = layout.panel.rect;
      if (rect !== null && event.row >= rect.row && event.row < rect.row + rect.rows) {
        if (step !== 0) {
          agentScroll = Math.max(0, agentScroll + step);
          requestRender();
        }
        return true;
      }
      if (session.mirror.modes.mouseTrackingMode !== 'none') return false;
      if (step !== 0) {
        if (session.view === 'blocks' && store.integrated) {
          scrollBy(step);
        } else if (ui.focus === 'panel') {
          return true;
        } else {
          const app = session.mirror.modes.applicationCursorKeysMode;
          const arrow =
            step > 0 ? (app ? '\x1bOA' : '\x1b[A') : app ? '\x1bOB' : '\x1b[B';
          session.write(arrow + arrow + arrow);
        }
      }
      return true;
    };

    const handleEvent = (event: InputEvent): void => {
      if (ui.help === true) {
        lastKeyAt = Date.now();
        if (
          event.type === 'help-key' ||
          event.type === 'agent-key' ||
          (event.type === 'bytes' && event.data === '\x1b')
        ) {
          const result = reduce(ui, event);
          ui = result.ui;
          for (const action of result.actions) runAction(action);
          requestRender();
        }
        return;
      }
      if (event.type === 'help-key') {
        lastKeyAt = Date.now();
        mouseSel = null;
        dragging = false;
        const result = reduce(ui, event);
        ui = result.ui;
        for (const action of result.actions) runAction(action);
        requestRender();
        return;
      }
      if (event.type === 'mouse') {
        // The wheel scrolls, as before. Left drags belong to blockterm in the agent strip and,
        // when the inner program did not ask for the mouse, in the shell.
        if ((event.button & 64) === 0) {
          const left = (event.button & 3) === 0;
          const moving = (event.button & 32) !== 0;
          const at = { row: event.row, col: event.col };
          if (event.action === 'press' && left && !moving) {
            const pane = paneAt(layout, event.row);
            if (!(pane === 'shell' && session.mirror.modes.mouseTrackingMode !== 'none')) {
              mouseSel = startSelection(layout, at);
              dragging = mouseSel !== null;
              requestRender();
              return;
            }
            if (mouseSel !== null) {
              mouseSel = null;
              dragging = false;
              requestRender();
            }
          } else if (event.action === 'motion' && left && dragging && mouseSel !== null) {
            mouseSel = extendSelection(mouseSel, layout, at);
            requestRender();
            return;
          } else if (event.action === 'release' && dragging && mouseSel !== null) {
            const sel = extendSelection(mouseSel, layout, at);
            mouseSel = sel.moved ? sel : null;
            dragging = false;
            if (sel.moved && lastFrame !== null) {
              const text = selectedText(lastFrame, sel);
              if (text !== '') {
                copy(text);
                showSelectionNotice(`copied ${Array.from(text).length} chars`, 2000);
              }
            }
            requestRender();
            return;
          }
        }
        if (wheelEvent(event)) return;
      }
      if (
        mouseSel !== null &&
        (event.type === 'bytes' ||
          event.type === 'paste' ||
          event.type === 'page-key' ||
          event.type === 'agent-key')
      ) {
        mouseSel = null;
        dragging = false;
        requestRender();
        if (event.type === 'bytes' && event.data === '\x1b') {
          lastKeyAt = Date.now();
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
        hash !== null &&
        (session.view !== 'blocks' || (hash.status === 'editing' && !store.isIdlePrompt()))
      ) {
        hashController?.abort();
        hashController = null;
        hash = null;
        requestRender();
      }
      if (
        hash !== null &&
        ui.focus === 'terminal' &&
        (event.type === 'bytes' || event.type === 'paste' || event.type === 'page-key')
      ) {
        const result = reduceHash(hash, event);
        hash = result.state;
        if (result.action?.type === 'submit') void submitHash(result.action.request);
        else if (result.action?.type === 'close') {
          hashController?.abort();
          hashController = null;
          hash = null;
        }
        requestRender();
        return;
      }
      if (selected !== null && ui.focus === 'terminal') {
        if (event.type === 'paste') {
          requestRender();
          return;
        }
        if (event.type === 'bytes') {
          handleSelectionKey(selectionKey(event.data));
          return;
        }
      }
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
      if (selected !== null && !store.blocks.some(block => block.id === selected)) {
        selected = null;
        revealSelected = false;
        clearSelectionNotice();
      }
      if (scroll > 0) newOutput = true;
      requestRender();
    });
    const parsed = session.onParsed(() => {
      if (selected !== null && session.view !== 'blocks') {
        selected = null;
        revealSelected = false;
        clearSelectionNotice();
      }
      if (scroll > 0) newOutput = true;
      requestRender();
    });
    stdin.on('data', onData);
    stdout.on('resize', onResize);
    scheduler.request();

    cleanup = (): void => {
      stopped = true;
      hashController?.abort();
      hashController = null;
      scheduler.dispose();
      ticker.dispose();
      if (inputTimer !== null) clearTimeout(inputTimer);
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      if (selectionNoticeTimer !== null) clearTimeout(selectionNoticeTimer);
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
