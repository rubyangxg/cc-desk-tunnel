import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { cliEnvironment } from '../src/claude.ts';
import { RUN_MARKER, commandProcesses, killAll, runProcesses } from '../src/process-tree.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settle = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

test('a run is found by its marker with everything it started, and one command of it apart', async (t) => {
  if (process.platform !== 'linux') return t.skip('reads /proc');
  const runId = randomUUID();
  const other = randomUUID();
  const env = { ...process.env, [RUN_MARKER]: runId };
  // The CLI stands in as a shell running two commands, one of them to the device over "ssh".
  const cli = spawn(
    'sh',
    ['-c', `sh -c 'sleep 30; echo device-script-one' & sh -c 'sleep 31; echo other-cmd' & wait`],
    { env, stdio: 'ignore' },
  );
  const stranger = spawn('sleep', ['32'], {
    env: { ...process.env, [RUN_MARKER]: other },
    stdio: 'ignore',
  });
  t.after(() => {
    killAll(runProcesses(runId) ?? []);
    stranger.kill('SIGKILL');
  });
  await settle(() => (runProcesses(runId) ?? []).length >= 5);
  const all = runProcesses(runId)!;
  assert.ok(all.includes(cli.pid!));
  assert.ok(!all.includes(stranger.pid!));
  assert.ok(all.length >= 5, `found ${all.length}`);
  const one = commandProcesses(runId, 'sleep 30; echo device-script-one');
  assert.ok(one.length >= 1 && one.length <= 2, `matched ${one.length}`);
  assert.ok(!one.includes(cli.pid!));
  assert.deepEqual(commandProcesses(runId, 'nothing-like-this'), []);
  assert.equal(killAll(one), one.length);
  await settle(() => one.every((pid) => !alive(pid)));
  assert.ok(alive(cli.pid!));
  const exited = new Promise((resolve) => cli.once('exit', resolve));
  killAll(runProcesses(runId)!);
  await exited;
  assert.ok(alive(stranger.pid!));
});

test('the CLI is marked with its run and gives a command five minutes at most unless told otherwise', () => {
  const runId = randomUUID();
  const env = cliEnvironment({ CLAUDE_CONFIG_DIR: '/x' }, runId, { PATH: '/bin' });
  assert.equal(env.BASH_MAX_TIMEOUT_MS, '300000');
  assert.equal(env[RUN_MARKER], runId);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/x');
  assert.equal(env.PATH, '/bin');
  assert.equal(
    cliEnvironment(undefined, runId, { BASH_MAX_TIMEOUT_MS: '900000' }).BASH_MAX_TIMEOUT_MS,
    '900000',
  );
  assert.equal(
    cliEnvironment({ BASH_MAX_TIMEOUT_MS: '60000' }, undefined, {}).BASH_MAX_TIMEOUT_MS,
    '60000',
  );
  assert.equal(RUN_MARKER in cliEnvironment(undefined, undefined, {}), false);
});
