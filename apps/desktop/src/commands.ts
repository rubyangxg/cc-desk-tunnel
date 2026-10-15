import type { NativeCapabilities } from '@cc-desk-tunnel/protocol';

// A Claude Code command offered after "/" in the message box. It is sent as the message itself, as the CLI takes it.
export type SlashCommand = { name: string; description: string; argumentHint: string };

// Commands this window does with its own controls (compacting, the model and effort, approvals, the account, the
// title, settings), those that would put the CLI in another session than this one, and Claude Code's own for
// sessions its servers launch. They are for Claude Code's own terminal; the CLI also names the commands bound to
// its terminal, which the service leaves out already. Names starting with "__" are the CLI's internal ones.
const hidden = new Set([
  'compact',
  'model',
  'effort',
  'fast',
  'permissions',
  'login',
  'logout',
  'config',
  'autocompact',
  'rename',
  'clear',
  'resume',
  'exit',
  'quit',
  'workflow-launch-exec',
]);
// The everyday ones come first and are said in Chinese; the rest keep Claude Code's own words.
const everyday: Record<string, string> = {
  goal: '设置或查看任务目标',
  plan: '规划任务',
  review: '审查代码改动',
  'security-review': '检查当前分支改动里的安全问题',
  context: '查看上下文占用',
  usage: '查看用量与额度',
  init: '为项目写一份 CLAUDE.md',
};

// The commands whose name, or one of whose other names, starts with what follows the slash; then those that only
// contain it.
export function slashCommands(
  capabilities: NativeCapabilities | null,
  typed: string,
): SlashCommand[] {
  const query = typed.toLowerCase();
  const details =
    capabilities?.commandDetails ??
    (capabilities?.commands ?? []).map((name) => ({
      name,
      description: '',
      argumentHint: '',
      aliases: undefined,
    }));
  const order = Object.keys(everyday);
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : order.length);
  const found = details
    .filter(
      (command) =>
        !hidden.has(command.name) &&
        !command.name.startsWith('__') &&
        !capabilities?.terminalCommands?.includes(command.name),
    )
    .map((command) => {
      const names = [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
      const fit = names.some((name) => name.startsWith(query))
        ? 0
        : names.some((name) => name.includes(query))
          ? 1
          : -1;
      return { command, fit };
    })
    .filter(({ fit }) => fit >= 0);
  return found
    .sort(
      (a, b) =>
        a.fit - b.fit ||
        rank(a.command.name) - rank(b.command.name) ||
        a.command.name.localeCompare(b.command.name),
    )
    .map(({ command }) => ({
      name: command.name,
      description: everyday[command.name] ?? command.description,
      argumentHint: command.argumentHint,
    }));
}
