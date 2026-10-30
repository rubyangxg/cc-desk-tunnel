import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyServer } from './server.ts';
import { rmSync } from 'node:fs';
import { clearServiceVariables, environmentConfig } from './config.ts';
import { removeFrpLeftovers } from './legacy.ts';
import { logFailure } from './diagnostics.ts';

// A promise nobody waited on must not end the service with every run and tunnel it carries: it is logged, masked,
// and the service goes on. An exception thrown past every handler leaves the state unknown, so after logging it
// the process still ends and its supervisor starts it again.
process.on('unhandledRejection', (reason) => logFailure('unhandled rejection', reason, true));
process.on('uncaughtException', (error) => {
  logFailure('uncaught exception', error, true);
  process.exit(1);
});

const { options, native, port } = environmentConfig(
  process.env,
  fileURLToPath(new URL('../../../.local/sessions', import.meta.url)),
);
const programDir = process.env.PROXY_PROGRAM_DIR;
if (native) removeFrpLeftovers();
clearServiceVariables(process.env);
// What a process that did not get to close left of its connections and of the doors of their devices.
if (native)
  for (const name of ['connections', 'devices'])
    rmSync(join(options.dataDir, name), { recursive: true, force: true });
const server = createProxyServer(options);
console.log(`Proxy ${native ? 'native' : 'simulation'} service: ${await server.listen(port)}`);
// The entry script counts starts of an upgraded program and gives up on it after three that did not get here.
if (programDir) rmSync(join(programDir, 'attempts'), { force: true });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.close();
}
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
