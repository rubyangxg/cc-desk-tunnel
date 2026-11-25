import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

type Refusal = { release: string | null; preparing: number | null };
type Step = Record<string, unknown>;
declare global {
  interface Window {
    // What the test's stand-in for the main process was asked, and how the test answers for it.
    upgradeTest: {
      calls: unknown[][];
      progress: (step: Step) => void;
      fail: (message: string) => void;
    };
  }
}

// A remote profile uses the real personal sign-in screen and its scoped bridge IPC.
async function refusedBy(
  page: Page,
  refusal: Refusal,
  probe: unknown = { status: 'unreachable' },
  service = '9.9.9',
) {
  let attempts = 0;
  const older = service === '0.4.59';
  await page.routeWebSocket('ws://127.0.0.1:18895/ws', (route) => {
    route.onMessage((raw) => {
      if (JSON.parse(String(raw)).type !== 'auth') return;
      attempts++;
      if (older && attempts > 2) {
        route.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.4.64',
            adapter: 'simulation',
            sessions: [],
            projects: [],
            connectionId: '00000000-0000-4000-8000-000000000003',
          }),
        );
        return;
      }
      const next =
        attempts > 1 && typeof probe === 'object' && probe && 'release' in probe
          ? (probe as Refusal)
          : refusal;
      route.send(
        JSON.stringify({
          type: 'connection.error',
          code: 'version_mismatch',
          message: '客户端与服务端版本不一致',
          service,
          protocolVersion: older ? 27 : PROTOCOL_VERSION + 1,
          ...(next.release
            ? { client: { version: next.release, size: 100, sha256: '0'.repeat(64) } }
            : {}),
          ...(next.preparing !== null
            ? { preparing: { version: '9.9.9', received: next.preparing * 100, size: 100 } }
            : {}),
        }),
      );
    });
  });
  await page.addInitScript((probe) => {
    const calls: unknown[][] = [];
    let progress = (_step: Step) => {};
    let settle = (_value: unknown) => {};
    let reject = (_error: Error) => {};
    const noop = async () => {};
    const subscription = () => () => {};
    window.upgradeTest = {
      calls,
      progress: (step) => progress(step),
      fail: (message) => reject(new Error(message)),
    };
    Object.assign(window, {
      desktop: {
        dev: true,
        platform: 'win32',
        version: async () => '0.4.64',
        device: async () => ({ id: '00000000-0000-4000-8000-000000000002', name: '这台电脑' }),
        loadProfiles: async () => ({
          activeId: 'test-service',
          profiles: [
            {
              id: 'test-service',
              name: '测试代理',
              url: 'wss://service.test/ws',
              token: 'test-only-upgrade-token-with-enough-length',
              fingerprint: '',
              mode: 'remote',
              remember: true,
              autoLogin: true,
            },
          ],
        }),
        saveProfiles: noop,
        onSharedChanged: subscription,
        saveShared: noop,
        setBusy: noop,
        workspaceRoots: async () => [],
        probeQuota: async () => null,
        profileSessions: async () => [],
        loadDrafts: async () => ({}),
        saveDrafts: noop,
        onNotifyClicked: subscription,
        onSchedulesChanged: subscription,
        loadSchedules: async () => ({ path: '', text: '{"tasks":[]}' }),
        saveSchedules: noop,
        connectProxy: async () => ({ url: 'ws://127.0.0.1:18895/ws' }),
        disconnectProxy: noop,
        releaseNotes: async () => '',
        onUpdateProgress: (callback: typeof progress) => {
          progress = callback;
          return () => {};
        },
        installUpdate: (version?: string, profileId?: string) => {
          calls.push(['install', version, profileId]);
          return new Promise((resolve, fail) => {
            settle = resolve;
            reject = fail;
          });
        },
        cancelUpdate: async (profileId?: string) => {
          calls.push(['cancel', profileId]);
          settle({ cancelled: true });
        },
        onServiceUpgrade: subscription,
        upgradeService: async (config: { url: string; service: string }) => {
          calls.push(['service-upgrade', config.url, config.service]);
          return { version: '0.4.64' };
        },
        probeService: async (config: { url: string }) => {
          calls.push(['probe', config.url]);
          return probe;
        },
      },
    });
  }, probe);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('版本不一致');
}
const calls = (page: Page) => page.evaluate(() => window.upgradeTest.calls);
const progress = (page: Page, step: Step) =>
  page.evaluate(
    (step) => window.upgradeTest.progress({ profileId: 'test-service', ...step }),
    step,
  );

test('an upgrade from the service shows each step in place of its buttons, says when the data stops, and can be stopped', async ({
  page,
}) => {
  await page.clock.install();
  await refusedBy(page, { release: '9.9.9', preparing: null });
  const fromService = page.getByRole('button', { name: '升级客户端到 9.9.9' });
  const fromGithub = page.getByRole('button', { name: '改从 GitHub 发布页下载 9.9.9' });
  await expect(fromGithub).toBeVisible();
  await fromService.click();
  const status = page.locator('.upgrade-progress');
  await expect(status).toContainText('正在连接服务端…');
  await expect(fromService).toHaveCount(0);
  await expect(fromGithub).toHaveCount(0);
  await expect(page.getByRole('button', { name: '连接选中的服务', exact: true })).toBeDisabled();
  await progress(page, {
    source: 'service',
    phase: 'downloading',
    received: 4 * 1048576,
    size: 8 * 1048576,
  });
  await expect(status).toContainText('正在从服务端下载 50%');
  await expect(status).toContainText('4.0 MB / 8.0 MB');
  await page.clock.fastForward(7000);
  await expect(status).toContainText('7 秒没有新数据');
  await page.getByRole('button', { name: '取消' }).click();
  await expect(status).toHaveCount(0);
  await expect(fromService).toBeVisible();
  expect(await calls(page)).toEqual([
    ['install', undefined, 'test-service'],
    ['cancel', 'test-service'],
  ]);
});

test('a download from the release page that fails says why, and both ways are offered again', async ({
  page,
}) => {
  await refusedBy(page, { release: '9.9.9', preparing: null });
  await page.getByRole('button', { name: '改从 GitHub 发布页下载 9.9.9' }).click();
  await expect(page.locator('.upgrade-progress')).toContainText('正在连接 GitHub…');
  await progress(page, {
    source: 'github',
    phase: 'retrying',
    attempt: 2,
    attempts: 5,
    received: 1048576,
    size: 4 * 1048576,
  });
  await expect(page.locator('.upgrade-progress')).toContainText(
    '网络中断，正在重新连接（第 2/5 次）',
  );
  await page.evaluate(() =>
    window.upgradeTest.fail(
      "Error invoking remote method 'update:install': Error: 从 GitHub 下载安装包中断（15 秒没有收到数据），已下载 1.0 MB / 4.0 MB。",
    ),
  );
  await expect(page.getByRole('alert')).toHaveText(/^从 GitHub 下载安装包中断/);
  await expect(page.getByRole('button', { name: '升级客户端到 9.9.9' })).toBeVisible();
  await expect(page.getByRole('button', { name: '改从 GitHub 发布页下载 9.9.9' })).toBeVisible();
  expect(await calls(page)).toEqual([['install', '9.9.9', 'test-service']]);
});

test('a service still fetching the installer is asked again until it holds it, and the upgrade is offered then', async ({
  page,
}) => {
  await refusedBy(
    page,
    { release: null, preparing: 0.4 },
    { status: 'refused', service: '9.9.9', release: '9.9.9', preparing: null },
  );
  await expect(page.getByRole('alert')).toContainText('服务端正在下载这一版的安装包（40%）');
  await expect(page.getByRole('button', { name: '升级客户端到 9.9.9' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '从 GitHub 发布页下载并升级到 9.9.9' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '升级客户端到 9.9.9' })).toBeVisible();
  await expect(page.getByRole('alert')).not.toContainText('正在下载');
  expect((await calls(page)).filter(([call]) => call === 'probe')).toHaveLength(1);
});

test('upgrading the older selected service reconnects after it reports ready', async ({ page }) => {
  await refusedBy(page, { release: null, preparing: null }, { status: 'ready' }, '0.4.59');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: '升级服务端', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('正在重启');
  await expect(page.locator('.connection-status')).toContainText('已连接');
  expect(await calls(page)).toEqual([
    ['service-upgrade', 'wss://service.test/ws', '0.4.59'],
    ['probe', 'wss://service.test/ws'],
  ]);
});
