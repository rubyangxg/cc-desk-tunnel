import { readFileSync, readdirSync } from 'node:fs';

// The CLI of a run carries this variable, and so does every process it starts: the run's processes are found by
// it even when one of them has left the process tree, as a command sent off to run on its own does.
export const RUN_MARKER = 'CC_DESK_RUN';

type Proc = { pid: number; ppid: number };

function processes(root = '/proc'): Proc[] {
  const list: Proc[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return list;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`${root}/${name}/stat`, 'utf8');
      // The command name in parentheses may hold spaces and parentheses of its own.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      list.push({ pid: Number(name), ppid: Number(fields[1]) });
    } catch {
      // Gone meanwhile.
    }
  }
  return list;
}

function read(pid: number, file: 'environ' | 'cmdline', root = '/proc') {
  try {
    return readFileSync(`${root}/${pid}/${file}`, 'utf8').split('\0');
  } catch {
    return undefined;
  }
}

function descendants(all: Proc[], roots: Iterable<number>) {
  const children = new Map<number, number[]>();
  for (const proc of all) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc.pid);
    children.set(proc.ppid, list);
  }
  const found = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop()!;
    if (found.has(pid)) continue;
    found.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return found;
}

// The processes of a run: those carrying its marker, and whatever they started. `null` where processes cannot be
// read, as on a system without /proc.
export function runProcesses(runId: string, root = '/proc'): number[] | null {
  const all = processes(root);
  if (!all.length) return null;
  const marked = all
    .filter((proc) => proc.pid !== process.pid)
    .filter((proc) => read(proc.pid, 'environ', root)?.includes(`${RUN_MARKER}=${runId}`))
    .map((proc) => proc.pid);
  return [...descendants(all, marked)];
}

// The processes of one command of a run: the innermost of its processes whose command line holds the command,
// with whatever it started.
export function commandProcesses(runId: string, command: string, root = '/proc'): number[] {
  const text = command.trim();
  if (!text) return [];
  const all = processes(root);
  const own = new Set(runProcesses(runId, root) ?? []);
  // The shell has the command quoted, its quotes escaped: every stretch of it without quotes is looked for, so that
  // of two commands to the same computer only the one meant matches.
  const parts = [
    ...new Set(
      text
        .split(/['"\\`\n]/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3),
    ),
  ].slice(0, 40);
  if (!parts.length) return [];
  const parent = new Map(all.map((proc) => [proc.pid, proc.ppid]));
  // The CLI itself, the root of the run, is never one command's.
  const matched = new Set(
    [...own].filter((pid) => {
      if (!own.has(parent.get(pid) ?? -1)) return false;
      const line = read(pid, 'cmdline', root)?.join(' ');
      return !!line && parts.every((part) => line.includes(part));
    }),
  );
  // The shell that runs the command is the innermost process holding all of it; a wrapper around several
  // commands holds them all and is left alone.
  const holders = new Set<number>();
  for (const pid of matched) {
    for (let up = parent.get(pid); up !== undefined && own.has(up); up = parent.get(up))
      if (matched.has(up)) holders.add(up);
  }
  const innermost = [...matched].filter((pid) => !holders.has(pid));
  return [...descendants(all, innermost)].filter((pid) => own.has(pid));
}

// Kills the processes at once, children first so none is left to start another; reports how many were killed.
export function killAll(pids: number[]) {
  let killed = 0;
  for (const pid of [...pids].reverse()) {
    if (pid === process.pid || pid <= 1) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {
      // Gone already.
    }
  }
  return killed;
}
