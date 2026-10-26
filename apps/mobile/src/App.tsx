import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  CirclePause,
  Clock3,
  Layers,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Square,
  Target,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from '../../desktop/src/client.ts';
import QuestionCard, { questionsOf } from '../../desktop/src/QuestionCard.tsx';
import { Controllers } from './controller.ts';
import { external, native, type Profile, type Setup } from './native.ts';
import { approvals, remaining, timeline } from './timeline.ts';

const controllers = new Controllers();
type Tab = 'sessions' | 'accounts' | 'settings';
const statusName = {
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
};
const runName: Record<string, string> = {
  running: '运行中',
  awaiting_approval: '待确认',
  completed: '已完成',
  cancelled: '已停止',
  failed: '失败',
  interrupted: '已中断',
};
export default function App() {
  useSyncExternalStore(controllers.subscribe, controllers.snapshot);
  const [setup, setSetup] = useState<Setup>();
  const [tab, setTab] = useState<Tab>('sessions');
  const [selected, setSelected] = useState<{ profileId: string; sessionId: string } | null>(null);
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  async function reload() {
    const next = await native<Setup>('profiles.list');
    setSetup(next);
    controllers.configure(next);
    return next;
  }
  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const resume = () => {
      if (!document.hidden) {
        for (const entry of controllers.entries.values()) entry.client.retryNow();
        void reload().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, []);
  const entries = [...controllers.entries.values()];
  const sessions = entries
    .flatMap(({ profile, client }) =>
      client.state.sessions.map((session) => ({ profile, client, session })),
    )
    .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
  const active = selected && controllers.entries.get(selected.profileId);
  const session = active?.client.state.sessions.find((s) => s.id === selected?.sessionId);
  const open = (profileId: string, sessionId: string) => {
    controllers.entries.get(profileId)?.client.select(sessionId);
    setSelected({ profileId, sessionId });
    setError('');
  };
  useEffect(() => {
    const back = () => {
      if (editing) setEditing(null);
      else if (newTask) setNewTask(false);
      else if (selected) setSelected(null);
      else void native('background');
    };
    window.addEventListener('mobile-back', back);
    return () => window.removeEventListener('mobile-back', back);
  }, [editing, newTask, selected]);
  const count = sessions.filter((s) => s.session.activeRun).length;
  return (
    <div className="app">
      <header className="topbar">
        {selected ? (
          <button className="icon" aria-label="返回会话列表" onClick={() => setSelected(null)}>
            <ArrowLeft />
          </button>
        ) : (
          <div className="brand-icon">
            <Layers size={22} />
          </div>
        )}
        <div className="heading">
          <h1>
            {selected
              ? (session?.title ?? '会话')
              : tab === 'sessions'
                ? '我的会话'
                : tab === 'accounts'
                  ? '账号与额度'
                  : '连接与设置'}
          </h1>
          <small>
            {selected
              ? (session?.device?.name ?? '正在读取')
              : tab === 'sessions'
                ? `${count} 个任务运行中`
                : 'CC Desk Tunnel · 手机版'}
          </small>
        </div>
        {!selected && tab === 'sessions' && (
          <button
            className="icon"
            aria-label="新建会话"
            onClick={() => setNewTask(true)}
            disabled={!entries.some((e) => e.client.state.status === 'connected')}
          >
            <Plus />
          </button>
        )}
      </header>
      {error && (
        <div className="banner error" role="alert">
          <span>{error}</span>
          <button className="icon" aria-label="关闭提示" onClick={() => setError('')}>
            <X />
          </button>
        </div>
      )}
      {selected && active && session ? (
        <Chat
          client={active.client}
          session={session}
          now={now}
          busy={busy}
          act={act}
          draft={drafts[`${selected.profileId}:${session.id}`] ?? ''}
          setDraft={(text) =>
            setDrafts((d) => ({ ...d, [`${selected.profileId}:${session.id}`]: text }))
          }
        />
      ) : selected ? (
        <div className="empty">
          {active?.client.state.status === 'connected' ? '此会话已不存在。' : '正在连接并读取会话…'}
        </div>
      ) : (
        <main className="content">
          {tab === 'sessions' && (
            <>
              {entries.length > 0 && (
                <>
                  <input
                    className="search"
                    placeholder="搜索会话或项目"
                    aria-label="搜索会话"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <div className="connection-strip">
                    {entries.map(({ profile, client }) => (
                      <span key={profile.id}>
                        <i className={client.state.status === 'connected' ? 'online' : ''} />
                        {profile.name}
                        {client.state.status !== 'connected' &&
                          ` · ${statusName[client.state.status]}`}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {sessions
                .filter(({ session }) =>
                  `${session.title} ${session.projectPath}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map(({ profile, client, session }) => (
                  <button
                    className="session-card"
                    key={`${profile.id}:${session.id}`}
                    onClick={() => open(profile.id, session.id)}
                  >
                    <div className="session-title">
                      <strong>{session.title}</strong>
                      <ChevronRight size={18} />
                    </div>
                    <div className="meta">
                      <span>{session.projectPath.split(/[\\/]/).filter(Boolean).at(-1)}</span>
                      <span>{session.device?.name ?? profile.name}</span>
                    </div>
                    <div className="session-footer">
                      <span className={session.activeRun ? 'badge accent' : 'badge'}>
                        {session.activeRun
                          ? client.state.pool?.quotaWaits?.some((w) => w.sessionId === session.id)
                            ? '等待额度'
                            : (runName[session.activeRun.status] ?? session.activeRun.status)
                          : '可继续'}
                      </span>
                      {session.goal?.status === 'active' && (
                        <span className="goal-label">
                          <Target size={14} />
                          目标进行中
                        </span>
                      )}
                      <small>{client.state.status === 'connected' ? profile.name : '重连中'}</small>
                    </div>
                  </button>
                ))}
              {!sessions.length && (
                <div className="empty">
                  <MessageSquare size={38} />
                  <h2>{entries.length ? '还没有会话' : '从手机接着做'}</h2>
                  <p>
                    {entries.length
                      ? '连接后自动显示电脑和服务器会话。'
                      : '添加已有服务器，随时查看进度、发消息和继续任务。'}
                  </p>
                  <button
                    className="primary"
                    onClick={() => {
                      setTab('settings');
                      setEditing('new');
                    }}
                  >
                    添加服务器
                  </button>
                </div>
              )}
            </>
          )}
          {tab === 'accounts' && (
            <>
              <div className="section-head">
                <span>
                  全部服务器 ·{' '}
                  {entries.reduce((n, e) => n + (e.client.state.pool?.accounts.length ?? 0), 0)}{' '}
                  个账号
                </span>
                <button
                  className="icon"
                  aria-label="刷新全部额度"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await Promise.all(
                        entries
                          .filter((e) => e.client.state.status === 'connected')
                          .map((e) => e.client.request({ type: 'pool.status', refresh: true })),
                      );
                    })
                  }
                >
                  <RefreshCw />
                </button>
              </div>
              {entries.map(({ profile, client }) => (
                <section key={profile.id} className="account-group">
                  <h2>
                    {profile.name}
                    <small>{statusName[client.state.status]}</small>
                  </h2>
                  {client.state.pool?.nextReset && (
                    <div className="reset">
                      <Clock3 size={16} />
                      最早重置 <b>{remaining(client.state.pool.nextReset.at, now)}</b>
                      {!!client.state.pool.quotaWaits?.length && (
                        <small>{client.state.pool.quotaWaits.length} 个任务等待</small>
                      )}
                    </div>
                  )}
                  {client.state.pool?.accounts.map((account) => (
                    <article className="card" key={account.id}>
                      <div className="section-head">
                        <strong>{account.name}</strong>
                        <span className="badge">
                          {!account.enabled
                            ? '未参与'
                            : account.error
                              ? '检测失败'
                              : (account.blockedUntil && account.blockedUntil > now) ||
                                  account.limits?.windows.some(
                                    (w) => w.utilization !== null && w.utilization >= 100,
                                  )
                                ? '等待重置'
                                : account.loggedIn
                                  ? '已登录'
                                  : '未登录'}
                        </span>
                      </div>
                      {account.email && account.email !== account.name && (
                        <small>{account.email}</small>
                      )}
                      {account.limits?.windows.map((w) => (
                        <div className="quota" key={w.name}>
                          <div>
                            <span>
                              {w.name === 'five_hour'
                                ? '5 小时额度'
                                : w.name === 'seven_day'
                                  ? '每周额度'
                                  : w.name}
                            </span>
                            <b>
                              {w.utilization === null
                                ? '—'
                                : `${Math.max(0, Math.round(100 - w.utilization))}%`}
                              <small>剩余</small>
                            </b>
                          </div>
                          <progress
                            max={100}
                            value={w.utilization === null ? 0 : Math.max(0, 100 - w.utilization)}
                          />
                          <div>
                            <small>
                              {w.resetsAt
                                ? `${remaining(Date.parse(w.resetsAt), now)} 后重置`
                                : '重置时间未知'}
                            </small>
                            <small>
                              等价 $
                              {account.usage?.find((u) => u.name === w.name)?.costUsd?.toFixed(2) ??
                                '—'}
                            </small>
                          </div>
                        </div>
                      ))}
                      {account.error && <p className="error-text">{account.error}</p>}
                    </article>
                  ))}
                  {!client.state.pool && (
                    <p className="hint">{client.state.error ?? '正在读取账号池…'}</p>
                  )}
                </section>
              ))}
            </>
          )}
          {tab === 'settings' && (
            <>
              <div className="section-head">
                <h2>我的服务器</h2>
                <button className="icon" aria-label="添加服务器" onClick={() => setEditing('new')}>
                  <Plus />
                </button>
              </div>
              {entries.map(({ profile, client }) => (
                <article className="card" key={profile.id}>
                  <div className="section-head">
                    <strong>{profile.name}</strong>
                    <span className="badge">{statusName[client.state.status]}</span>
                  </div>
                  <p className="url">{profile.url}</p>
                  {client.state.error && <p className="error-text">{client.state.error}</p>}
                  <div className="actions">
                    <button onClick={() => controllers.connect(profile.id)}>重新连接</button>
                    <button onClick={() => setEditing(profile)}>编辑</button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm(`移除“${profile.name}”的手机连接？电脑上的任务不会停止。`))
                          void act(async () => {
                            await native('profiles.remove', { id: profile.id });
                            await reload();
                          });
                      }}
                    >
                      移除
                    </button>
                  </div>
                </article>
              ))}
              <section className="card">
                <div className="section-head">
                  <div>
                    <strong>任务通知</strong>
                    <p className="hint">应用在线时提醒任务完成或需要确认。</p>
                  </div>
                  <input
                    aria-label="任务通知"
                    type="checkbox"
                    checked={setup?.notifications ?? false}
                    onChange={(e) =>
                      void act(async () => {
                        await native('notifications', { enabled: e.target.checked });
                        await reload();
                      })
                    }
                  />
                </div>
              </section>
              <p className="hint">
                手机用于远程控制。操作电脑项目时，电脑和桌面客户端需保持在线；退出手机不会停止任务。跨服务器调度由电脑端协调。
              </p>
              <p className="version">Android 0.4.31 · 支持服务端 0.4.30 及以上</p>
            </>
          )}
        </main>
      )}
      {!selected && (
        <nav className="bottom-nav" aria-label="主导航">
          {(
            [
              { key: 'sessions', label: '会话', Icon: MessageSquare },
              { key: 'accounts', label: '账号', Icon: Layers },
              { key: 'settings', label: '设置', Icon: Settings2 },
            ] as const
          ).map(({ key, label, Icon }) => (
            <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>
              <Icon size={22} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
      {editing && (
        <ConnectionForm
          value={editing}
          busy={busy}
          close={() => setEditing(null)}
          save={(value) =>
            void act(async () => {
              const saved = await native<Profile>('profiles.save', value);
              await reload();
              controllers.connect(saved.id);
              setEditing(null);
            })
          }
        />
      )}
      {newTask && (
        <NewSession
          entries={entries}
          sessions={sessions}
          busy={busy}
          close={() => setNewTask(false)}
          create={(profileId, sourceSessionId, title) =>
            void act(async () => {
              const client = controllers.entries.get(profileId)!.client;
              const result = await client.request(
                sourceSessionId
                  ? { type: 'session.create.remote', sourceSessionId, title }
                  : { type: 'server.session.create', title },
              );
              if (result.sessionId) {
                open(profileId, result.sessionId);
                setNewTask(false);
              }
            })
          }
        />
      )}
    </div>
  );
}
function Chat({
  client,
  session,
  busy,
  act,
  draft,
  setDraft,
  now,
}: {
  client: ProxyClient;
  session: Session;
  busy: boolean;
  act: (f: () => Promise<unknown>) => Promise<void>;
  draft: string;
  setDraft: (s: string) => void;
  now: number;
}) {
  const [mode, setMode] = useState<'direct' | 'queue'>('queue');
  const [goal, setGoal] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null),
    bottom = useRef(true);
  const events = client.shown(session.id),
    lines = timeline(events),
    history = client.state.history[session.id];
  const connected = client.state.status === 'connected';
  const pending = approvals(events, session);
  const queue = session.messageQueue;
  const last = lines.at(-1);
  useEffect(() => {
    bottom.current = true;
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [session.id]);
  useEffect(() => {
    if (bottom.current) box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [session.id, last?.text, lines.length, pending.length]);
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    await client.request({
      type: mode === 'queue' ? 'message.enqueue' : 'message.send',
      sessionId: session.id,
      text,
      scenario: 'chat',
    });
    setDraft('');
  };
  const wait = client.state.pool?.quotaWaits?.find((w) => w.sessionId === session.id);
  return (
    <>
      {!connected && (
        <div className="banner">
          {statusName[client.state.status]}，恢复后会补齐记录。
          <button onClick={() => client.retryNow()}>重试</button>
        </div>
      )}
      {client.state.error && (
        <div className="banner error">
          <span>{client.state.error}</span>
          <button
            className="icon"
            aria-label="关闭连接提示"
            onClick={() => client.update({ error: null })}
          >
            <X />
          </button>
        </div>
      )}
      {session.goal && ['active', 'paused'].includes(session.goal.status) && (
        <div className="goal-strip">
          <Target size={16} />
          <strong>{session.goal.status === 'active' ? '目标进行中' : '目标已暂停'}</strong>
          <span title={session.goal.condition}>{session.goal.condition}</span>
        </div>
      )}
      <div
        className="conversation"
        ref={box}
        onScroll={() => {
          const el = box.current!;
          bottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        {history?.hasEarlier && (
          <button
            className="load-earlier"
            disabled={history.loadingEarlier || busy || !connected}
            onClick={() =>
              void act(async () => {
                const before = box.current!.scrollHeight;
                await client.loadEarlier(session.id);
                requestAnimationFrame(() => {
                  if (box.current) box.current.scrollTop = box.current.scrollHeight - before;
                });
              })
            }
          >
            <ArrowUp size={16} />
            {history.loadingEarlier ? '加载中…' : '加载更早记录'}
          </button>
        )}
        {history?.loading && !lines.length && <p className="hint">正在读取会话…</p>}
        {lines.map((line, index) =>
          line.kind === 'tool' || line.kind === 'thinking' ? (
            <details className="tool" key={`${line.key}:${index}`}>
              <summary>{line.title ?? '思考'}</summary>
              <pre>{line.text}</pre>
            </details>
          ) : (
            <article className={`message ${line.kind}`} key={`${line.key}:${index}`}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        if (href) external(href);
                      }}
                    >
                      {children}
                    </a>
                  ),
                  img: ({ alt }) => <span>[图片：{alt ?? ''}]</span>,
                }}
              >
                {line.text}
              </ReactMarkdown>
            </article>
          ),
        )}
        {session.activeRun && (
          <div className="run-status">
            <i className="online" />
            {client.state.pool?.quotaWaits?.some((w) => w.sessionId === session.id)
              ? `等待额度${wait?.at ? ` · ${remaining(wait.at, now)}` : ''}`
              : (runName[session.activeRun.status] ?? '运行中')}
          </div>
        )}
        {pending.map((p) => (
          <section className="approval" key={p.id}>
            {questionsOf(p.input) ? (
              <QuestionCard
                key={p.id}
                questions={questionsOf(p.input)!}
                busy={busy || !connected}
                answer={(answers) =>
                  void act(() =>
                    client.request({
                      type: 'approval.reply',
                      sessionId: session.id,
                      runId: p.runId,
                      approvalId: p.id,
                      allowed: true,
                      answers,
                    }),
                  )
                }
                skip={() =>
                  void act(() =>
                    client.request({
                      type: 'approval.reply',
                      sessionId: session.id,
                      runId: p.runId,
                      approvalId: p.id,
                      allowed: false,
                    }),
                  )
                }
              />
            ) : (
              <>
                <strong>需要确认 · {p.name}</strong>
                <pre>{p.input || '请先查看电脑端的操作详情。'}</pre>
                <div className="actions">
                  <button
                    disabled={busy || !connected}
                    onClick={() =>
                      void act(() =>
                        client.request({
                          type: 'approval.reply',
                          sessionId: session.id,
                          runId: p.runId,
                          approvalId: p.id,
                          allowed: false,
                        }),
                      )
                    }
                  >
                    拒绝
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !connected || !p.input}
                    onClick={() =>
                      void act(() =>
                        client.request({
                          type: 'approval.reply',
                          sessionId: session.id,
                          runId: p.runId,
                          approvalId: p.id,
                          allowed: true,
                        }),
                      )
                    }
                  >
                    允许这次操作
                  </button>
                </div>
              </>
            )}
          </section>
        ))}
      </div>
      {queue?.items.length ? (
        <div className="queue">
          <div className="section-head">
            <strong>
              待发送 {queue.items.length}
              {queue.paused ? ' · 已暂停' : ''}
            </strong>
            <button
              className="icon"
              aria-label={queue.paused ? '恢复队列' : '暂停队列'}
              disabled={busy || !connected}
              onClick={() =>
                void act(() =>
                  client.request({
                    type: 'message.queue.pause',
                    sessionId: session.id,
                    paused: !queue.paused,
                  }),
                )
              }
            >
              {queue.paused ? <Send size={18} /> : <CirclePause size={18} />}
            </button>
          </div>
          {queue.reason && <small>{queue.reason}</small>}
          {queue.items.map((q) => (
            <div className="queue-item" key={q.id}>
              <span>{q.text}</span>
              <button
                className="icon"
                aria-label="移除排队消息"
                disabled={busy || !connected}
                onClick={() =>
                  void act(() =>
                    client.request({
                      type: 'message.queue.remove',
                      sessionId: session.id,
                      messageId: q.id,
                    }),
                  )
                }
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void act(send);
        }}
      >
        <textarea
          aria-label="消息"
          disabled={busy}
          placeholder="发消息，或输入 /goal 制定目标…"
          rows={3}
          maxLength={16000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="icon"
            aria-label="设置目标"
            disabled={!connected || busy || !!session.activeRun}
            onClick={() => setGoal(session.goal?.condition ?? '')}
          >
            <Target />
          </button>
          {session.activeRun ? (
            <button
              type="button"
              className="icon danger"
              aria-label="停止任务"
              disabled={!connected || busy}
              onClick={() =>
                void act(() =>
                  client.request({
                    type: 'run.cancel',
                    sessionId: session.id,
                    runId: session.activeRun!.id,
                  }),
                )
              }
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              type="button"
              disabled={!connected || busy}
              onClick={() =>
                void act(() => client.request({ type: 'run.continue', sessionId: session.id }))
              }
            >
              继续
            </button>
          )}
          <select
            aria-label="发送方式"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'queue' | 'direct')}
          >
            <option value="queue">排队发送</option>
            <option value="direct">直接发送</option>
          </select>
          <button
            className="send"
            aria-label="发送消息"
            type="submit"
            disabled={!connected || busy || !draft.trim()}
          >
            <ArrowUp />
          </button>
        </div>
      </form>
      {goal !== null && (
        <div className="overlay">
          <form
            className="sheet"
            aria-label="设置目标"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await client.request({
                  type: 'message.send',
                  sessionId: session.id,
                  text: `/goal ${goal.trim()}`,
                  scenario: 'chat',
                });
                setGoal(null);
              });
            }}
          >
            <div className="section-head">
              <h2>设置目标</h2>
              <button
                type="button"
                className="icon"
                aria-label="关闭目标设置"
                onClick={() => setGoal(null)}
              >
                <X />
              </button>
            </div>
            <textarea
              aria-label="目标条件"
              placeholder="描述目标和完成条件"
              value={goal}
              maxLength={4000}
              rows={5}
              onChange={(e) => setGoal(e.target.value)}
            />
            <button className="primary" disabled={!goal.trim() || busy}>
              开始执行
            </button>
          </form>
        </div>
      )}
    </>
  );
}
function ConnectionForm({
  value,
  busy,
  close,
  save,
}: {
  value: Profile | 'new';
  busy: boolean;
  close: () => void;
  save: (v: object) => void;
}) {
  const [name, setName] = useState(value === 'new' ? '' : value.name),
    [url, setUrl] = useState(value === 'new' ? '' : value.url),
    [pin, setPin] = useState(value === 'new' ? '' : value.fingerprint),
    [token, setToken] = useState('');
  return (
    <div className="overlay">
      <form
        className="sheet"
        aria-label="服务器连接"
        onSubmit={(e) => {
          e.preventDefault();
          save({ id: value === 'new' ? undefined : value.id, name, url, fingerprint: pin, token });
        }}
      >
        <div className="section-head">
          <h2>{value === 'new' ? '添加服务器' : '编辑连接'}</h2>
          <button className="icon" type="button" aria-label="关闭连接设置" onClick={close}>
            <X />
          </button>
        </div>
        <label>
          名称
          <input
            value={name}
            maxLength={80}
            required
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：我的服务器"
          />
        </label>
        <label>
          连接地址
          <input
            value={url}
            maxLength={2048}
            required
            type="url"
            autoCapitalize="none"
            onChange={(e) => setUrl(e.target.value)}
            placeholder="wss://服务器地址:8787/ws"
          />
        </label>
        <label>
          SHA256 证书指纹
          <input
            value={pin}
            maxLength={128}
            autoCapitalize="none"
            onChange={(e) => setPin(e.target.value)}
            placeholder="自签名证书填写桌面端相同指纹"
          />
        </label>
        <label>
          服务凭据
          <input
            value={token}
            maxLength={512}
            required={value === 'new'}
            type="password"
            autoComplete="off"
            onChange={(e) => setToken(e.target.value)}
            placeholder={value === 'new' ? 'PROXY_TOKEN' : '留空保留原凭据'}
          />
        </label>
        <p className="hint">使用电脑端已有的连接信息，不是 Claude 登录密码。</p>
        <button className="primary" disabled={busy}>
          保存并连接
        </button>
      </form>
    </div>
  );
}
function NewSession({
  entries,
  sessions,
  busy,
  close,
  create,
}: {
  entries: { profile: Profile; client: ProxyClient }[];
  sessions: { profile: Profile; client: ProxyClient; session: Session }[];
  busy: boolean;
  close: () => void;
  create: (id: string, source: string | null, title: string) => void;
}) {
  const options = sessions
    .filter(
      (s) =>
        s.client.state.status === 'connected' &&
        s.client.state.features.includes('remote-session-create'),
    )
    .filter(
      (s, i, all) =>
        all.findIndex(
          (x) =>
            x.profile.id === s.profile.id &&
            x.session.projectPath === s.session.projectPath &&
            x.session.device?.id === s.session.device?.id,
        ) === i,
    );
  const [title, setTitle] = useState('新任务'),
    [choice, setChoice] = useState(
      options[0]
        ? `project:${options[0].profile.id}:${options[0].session.id}`
        : (entries.find((e) => e.client.state.status === 'connected')?.profile.id ?? ''),
    );
  return (
    <div className="overlay">
      <form
        className="sheet"
        aria-label="新建会话"
        onSubmit={(e) => {
          e.preventDefault();
          const [kind, id, source] = choice.split(':');
          create(kind === 'project' ? id : choice, kind === 'project' ? source : null, title);
        }}
      >
        <div className="section-head">
          <h2>新建会话</h2>
          <button type="button" className="icon" aria-label="关闭新建会话" onClick={close}>
            <X />
          </button>
        </div>
        <label>
          项目
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {options.map(({ profile, session }) => (
              <option
                key={`${profile.id}:${session.id}`}
                value={`project:${profile.id}:${session.id}`}
              >
                {session.projectPath.split(/[\\/]/).at(-1)} · {session.device?.name}
              </option>
            ))}
            {entries
              .filter((e) => e.client.state.status === 'connected')
              .map((e) => (
                <option key={e.profile.id} value={e.profile.id}>
                  服务器工作区 · {e.profile.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          会话名称
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={120}
          />
        </label>
        <p className="hint">
          电脑项目需服务端 0.4.31，且项目电脑在线。服务器工作区中的命令在 VPS 上执行。
        </p>
        <button className="primary" disabled={busy || !choice}>
          创建
        </button>
      </form>
    </div>
  );
}
