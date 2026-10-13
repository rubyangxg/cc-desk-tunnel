import { parentPort, workerData } from 'node:worker_threads';
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';

// SDK filesystem helpers read process.env. Each operation gets an isolated environment; never change
// the server's global environment while other accounts have active processes.
const { action, id, options, title } = workerData;
try {
  let value;
  if (action === 'info') value = await getSessionInfo(id, options);
  else if (action === 'messages') value = await getSessionMessages(id, options);
  else if (action === 'fork') value = await forkSession(id, options);
  else if (action === 'rename') value = await renameSession(id, title, options);
  else if (action === 'delete') value = await deleteSession(id, options);
  else throw new Error('Unknown native store operation');
  parentPort!.postMessage({ value });
} catch {
  parentPort!.postMessage({ error: '原生会话存储操作失败，请检查该账号的存储与权限。' });
}
