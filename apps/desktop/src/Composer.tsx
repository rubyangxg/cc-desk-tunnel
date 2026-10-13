import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, GitBranch, Play, Plus, RefreshCw, Shrink, Square } from 'lucide-react';
import type {
  Effort,
  NativeCapabilities,
  NativeMetrics,
  NativeSession,
  PermissionMode,
  Session,
} from '@cc-desk-tunnel/protocol';
import ComposerControls from './ComposerControls.tsx';
import PermissionMenu from './PermissionMenu.tsx';
import { IconButton } from './ui.tsx';
import { composerCommands } from './commands.ts';
import type { ComposerCommand } from './commands.ts';
import type { MenuPosition } from './ui.tsx';

export type Scenario = 'chat' | 'tool' | 'question' | 'error';
// A draft that is only a slash and an optional command name opens the command menu.
const slashDraft = /^[/\\][^ \n]*$/;

// The branch the project's working tree is on, read from the project by the desktop; it is looked at again
// whenever the window comes back to the front or a run ends, the moments it may have changed.
function useBranch(path: string, running: boolean) {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!window.desktop) return;
    let current = true;
    const read = () =>
      void window.desktop!.gitBranch(path).then(
        (value) => current && setBranch(value),
        () => current && setBranch(null),
      );
    read();
    window.addEventListener('focus', read);
    return () => {
      current = false;
      window.removeEventListener('focus', read);
    };
  }, [path, running]);
  return branch;
}

export default function Composer({
  session,
  projectName,
  chooseProject,
  draft,
  setDraft,
  native,
  connected,
  busy,
  refreshing,
  canRefreshModels,
  ownsRun,
  inputDisabled,
  controlsDisabled,
  slashOpen,
  setSlashOpen,
  canCompact,
  scenario,
  setScenario,
  capabilities,
  nativeSession,
  metrics,
  send,
  resume,
  compact,
  refresh,
  configure,
  stop,
}: {
  session: Session;
  // Absent for a session that belongs to no project.
  projectName: string | null;
  // Opens the list of projects the session can be moved to; absent while it cannot be moved.
  chooseProject?: (position: MenuPosition) => void;
  draft: string;
  setDraft: (text: string) => void;
  native: boolean;
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  canRefreshModels: boolean;
  ownsRun: boolean;
  inputDisabled: boolean;
  controlsDisabled: boolean;
  slashOpen: boolean;
  setSlashOpen: (open: boolean) => void;
  canCompact: boolean;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  capabilities: NativeCapabilities | null;
  nativeSession: NativeSession | null;
  metrics: NativeMetrics | null;
  send: () => void;
  // Present when the session's last turn was stopped or cut off: takes it up again without a message.
  resume?: () => void;
  compact: () => void;
  refresh: () => void;
  configure: (values: {
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) => Promise<void>;
  stop: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const branch = useBranch(session.projectPath, !!session.activeRun);
  const [dropping, setDropping] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const commandQuery = draft.slice(1).toLowerCase();
  const commands: ComposerCommand[] = [
    ...composerCommands(capabilities).filter(
      (command) =>
        command.name.toLowerCase().includes(commandQuery) ||
        command.description.includes(commandQuery),
    ),
    { name: 'refresh', description: '刷新命令与额度', argumentHint: '', action: 'refresh' },
  ];
  useEffect(() => setCommandIndex(0), [draft, session.id]);
  const chosenIndex = Math.min(commandIndex, commands.length - 1);
  useEffect(() => {
    if (slashOpen)
      document.getElementById(`slash-command-${chosenIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [chosenIndex, slashOpen]);
  const commandDisabled = (command: ComposerCommand) =>
    command.action === 'compact'
      ? controlsDisabled || !canCompact
      : command.action === 'refresh'
        ? controlsDisabled || refreshing
        : inputDisabled;
  function chooseCommand(command: ComposerCommand, completeOnly = false) {
    if (commandDisabled(command)) return;
    setSlashOpen(false);
    if (command.action && (!completeOnly || command.action === 'refresh')) {
      if (command.action === 'compact') compact();
      else {
        setDraft('');
        refresh();
      }
    } else {
      setDraft(`/${command.name} `);
      input.current?.focus();
    }
  }
  function submitDraft() {
    if (native && /^[/\\]refresh\s*$/.test(draft)) {
      if (!controlsDisabled && !refreshing) {
        setDraft('');
        setSlashOpen(false);
        refresh();
      }
      return;
    }
    if (native && /^[/\\]compact\s*$/.test(draft)) {
      if (!controlsDisabled && canCompact) compact();
      return;
    }
    send();
  }
  useLayoutEffect(() => {
    // Grow with the draft; the stylesheet's max-height decides when scrolling takes over.
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${input.current.scrollHeight}px`;
  }, [draft, session.id]);
  // A file reaches Claude as its Windows path in the message: Claude reads it through the execution channel,
  // the same way it reads the project.
  function attach(paths: string[]) {
    if (!paths.length) return;
    const box = input.current;
    // The box holds what is typed right now; a picture is attached a moment after it was pasted.
    const current = box ? box.value : draft;
    const at = box ? box.selectionStart : current.length;
    const before = current.slice(0, at);
    const text = paths.map((path) => `"${path}"`).join(' ');
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    setDraft(`${before}${lead}${text} ${current.slice(at)}`);
    box?.focus();
  }
  const shown = useRef(session.id);
  shown.current = session.id;
  // Files copied in Explorer have a path. A picture that is only on the clipboard (a screenshot, an image
  // copied from a page) has none: the client saves it on this computer and its path is attached like any other.
  async function paste(files: File[]) {
    const pasted = session.id;
    const found: string[] = [];
    for (const file of files) {
      const path = window.desktop!.pathForFile(file);
      if (path) found.push(path);
      else if (file.type.startsWith('image/'))
        try {
          found.push(
            await window.desktop!.saveImage(file.type, new Uint8Array(await file.arrayBuffer())),
          );
        } catch {
          // A picture that could not be saved is left out; the rest is still attached.
        }
    }
    if (shown.current === pasted) attach(found);
  }
  return (
    <div className="composer-area">
      {native && slashOpen && (
        <div className="slash-menu" role="listbox" aria-label="会话命令" id="slash-commands">
          {commands.map((command, index) => (
            <button
              key={command.name}
              id={`slash-command-${index}`}
              type="button"
              role="option"
              aria-label={`/${command.name} · ${command.description}`}
              aria-selected={index === chosenIndex}
              disabled={commandDisabled(command)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseCommand(command)}
            >
              {command.action === 'compact' ? (
                <Shrink />
              ) : command.action === 'refresh' ? (
                <RefreshCw />
              ) : (
                <span className="slash-mark">/</span>
              )}
              <span>
                <strong>/{command.name}</strong>
                {command.argumentHint && <em> {command.argumentHint}</em>}
                <small>{command.description}</small>
              </span>
            </button>
          ))}
          {commands.length === 1 && commandQuery && (
            <p className="slash-empty">当前 Claude 未提供匹配命令</p>
          )}
        </div>
      )}
      <div className="composer-context">
        <button
          type="button"
          className="chip quiet"
          aria-label="会话所在的项目"
          aria-haspopup="menu"
          title={session.projectPath}
          disabled={!chooseProject}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            chooseProject!({ x: box.left, y: box.top - 6, above: true });
          }}
        >
          <Folder />
          <span>{projectName ?? '普通会话'}</span>
        </button>
        {branch && (
          <span className="chip quiet" title="项目当前所在的 git 分支">
            <GitBranch />
            <span>{branch}</span>
          </span>
        )}
      </div>
      <form
        className={`composer ${dropping ? 'dropping' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
        onDragOver={(event) => {
          if (!window.desktop || inputDisabled || !event.dataTransfer.types.includes('Files'))
            return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          if (!window.desktop || inputDisabled || !event.dataTransfer.files.length) return;
          event.preventDefault();
          void paste([...event.dataTransfer.files]);
        }}
      >
        <textarea
          ref={input}
          aria-label="消息"
          aria-controls={native && slashOpen ? 'slash-commands' : undefined}
          aria-expanded={native && slashOpen}
          aria-autocomplete="list"
          aria-activedescendant={native && slashOpen ? `slash-command-${chosenIndex}` : undefined}
          placeholder="随心输入…"
          value={draft}
          disabled={inputDisabled}
          maxLength={16000}
          rows={2}
          onChange={(event) => {
            setDraft(event.target.value);
            setSlashOpen(native && slashDraft.test(event.target.value));
          }}
          onPaste={(event) => {
            // Pasted text is left to the browser, also when a program put a picture of it beside the text.
            if (!window.desktop || !event.clipboardData.files.length) return;
            const files = [...event.clipboardData.files];
            const text = event.clipboardData.getData('text/plain');
            const usable = files.filter(
              (file) =>
                window.desktop!.pathForFile(file) || (!text && file.type.startsWith('image/')),
            );
            if (!usable.length) return;
            event.preventDefault();
            void paste(usable);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (native && slashOpen && ['ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) {
              event.preventDefault();
              if (event.key === 'Tab') chooseCommand(commands[chosenIndex], true);
              else
                setCommandIndex(
                  (chosenIndex + (event.key === 'ArrowDown' ? 1 : commands.length - 1)) %
                    commands.length,
                );
              return;
            }
            if (event.key === 'Escape') {
              setSlashOpen(false);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (
                native &&
                slashOpen &&
                (commandIndex > 0 ||
                  (commands.length > 1 &&
                    !commands.some((command) => command.name === commandQuery)))
              )
                chooseCommand(commands[chosenIndex]);
              else if (native && slashOpen && commandQuery === 'refresh')
                chooseCommand(commands.find((command) => command.action === 'refresh')!);
              else submitDraft();
            }
          }}
        />
        <div className="composer-toolbar">
          {window.desktop && (
            <IconButton
              title="添加文件：把文件的路径放进消息"
              className="attach-button"
              disabled={inputDisabled}
              onClick={() => void window.desktop!.chooseFiles().then(attach)}
            >
              <Plus />
            </IconButton>
          )}
          {!native ? (
            <label className="scenario-label">
              场景
              <select
                aria-label="模拟场景"
                value={scenario}
                onChange={(event) => setScenario(event.target.value as Scenario)}
                disabled={!!session.activeRun || busy}
              >
                <option value="chat">对话</option>
                <option value="tool">工具审批</option>
                <option value="question">提问</option>
                <option value="error">上游错误</option>
              </select>
            </label>
          ) : (
            <PermissionMenu
              mode={session.permissionMode}
              disabled={controlsDisabled}
              change={(permissionMode) => void configure({ permissionMode })}
            />
          )}
          <span className="toolbar-space" />
          {native && (
            <ComposerControls
              key={session.id}
              model={session.model}
              effort={session.effort}
              capabilities={capabilities}
              nativeSession={nativeSession}
              metrics={metrics}
              disabled={controlsDisabled}
              configure={configure}
              refresh={refresh}
              refreshing={refreshing}
              canRefreshModels={canRefreshModels}
            />
          )}
          {session.activeRun && session.activeRun.waiting !== 'background' && (
            <IconButton
              title="停止运行"
              className="stop-button"
              disabled={!connected || !ownsRun || busy}
              onClick={stop}
            >
              <Square />
            </IconButton>
          )}
          {resume && !draft.trim() ? (
            <IconButton title="接着上一轮继续" className="send-button" onClick={resume}>
              <Play />
            </IconButton>
          ) : (
            (!session.activeRun || native) && (
              <button
                type="submit"
                className="icon-button send-button"
                aria-label="发送消息"
                title="发送消息"
                disabled={!draft.trim() || inputDisabled}
              >
                <ArrowUp />
              </button>
            )
          )}
        </div>
      </form>
    </div>
  );
}
