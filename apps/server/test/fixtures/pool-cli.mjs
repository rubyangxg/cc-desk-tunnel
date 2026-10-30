#!/usr/bin/env node
// Deterministic, offline CLI producer for account isolation and SDK transport integration tests.
import { createInterface } from 'node:readline';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const directory = process.env.CLAUDE_CONFIG_DIR;
if (!directory) process.exit(2);
const file = join(directory, 'fixture.json');
// The test and other fixture processes rewrite this file while a run polls it. Writers replace it whole (a temporary
// file, then a rename); a reader that still meets a cut-off file reads it again instead of failing the run.
const state = () => {
  for (let attempt = 0; ; attempt++) {
    if (!existsSync(file)) return { loggedIn: false };
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError || error?.code === 'ENOENT') || attempt >= 50) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
};
const save = (value) => {
  mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, file);
};
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const input = createInterface({ input: process.stdin });
if (process.argv.includes('auth')) {
  if (process.argv.includes('status')) {
    emit({ loggedIn: state().loggedIn, email: state().email, subscriptionType: 'pro' });
    process.exit(0);
  }
  if (process.argv.includes('logout')) {
    save({ ...state(), loggedIn: false });
    process.exit(0);
  }
  console.log('https://example.com/offline-test-authorize\n');
  input.once('line', () => {
    save({ loggedIn: true, email: 'new-account@example.test' });
    process.exit(0);
  });
} else {
  const arg = (name) =>
    process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ??
    (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const sessionId = arg('--resume') ?? arg('--session-id') ?? randomUUID();
  let appendSystemPrompt;
  input.on('line', async (line) => {
    const message = JSON.parse(line);
    if (message.type === 'control_request') {
      let response = {};
      const config = state();
      if (message.request.subtype === 'initialize')
        appendSystemPrompt = message.request.appendSystemPrompt;
      if (message.request.subtype === 'initialize')
        response = {
          commands: config.commands ?? [
            { name: 'goal', description: 'Set goal', argumentHint: '<condition>' },
          ],
          models: [{ value: 'test', displayName: 'Test', description: '' }],
          account: { email: config.email, subscriptionType: 'pro' },
        };
      if (message.request.subtype === 'get_context_usage')
        response = {
          model: 'test',
          rawMaxTokens: 200000,
          totalTokens: 100,
          percentage: 0.05,
          categories: [],
        };
      if (message.request.subtype === 'get_usage')
        response = {
          rate_limits_available: true,
          rate_limits: {
            five_hour: {
              utilization: config.blocked ? 100 : 10,
              resets_at:
                config.resetsAt ??
                new Date(Date.now() + (config.hours ?? 1) * 3600_000).toISOString(),
            },
            seven_day: {
              utilization: config.weeklyBlocked ? 100 : 20,
              resets_at: config.weeklyResetsAt ?? new Date(Date.now() + 86400_000).toISOString(),
            },
          },
        };
      emit({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response },
      });
    }
    if (message.type === 'user') {
      const config = state();
      if (process.env.POOL_TEST_LOG)
        appendFileSync(
          process.env.POOL_TEST_LOG,
          JSON.stringify({
            directory,
            at: Date.now(),
            sessionId,
            args: process.argv.slice(2),
            prompt: message.message.content,
            appendSystemPrompt,
            apiKeyPresent: !!process.env.ANTHROPIC_API_KEY,
          }) + '\n',
        );
      const project = join(directory, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(project, { recursive: true });
      appendFileSync(
        join(project, `${sessionId}.jsonl`),
        JSON.stringify({
          type: 'user',
          uuid: message.uuid,
          parentUuid: null,
          sessionId,
          cwd: process.cwd(),
          timestamp: new Date().toISOString(),
          message: message.message,
          isSidechain: false,
        }) + '\n',
      );
      emit({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        model: 'test',
        claude_code_version: 'test',
        permissionMode: 'auto',
        slash_commands: config.commands?.map((command) => command.name),
        terminal_slash_commands: config.terminalCommands,
      });
      const goalFile = join(directory, `goal-${sessionId}.json`);
      const goal = () => (existsSync(goalFile) ? JSON.parse(readFileSync(goalFile, 'utf8')) : null);
      const goalArgs = /^\/goal(?:\s+([\s\S]*))?$/.exec(message.message.content)?.[1]?.trim() ?? '';
      const isGoal = /^\/goal(?:\s|$)/.test(message.message.content);
      const clearsGoal = ['clear', 'stop', 'off', 'reset', 'none', 'cancel'].includes(goalArgs);
      if (isGoal) {
        let text;
        if (!goalArgs)
          text = goal()
            ? `Goal active: ${goal().condition} (${goal().iterations ?? 0} turns)`
            : 'No goal set. Usage: `/goal <condition>`';
        else if (clearsGoal) {
          text = goal() ? `Goal cleared: ${goal().condition}` : 'No goal set';
          writeFileSync(goalFile, 'null');
        } else if (config.rejectGoal) text = '/goal cannot run while hooks are restricted';
        else {
          writeFileSync(goalFile, JSON.stringify({ condition: goalArgs, iterations: 0 }));
          text = `Goal set: ${goalArgs}`;
        }
        emit({
          type: 'assistant',
          session_id: sessionId,
          parent_tool_use_id: null,
          local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
          local_command_run: { command: 'goal', args: goalArgs },
          message: { model: '<synthetic>', content: [{ type: 'text', text }] },
        });
        if (!goalArgs || clearsGoal || config.rejectGoal) {
          emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: sessionId,
            user_message_uuid: message.uuid,
            result: text,
            modelUsage: {},
            usage: { output_tokens: 0 },
            num_turns: 0,
          });
          return;
        }
      }
      if (config.commandOutput && message.message.content.startsWith('/')) {
        emit({
          type: 'system',
          subtype: 'local_command_output',
          content: config.commandOutput,
          session_id: sessionId,
        });
        if (message.message.content.startsWith('/goal'))
          emit({
            type: 'active_goal',
            value: {
              condition: message.message.content.slice(6),
              iterations: 0,
              set_at: Date.now(),
              tokens_at_start: 0,
            },
            session_id: sessionId,
          });
      }
      if (config.changedCommands)
        emit({
          type: 'system',
          subtype: 'commands_changed',
          commands: config.changedCommands,
          session_id: sessionId,
        });
      while (state().pauseBeforeQuota) await delay(10);
      if (['quota', 'quota-result', 'unknown'].includes(config.fail)) {
        save({ ...config, blocked: true });
        if (config.fail === 'unknown')
          emit({
            type: 'assistant',
            session_id: sessionId,
            user_message_uuid: message.uuid,
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: 'unknown-tool',
                  name: 'Bash',
                  input: { command: 'a command with an unknown result' },
                },
              ],
            },
          });
        emit({
          type: 'rate_limit_event',
          session_id: sessionId,
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: config.quotaWindow ?? 'five_hour',
            resetsAt: Math.ceil(Date.now() / 1000) + (config.resetSeconds ?? 3600),
          },
        });
        if (config.fail === 'quota') return; // Real CLI can keep waiting for quota without returning a result.
      } else
        emit({
          type: 'assistant',
          session_id: sessionId,
          user_message_uuid: message.uuid,
          message: { content: [{ type: 'text', text: `Completed by ${config.email}` }] },
        });
      if (!config.fail && config.finishGoal && goal()) writeFileSync(goalFile, 'null');
      emit({
        type: 'result',
        subtype: config.fail ? 'error_during_execution' : 'success',
        is_error: !!config.fail,
        result: 'test result',
        session_id: sessionId,
        user_message_uuid: message.uuid,
        modelUsage: {},
        usage: { output_tokens: 0 },
        num_turns: 1,
      });
    }
  });
}
