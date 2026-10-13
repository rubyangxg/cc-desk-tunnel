import { Worker } from 'node:worker_threads';
import type {
  SDKSessionInfo,
  SessionMessage,
  ForkSessionOptions,
  ForkSessionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeOptions } from './claude.ts';

type Results = {
  info: SDKSessionInfo | undefined;
  messages: SessionMessage[];
  fork: ForkSessionResult;
  rename: void;
  delete: void;
};
export function nativeStore<A extends keyof Results>(
  claude: ClaudeOptions,
  action: A,
  id: string,
  options: ForkSessionOptions = {},
  title?: string,
): Promise<Results[A]> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...claude.environment }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const worker = new Worker(new URL('./native-store-worker.ts', import.meta.url), {
      env,
      workerData: { action, id, options, title },
    });
    const timer = setTimeout(() => {
      reject(new Error('原生会话存储读取超时。'));
      void worker.terminate();
    }, 15000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error));
      else resolve(message.value);
      void worker.terminate();
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('原生会话读取进程已结束。'));
    });
  });
}
