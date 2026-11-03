import { useCallback, useEffect, useState } from 'react';
import {
  CircleStop,
  Laptop,
  MonitorCog,
  MoveDownRight,
  OctagonX,
  RefreshCw,
  Server,
  Square,
} from 'lucide-react';
import type { RunInfo } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { duration } from './activity.ts';
import { folderName } from './paths.ts';
import { Modal } from './ui.tsx';

// How often the list is read anew while the page is open.
const refreshEvery = 2000;

const statusNames: Record<RunInfo['status'], string> = {
  running: '运行中',
  awaiting_approval: '等待审批',
  background: '等待后台任务',
  quota: '等待额度恢复',
};

// A force stop asked for and waiting for the user to confirm it.
type Kill = { run: RunInfo; toolId?: string; what: string };

// Everything running on the connected service, across sessions and devices, with the ways to stop it.
export default function RunsPanel({
  client,
  connected,
  supported,
  open,
}: {
  client: ProxyClient;
  connected: boolean;
  // The service knows the run manager's commands.
  supported: boolean;
  // Shows a run's session.
  open: (sessionId: string) => void;
}) {
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [kill, setKill] = useState<Kill | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const reply = await client.fetch({ type: 'runs.list' });
      setRuns(reply.runs);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '读取运行列表失败。');
    }
  }, [client]);

  useEffect(() => {
    if (!supported || !connected) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), refreshEvery);
    return () => window.clearInterval(timer);
  }, [supported, connected, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Runs one action against a run; `key` marks the button as busy meanwhile.
  async function act(key: string, done: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(done);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败。');
    } finally {
      setBusy('');
      void refresh();
    }
  }
  const target = (run: RunInfo) => ({ sessionId: run.sessionId, runId: run.runId });
  const stopRun = (run: RunInfo) =>
    act(`stop:${run.runId}`, `已请求停止“${run.title}”。`, () =>
      client.request({ type: 'run.cancel', ...target(run) }),
    );
  const stopTask = (run: RunInfo, taskId: string) =>
    act(`task:${taskId}`, '已请求停止这个任务。', () =>
      client.request({ type: 'run.task.stop', ...target(run), taskId }),
    );
  const background = (run: RunInfo, toolId: string) =>
    act(`background:${toolId}`, '已请求把命令转到后台。', () =>
      client.request({ type: 'run.task.background', ...target(run), toolId }),
    );
  const forceStop = ({ run, toolId }: Kill) =>
    act(
      `kill:${toolId ?? run.runId}`,
      toolId ? '已强制结束这条命令。' : `已强制停止“${run.title}”。`,
      () => client.request({ type: 'run.kill', ...target(run), ...(toolId ? { toolId } : {}) }),
    );
  const disabled = (_key: string) => !connected || !!busy;

  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand">运行管理</span>
        </div>
        <button
          type="button"
          className="side-action"
          disabled={!supported || !connected}
          onClick={() => void refresh()}
        >
          <RefreshCw />
          立即刷新
        </button>
        <nav className="session-list" aria-label="运行中的会话">
          <div className="list-heading">运行中</div>
          {runs?.length === 0 && <p className="project-empty">没有正在运行的任务</p>}
          {runs?.map((run) => (
            <button
              type="button"
              key={run.runId}
              className="runs-side-item"
              onClick={() =>
                document
                  .getElementById(`run-${run.runId}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              <strong>{run.title}</strong>
              <small>
                {statusNames[run.status]} · {duration(run.startedAt, now)}
              </small>
            </button>
          ))}
        </nav>
      </aside>
      <main className="workspace">
        <section className="page" aria-label="运行管理">
          <div className="page-body runs-page">
            <h1 className="page-title">运行管理</h1>
            <p className="muted runs-intro">
              这里列出服务端上所有正在运行的任务（所有会话和设备），每 2 秒自动刷新。“停止”会让
              Claude 正常结束；“强制停止”直接结束进程（SIGKILL），用于停止没有响应的命令。
            </p>
            {!supported ? (
              <p className="runs-empty" role="status">
                当前连接的服务端版本较旧，不支持运行管理。请先更新服务端。
              </p>
            ) : !connected ? (
              <p className="runs-empty" role="status">
                未连接服务端。
              </p>
            ) : (
              <>
                {error && (
                  <p className="error-text" role="alert">
                    {error}
                  </p>
                )}
                {notice && (
                  <p className="runs-notice" role="status">
                    {notice}
                  </p>
                )}
                {runs === null && <p className="muted">正在读取…</p>}
                {runs?.length === 0 && (
                  <p className="runs-empty" role="status">
                    当前没有正在运行的任务。
                  </p>
                )}
                {runs?.map((run) => (
                  <article
                    key={run.runId}
                    id={`run-${run.runId}`}
                    className="card run-card"
                    aria-label={`运行 ${run.title}`}
                  >
                    <header className="run-card-head">
                      <div className="run-card-title">
                        <button
                          type="button"
                          className="text-link"
                          title="打开会话"
                          onClick={() => open(run.sessionId)}
                        >
                          {run.title}
                        </button>
                        <span className={`run-status run-status-${run.status}`}>
                          {statusNames[run.status]}
                        </span>
                      </div>
                      <div className="run-card-actions">
                        <button
                          type="button"
                          className="button secondary"
                          disabled={disabled(`stop:${run.runId}`)}
                          onClick={() => void stopRun(run)}
                        >
                          <Square />
                          停止
                        </button>
                        <button
                          type="button"
                          className="button danger"
                          disabled={disabled(`kill:${run.runId}`)}
                          onClick={() => setKill({ run, what: `整个任务“${run.title}”` })}
                        >
                          <OctagonX />
                          强制停止
                        </button>
                      </div>
                    </header>
                    <p className="run-card-meta">
                      <span>
                        <Laptop aria-hidden="true" />
                        {run.device?.name ?? '服务端'}
                      </span>
                      <span title={run.projectPath}>{folderName(run.projectPath)}</span>
                      <span>已运行 {duration(run.startedAt, now)}</span>
                      {run.processes !== null && <span>{run.processes} 个进程</span>}
                      {run.queued > 0 && (
                        <span className="run-queued">{run.queued} 条消息等待处理</span>
                      )}
                      {run.queue > 0 && <span className="run-queued">队列中 {run.queue} 条</span>}
                    </p>
                    <h2 className="run-section">前台命令</h2>
                    {run.tools.length === 0 ? (
                      <p className="muted run-none">没有正在执行的命令</p>
                    ) : (
                      <ul className="run-items">
                        {run.tools.map((tool) => (
                          <li key={tool.toolId} className="run-item">
                            <div className="run-item-main">
                              <span className="run-item-name">
                                {tool.name}
                                <span className={`run-where ${tool.remote ? 'remote' : ''}`}>
                                  {tool.remote ? (
                                    <>
                                      <MonitorCog aria-hidden="true" />
                                      设备 / SSH
                                    </>
                                  ) : (
                                    <>
                                      <Server aria-hidden="true" />
                                      服务端
                                    </>
                                  )}
                                </span>
                                <span className="run-item-time">
                                  {duration(tool.startedAt, now)}
                                </span>
                              </span>
                              <code className="run-command">{tool.summary}</code>
                            </div>
                            <div className="run-item-actions">
                              {tool.name === 'Bash' && (
                                <button
                                  type="button"
                                  className="button secondary"
                                  disabled={disabled(`background:${tool.toolId}`)}
                                  onClick={() => void background(run, tool.toolId)}
                                >
                                  <MoveDownRight />
                                  转后台
                                </button>
                              )}
                              {tool.taskId && (
                                <button
                                  type="button"
                                  className="button secondary"
                                  title="让 Claude 结束这条命令，这一轮继续"
                                  disabled={disabled(`task:${tool.taskId}`)}
                                  onClick={() => void stopTask(run, tool.taskId!)}
                                >
                                  <CircleStop />
                                  停止
                                </button>
                              )}
                              <button
                                type="button"
                                className="button danger"
                                disabled={disabled(`kill:${tool.toolId}`)}
                                onClick={() =>
                                  setKill({
                                    run,
                                    toolId: tool.toolId,
                                    what: `命令“${tool.summary.split('\n')[0].slice(0, 80)}”`,
                                  })
                                }
                              >
                                <OctagonX />
                                强制停止
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {run.tasks.length > 0 && (
                      <>
                        <h2 className="run-section">后台任务</h2>
                        <ul className="run-items">
                          {run.tasks.map((task) => (
                            <li key={task.id} className="run-item">
                              <div className="run-item-main">
                                <span className="run-item-name">{task.kind}</span>
                                <code className="run-command">{task.description}</code>
                              </div>
                              <div className="run-item-actions">
                                <button
                                  type="button"
                                  className="button secondary"
                                  disabled={disabled(`task:${task.id}`)}
                                  onClick={() => void stopTask(run, task.id)}
                                >
                                  <CircleStop />
                                  停止
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </article>
                ))}
              </>
            )}
          </div>
        </section>
      </main>
      {kill && (
        <Modal title="强制停止" onClose={() => setKill(null)}>
          <p className="delete-question">强制结束{kill.what}？</p>
          <p className="muted">
            {kill.toolId
              ? '会直接结束这条命令的进程（SIGKILL），Claude 会收到命令失败的结果并继续。'
              : '会直接结束这个任务的所有进程（SIGKILL），未保存的输出会丢失。'}
          </p>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={() => setKill(null)}>
              取消
            </button>
            <button
              type="button"
              className="button danger"
              disabled={!connected}
              onClick={() => {
                const chosen = kill;
                setKill(null);
                void forceStop(chosen);
              }}
            >
              <OctagonX />
              强制停止
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
