import type { NativeCapabilities } from '@cc-desk-tunnel/protocol';

const common: Record<string, string> = {
  goal: '设置或查看任务目标',
  compact: '压缩上下文',
  plan: '规划任务',
  review: '审查代码',
  init: '生成项目说明',
  context: '查看上下文占用',
  usage: '查看用量与额度',
  cost: '查看会话用量',
  help: '查看 Claude 帮助',
};
const terminalOnly = new Set(['exit', 'quit', 'terminal-setup', 'statusline', 'vim', 'theme']);
export type ComposerCommand = {
  name: string;
  description: string;
  argumentHint: string;
  action?: 'compact' | 'refresh';
};

export function composerCommands(capabilities: NativeCapabilities | null): ComposerCommand[] {
  const commands = new Map<string, ComposerCommand>();
  const details = capabilities?.commandDetails ?? [];
  const hidden = new Set([...terminalOnly, ...(capabilities?.terminalCommands ?? [])]);
  for (const raw of capabilities?.commands ?? []) {
    const name = raw.replace(/^\//, '');
    if (!name || hidden.has(name)) continue;
    const detail = details.find((item) => item.name === name);
    commands.set(name, {
      name,
      description: common[name] ?? detail?.description ?? 'Claude 命令',
      argumentHint: detail?.argumentHint ?? '',
    });
  }
  commands.set('compact', {
    name: 'compact',
    description: '压缩上下文',
    argumentHint: '',
    action: 'compact',
  });
  const order = Object.keys(common);
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
  return [...commands.values()].sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
  );
}
