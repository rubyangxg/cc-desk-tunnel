import type { SessionEvent, Session } from '@cc-desk-tunnel/protocol';
export type Line = {
  key: string;
  kind: 'user' | 'assistant' | 'notice' | 'error' | 'tool' | 'thinking';
  text: string;
  title?: string;
};
export function timeline(events: SessionEvent[]): Line[] {
  const lines: Line[] = [];
  for (const e of events) {
    const p = e.payload,
      key = `${e.runId}:${e.sequence}`;
    if (p.type === 'message.user')
      lines.push({ key, kind: 'user', text: p.continued ? '继续' : p.text });
    else if (p.type === 'text.delta' || p.type === 'thinking.delta') {
      const kind = p.type === 'text.delta' ? 'assistant' : 'thinking';
      const group = `${e.runId}:${p.messageId}:${kind}`;
      const last = lines.at(-1);
      if (last?.key === group) last.text += p.text;
      else lines.push({ key: group, kind, text: p.text });
    } else if (p.type === 'native.notice') lines.push({ key, kind: 'notice', text: p.text });
    else if (p.type === 'run.error') lines.push({ key, kind: 'error', text: p.message });
    else if (p.type === 'tool.requested')
      lines.push({ key, kind: 'tool', title: p.name, text: p.input });
    else if (p.type === 'tool.result')
      lines.push({ key, kind: 'tool', title: `工具结果 · ${p.status}`, text: p.output });
  }
  return lines;
}
export function approvals(events: SessionEvent[], session: Session) {
  if (!session.activeRun) return [];
  const run = events.filter((e) => e.runId === session.activeRun?.id);
  return run.flatMap((e) => {
    const p = e.payload;
    if (
      p.type !== 'approval.requested' ||
      run.some(
        (x) => x.payload.type === 'approval.resolved' && x.payload.approvalId === p.approvalId,
      )
    )
      return [];
    const tool = run.find(
      (x) => x.payload.type === 'tool.requested' && x.payload.toolId === p.toolId,
    )?.payload;
    const input = run.findLast(
      (x) => x.payload.type === 'tool.input' && x.payload.toolId === p.toolId,
    )?.payload;
    return [
      {
        id: p.approvalId,
        runId: e.runId,
        name: tool?.type === 'tool.requested' ? tool.name : '操作确认',
        input:
          input?.type === 'tool.input'
            ? input.input
            : tool?.type === 'tool.requested'
              ? tool.input
              : '',
      },
    ];
  });
}
export function remaining(at: number, now = Date.now()) {
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(s / 3600)
    .toString()
    .padStart(
      2,
      '0',
    )}:${Math.floor(s / 60) % 60 < 10 ? '0' : ''}${Math.floor(s / 60) % 60}:${(s % 60).toString().padStart(2, '0')}`;
}
