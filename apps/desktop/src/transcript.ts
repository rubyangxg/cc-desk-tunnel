import type { SessionEvent, TurnStats } from '@cc-desk-tunnel/protocol';

export type ToolState =
  | 'requested'
  | 'approval'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'denied'
  | 'failed'
  | 'unknown';
export type TranscriptItem =
  | {
      kind: 'user' | 'assistant' | 'thinking';
      id: string;
      runId: string;
      text: string;
      delivery?: string;
      // Stands for the "continue" button: there is no message of the user's to show, edit or copy.
      continued?: boolean;
      at: string;
      // A reply: when its last text arrived, which is when it was done (`at` is when it began).
      doneAt?: string;
    }
  | { kind: 'notice'; id: string; runId: string; text: string; error: boolean; at: string }
  | {
      kind: 'tool';
      id: string;
      runId: string;
      name: string;
      input: string;
      target: string;
      approvalId?: string;
      resolved: boolean;
      status: string;
      state: ToolState;
      at: string;
      // Set once the result arrived; a tool without it is still running or was left unfinished.
      endedAt?: string;
      output?: string;
      liveOutput?: string;
      elapsedSeconds?: number;
      exitCode?: number | null;
    };

export function transcript(events: SessionEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const byId = new Map<string, TranscriptItem>();
  const byApproval = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  function add(item: TranscriptItem) {
    items.push(item);
    byId.set(item.id, item);
  }
  for (const { runId, sequence, payload, createdAt: at } of events) {
    // What the "continue" button sent is no words of the user's: the turn it starts shows a mark for it.
    if (payload.type === 'message.user')
      add({
        kind: 'user',
        id: payload.messageId,
        runId,
        text: payload.continued ? '继续' : payload.text,
        ...(payload.continued ? { continued: true } : {}),
        at,
      });
    if (payload.type === 'message.delivery') {
      const item = byId.get(payload.messageId);
      if (item?.kind === 'user')
        item.delivery = {
          submitted: '已提交',
          queued: '等待原生处理',
          received: '原生已接收',
          not_sent: '未送达原生',
          unconfirmed: '接收未确认',
        }[payload.status];
    }
    if (payload.type === 'text.delta') {
      const existing = byId.get(payload.messageId);
      if (existing?.kind === 'assistant') {
        existing.text += payload.text;
        existing.doneAt = at;
      } else add({ kind: 'assistant', id: payload.messageId, runId, text: payload.text, at });
    }
    // Sessions recorded before summaries were requested hold thinking with nothing in it.
    if (payload.type === 'thinking.delta' && payload.text) {
      const id = `thinking-${payload.messageId}`;
      const existing = byId.get(id);
      if (existing?.kind === 'thinking') existing.text += payload.text;
      else add({ kind: 'thinking', id, runId, text: payload.text, at });
    }
    if (payload.type === 'tool.requested')
      add({
        kind: 'tool',
        id: payload.toolId,
        runId,
        name: payload.name,
        input: payload.input,
        target: payload.target,
        resolved: false,
        status: '已请求',
        state: 'requested',
        at,
      });
    if (payload.type === 'approval.requested') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.approvalId = payload.approvalId;
        tool.status = '等待审批';
        tool.state = 'approval';
        byApproval.set(payload.approvalId, tool);
      }
    }
    if (payload.type === 'tool.input' || payload.type === 'tool.input.delta') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool')
        tool.input =
          payload.type === 'tool.input'
            ? payload.input
            : (tool.input === '{}' ? '' : tool.input) + payload.text;
    }
    if (payload.type === 'approval.resolved') {
      const tool = byApproval.get(payload.approvalId);
      if (tool?.kind === 'tool') {
        tool.resolved = true;
        tool.status = payload.allowed ? '运行中' : '已拒绝';
        tool.state = payload.allowed ? 'running' : 'denied';
      }
    }
    if (payload.type === 'tool.result') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.resolved = true;
        tool.status = {
          completed: '已完成',
          cancelled: '已取消',
          denied: '已拒绝',
          failed: '失败',
          unknown: '结果未知',
        }[payload.status];
        tool.state = payload.status;
        tool.endedAt = at;
        tool.output = payload.output;
        tool.exitCode = payload.exitCode;
      }
    }
    if (payload.type === 'tool.output') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.liveOutput = (tool.liveOutput ?? '') + payload.text;
        tool.status = '运行中';
        tool.state = 'running';
      }
    }
    if (payload.type === 'tool.progress') {
      const tool = byId.get(payload.toolId);
      if (tool?.kind === 'tool') {
        tool.elapsedSeconds = payload.elapsedSeconds;
        tool.status = '运行中';
        tool.state = 'running';
      }
    }
    if (payload.type === 'native.notice' && !['null', 'requesting', 'idle'].includes(payload.text))
      items.push({
        kind: 'notice',
        id: `native-${sequence}`,
        runId,
        text: payload.text,
        error: false,
        at,
      });
    if (payload.type === 'native.compact')
      items.push({
        kind: 'notice',
        id: `compact-${sequence}`,
        runId,
        error: false,
        at,
        text: `原生上下文已压缩${payload.previousTokens === null ? '' : ` · 压缩前 ${payload.previousTokens.toLocaleString()} tokens`}`,
      });
    if (payload.type === 'run.error')
      items.push({
        kind: 'notice',
        id: `error-${sequence}`,
        runId,
        text: payload.message,
        error: true,
        at,
      });
    if (payload.type === 'run.status' && payload.status === 'cancelled')
      items.push({
        kind: 'notice',
        id: `status-${sequence}`,
        runId,
        text: payload.reason ?? '已停止',
        error: false,
        at,
      });
  }
  return items;
}

type Tool = Extract<TranscriptItem, { kind: 'tool' }>;
type Text = Extract<TranscriptItem, { kind: 'user' | 'assistant' | 'thinking' }>;
// What happened between two pieces of text the reader was shown: tools and thinking, folded into one line.
export type Work = { kind: 'work'; id: string; items: (Tool | Text)[] };
export type Step = Text | Work;
// One question and everything up to the next one. Once finished, only the question, the time taken and the
// answer stay in view; `steps` holds the rest.
export type Turn = {
  id: string;
  question?: Text;
  // The question was added while the previous one was still being worked on, inside the same run.
  joined?: boolean;
  steps: Step[];
  answer?: Text;
  notices: Extract<TranscriptItem, { kind: 'notice' }>[];
  startedAt: string;
  endedAt?: string;
  tools: number;
  // What the turn used, reported by the service a moment after it ended.
  stats?: TurnStats;
  // How the run that ended the turn ended, when it did not finish: stopped by the user, or failed.
  outcome?: 'cancelled' | 'failed';
};

export function conversation(events: SessionEvent[]): Turn[] {
  // A run that goes on only for its background tasks has finished its turn; the turn a task starts reopens it.
  const ended = new Map<string, string>();
  const endedHow = new Map<string, string>();
  // Each time a run stopped working, finished or not: a question put in later ends the turn at the last of them.
  const stops = new Map<string, string[]>();
  for (const { runId, createdAt, payload } of events)
    if (payload.type !== 'run.status') continue;
    else if (
      ['completed', 'cancelled', 'failed'].includes(payload.status) ||
      payload.waiting === 'background'
    ) {
      ended.set(runId, createdAt);
      endedHow.set(runId, payload.status);
      stops.set(runId, [...(stops.get(runId) ?? []), createdAt]);
    } else if (payload.status === 'running') {
      ended.delete(runId);
      endedHow.delete(runId);
    }
  // How the run ended, when it did not finish.
  const outcome = (runId: string) => {
    const how = endedHow.get(runId);
    return how === 'cancelled' || how === 'failed' ? how : undefined;
  };
  const turns: Turn[] = [];
  let runId = '';
  for (const item of transcript(events)) {
    let turn = turns.at(-1);
    if (!turn || item.kind === 'user') {
      const joined = !!turn && item.runId === runId;
      // The next question closes the turn before it. One put in while the same run goes on closes it where the run
      // last stopped working, or else at the question; how the run ends later belongs to the turn it ends in.
      if (turn && !turn.endedAt && joined) {
        const from = turn.startedAt;
        turn.endedAt = stops.get(runId)?.findLast((at) => at >= from && at <= item.at) ?? item.at;
      } else if (turn && !turn.endedAt) {
        turn.endedAt = ended.get(runId) ?? item.at;
        turn.outcome = outcome(runId);
      }
      turn = { id: item.id, joined, steps: [], notices: [], startedAt: item.at, tools: 0 };
      turns.push(turn);
    }
    runId = item.runId;
    if (item.kind === 'user') turn.question = item;
    else if (item.kind === 'notice') turn.notices.push(item);
    else if (item.kind === 'assistant') turn.steps.push(item);
    else {
      const last = turn.steps.at(-1);
      if (last?.kind === 'work') last.items.push(item);
      else turn.steps.push({ kind: 'work', id: item.id, items: [item] });
      if (item.kind === 'tool') turn.tools++;
    }
  }
  const last = turns.at(-1);
  if (last && !last.endedAt) {
    last.endedAt = ended.get(runId);
    if (last.endedAt) last.outcome = outcome(runId);
  }
  const answered = new Map(
    turns.flatMap((turn) => (turn.question ? [[turn.question.id, turn]] : [])),
  );
  // A page of history may start after the question a report belongs to.
  for (const { payload } of events) {
    const turn =
      payload.type === 'turn.stats' && payload.messageId && answered.get(payload.messageId);
    if (turn) turn.stats = payload as TurnStats;
  }
  for (const turn of turns) {
    if (!turn.endedAt) continue;
    const final = turn.steps.at(-1);
    if (final?.kind === 'assistant') turn.answer = turn.steps.pop() as Text;
  }
  return turns;
}
