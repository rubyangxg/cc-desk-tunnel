import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: './test',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:15175',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    launchOptions: existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {},
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev --workspace @cc-desk-tunnel/mobile',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'http://127.0.0.1:15175',
    reuseExistingServer: false,
  },
});
