import type { SessionEvent } from '@cc-desk-tunnel/protocol';

// Carry only user-visible conversation and execution progress. Reasoning and account credentials are
// never included. The original transcript remains in the unified proxy session.
export function poolHandoff(events: SessionEvent[]) {
  const recent: string[] = [];
  for (const { payload } of events) {
    if (payload.type === 'message.user') recent.push(`用户：${payload.text}`);
    else if (payload.type === 'text.delta') recent.push(`助手：${payload.text}`);
    else if (payload.type === 'tool.requested')
      recent.push(`工具 ${payload.toolId} ${payload.name}：${payload.input}`);
    else if (payload.type === 'tool.input')
      recent.push(`工具输入 ${payload.toolId}：${payload.input}`);
    else if (payload.type === 'tool.result')
      recent.push(`工具结果 ${payload.toolId} [${payload.status}]：${payload.output}`);
  }
  const last = events.findLast((event) => event.payload.type === 'message.user');
  return [
    '账号池续接：账号已切换，这是同一本机项目的新原生会话。以下是最近对话和任务进度摘录，不是完整原生上下文恢复。',
    '继续用户尚未完成的任务。先检查项目现状；已经完成的操作不要重复执行。未知或未确认的结果先核实。信息不足时询问用户。',
    `最近用户任务：${last?.payload.type === 'message.user' ? last.payload.text.slice(0, 2500) : '继续未完成的任务。'}`,
    `最近上下文：\n${recent.join('\n\n').slice(-10500)}`,
  ].join('\n\n');
}

export function canHandoff(events: SessionEvent[], runId: string) {
  const current = events.filter((event) => event.runId === runId);
  const background = current.findLast((event) => event.payload.type === 'native.tasks');
  if (background?.payload.type === 'native.tasks' && background.payload.tasks.length) return false;
  const tools = new Set<string>();
  for (const { payload } of current) {
    if (payload.type === 'tool.requested') tools.add(payload.toolId);
    if (payload.type === 'tool.result') {
      if (payload.status === 'unknown') return false;
      tools.delete(payload.toolId);
    }
  }
  // A supplemental message without a receipt must never be silently resent across accounts.
  const messages = current.filter((event) => event.payload.type === 'message.user');
  if (
    messages.length > 1 &&
    current.some(
      (event) =>
        event.payload.type === 'message.delivery' &&
        ['unconfirmed', 'not_sent'].includes(event.payload.status),
    )
  )
    return false;
  return tools.size === 0;
}
