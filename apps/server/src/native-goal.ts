import type { SDKMessage, Query } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload, SessionGoal } from '@cc-desk-tunnel/protocol';
import { goalSchema } from '@cc-desk-tunnel/protocol';
import type { NativeInput } from './native-input.ts';
import { DomainError } from './errors.ts';
import { z } from 'zod';

export function goalCommand(text: string) {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1]?.trim() ?? '') : undefined;
}
const clears = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);
export const setsGoal = (args: string | undefined): args is string =>
  !!args && !clears.has(args.toLowerCase());

// Only CLI local-command provenance counts as an acknowledgement. Model text, tool output,
// subagent replies and a bare "Goal set" sentence are never evidence that a Stop hook exists.
const localFrame = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  content: z.string().optional(),
  parent_tool_use_id: z.string().nullable().optional(),
  local_command_source: z.string().optional(),
  local_command_run: z.object({ command: z.string(), args: z.string() }).optional(),
  message: z
    .object({
      model: z.string().optional(),
      content: z.array(
        z.object({
          type: z.string(),
          text: z.string().optional(),
        }),
      ),
    })
    .optional(),
});
const activeGoalFrame = z.object({
  type: z.literal('active_goal'),
  value: z
    .object({ condition: z.string(), iterations: z.number(), last_reason: z.string().optional() })
    .nullable(),
  parent_tool_use_id: z.null().optional(),
});
export function goalReply(
  value: unknown,
  probe?: string,
): { args: string; text: string } | undefined {
  const parsed = localFrame.safeParse(value);
  if (!parsed.success) return;
  const frame = parsed.data;
  if (frame.parent_tool_use_id) return;
  if (frame.type === 'system' && frame.subtype === 'local_command_output' && probe !== undefined)
    return { args: probe, text: String(frame.content ?? '').trim() };
  if (
    frame.type !== 'assistant' ||
    frame.local_command_run?.command !== 'goal' ||
    frame.message?.model !== '<synthetic>' ||
    typeof frame.local_command_source !== 'string' ||
    !frame.local_command_source.startsWith('<local-command-stdout>')
  )
    return;
  const text = frame.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (typeof text === 'string')
    return { args: String(frame.local_command_run.args ?? '').trim(), text };
}

export function goalStatus(text: string) {
  if (/^No goal set(?:\. Usage: `\/goal <condition>`)?$/.test(text)) return null;
  const match =
    /^Goal active: ([\s\S]*) \((not yet evaluated|\d+ turns?)\)(?:\nLast check: ([\s\S]*))?$/.exec(
      text,
    );
  if (!match)
    throw new DomainError('goal_unconfirmed', '未能确认原生目标状态，请检查 CLI 版本后继续。');
  return {
    condition: match[1],
    iterations: match[2] === 'not yet evaluated' ? 0 : parseInt(match[2]),
    ...(match[3] ? { lastReason: match[3].slice(0, 8000) } : {}),
  };
}

export class NativeGoal {
  value?: SessionGoal;
  private emit: (event: EventPayload) => void;
  constructor(goal: SessionGoal | undefined, emit: (event: EventPayload) => void) {
    this.value = goal;
    this.emit = emit;
  }
  update(value: Omit<SessionGoal, 'updatedAt'>) {
    const goal = goalSchema.parse({ ...value, updatedAt: new Date().toISOString() });
    this.value = goal;
    this.emit({ type: 'native.goal', goal });
  }
  status(status: SessionGoal['status']) {
    if (this.value) this.update({ ...this.value, status });
  }
  observe(message: SDKMessage, restoring?: string) {
    const type: string = message.type;
    if (
      type !== 'active_goal' &&
      message.type !== 'assistant' &&
      !(message.type === 'system' && message.subtype === 'local_command_output')
    )
      return;
    const reply = goalReply(message);
    if (reply && reply.args && reply.text === `Goal set: ${reply.args}`) {
      if (restoring && reply.args !== restoring) return;
      this.update({
        ...(restoring === reply.args ? this.value : undefined),
        condition: reply.args,
        status: 'active',
        iterations: restoring === reply.args ? (this.value?.iterations ?? 0) : 0,
      });
      return reply.args;
    }
    if (
      reply &&
      clears.has(reply.args.toLowerCase()) &&
      (reply.text.startsWith('Goal cleared: ') || reply.text === 'No goal set')
    )
      this.status('cleared');
    if (reply?.args === '') {
      const saved = goalStatus(reply.text);
      if (!saved) this.status('finished');
      else this.update({ ...this.value, ...saved, status: 'active' });
    }
    const frame = activeGoalFrame.safeParse(message);
    if (frame.success) {
      if (frame.data.value === null && !restoring && this.value?.status === 'active')
        this.status('finished');
      else if (frame.data.value) {
        if (restoring && frame.data.value.condition !== restoring) return;
        const parsed = goalSchema.safeParse({
          condition: frame.data.value.condition,
          status: 'active',
          iterations: frame.data.value.iterations,
          lastReason: frame.data.value.last_reason?.slice(0, 8000),
          updatedAt: new Date().toISOString(),
        });
        if (parsed.success) {
          this.update(parsed.data);
          return parsed.data.condition;
        }
      }
    }
  }
}

// Consumes only a local command while the native process is idle. No model call, transcript
// download or second process is needed. The regular input gate stays closed until confirmed.
export async function probeGoal(
  session: Query,
  messages: AsyncIterator<SDKMessage>,
  input: NativeInput,
  clear = false,
) {
  input.hold();
  const id = input.control(clear ? '/goal clear' : '/goal');
  let reply: string | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    session.close();
  }, 15_000);
  try {
    while (true) {
      const next = await messages.next();
      if (next.done || timedOut) break;
      const frame = next.value;
      const local = goalReply(frame, clear ? 'clear' : '');
      if (local && local.args === (clear ? 'clear' : '')) reply = local.text;
      else if (frame.type === 'assistant' || frame.type === 'stream_event') break;
      if (frame.type === 'result') {
        if (frame.is_error || (frame.user_message_uuid && frame.user_message_uuid !== id)) break;
        if (reply === undefined) break;
        if (clear) {
          if (reply.startsWith('Goal cleared: ') || reply === 'No goal set') return null;
          break;
        }
        return goalStatus(reply);
      }
    }
    throw new DomainError(
      'goal_unconfirmed',
      '原生目标状态未确认，已暂停续跑；请检查 CLI 是否支持 /goal。',
    );
  } finally {
    clearTimeout(timer);
  }
}
