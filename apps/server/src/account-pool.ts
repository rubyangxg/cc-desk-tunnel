import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { serverPoolAccountSchema, serverPoolSettingsSchema } from '@cc-desk-tunnel/protocol';
import type {
  ServerPoolAccount,
  ServerPoolSettings,
  ServerPoolState,
} from '@cc-desk-tunnel/protocol';
import type { ClaudeOptions } from './claude.ts';
import { DomainError } from './errors.ts';

export const quotaFreshMs = 120_000;
const fresh = (account: ServerPoolAccount, now: number) =>
  account.checkedAt !== null && now - account.checkedAt < quotaFreshMs;
export function availableAccount(account: ServerPoolAccount, now = Date.now()) {
  const five = account.limits?.windows.find((window) => window.name === 'five_hour');
  return (
    account.enabled &&
    account.loggedIn === true &&
    !account.error &&
    !account.login &&
    fresh(account, now) &&
    account.limits?.available === true &&
    typeof five?.utilization === 'number' &&
    five.utilization < 100 &&
    !(account.blockedUntil && account.blockedUntil > now) &&
    !account.limits.windows.some(
      (window) => window.name === 'seven_day' && (window.utilization ?? 0) >= 100,
    )
  );
}
export function orderedAccounts(state: ServerPoolState, excluded: string[] = [], now = Date.now()) {
  const order = [
    ...new Set([...state.settings.order, ...state.accounts.map((account) => account.id)]),
  ];
  const reset = (account: ServerPoolAccount) => {
    const at = Date.parse(
      account.limits?.windows.find((window) => window.name === 'five_hour')?.resetsAt ?? '',
    );
    return at > now ? at : Infinity;
  };
  return state.accounts
    .filter((account) => !excluded.includes(account.id) && availableAccount(account, now))
    .sort(
      (a, b) =>
        (state.settings.strategy === 'reset' ? reset(a) - reset(b) : 0) ||
        order.indexOf(a.id) - order.indexOf(b.id),
    );
}

// This table contains labels and quota observations only. Official CLI login owns the credential files.
export class AccountPool {
  settings: ServerPoolSettings;
  accounts: ServerPoolAccount[];
  refreshing = false;
  readonly locked = new Set<string>();
  private database: DatabaseSync;
  private directory: string;
  private base: ClaudeOptions;
  constructor(database: DatabaseSync, directory: string, base: ClaudeOptions) {
    this.database = database;
    this.directory = directory;
    this.base = base;
    database.exec(
      'CREATE TABLE IF NOT EXISTS account_pool (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)',
    );
    const row = database.prepare('SELECT data FROM account_pool WHERE id = 1').get();
    if (row) {
      const saved = JSON.parse(String(row.data));
      this.settings = serverPoolSettingsSchema.parse(saved.settings);
      this.accounts = saved.accounts.map((account: unknown) => ({
        ...serverPoolAccountSchema.parse(account),
        login: null,
        busy: false,
      }));
    } else {
      this.settings = {
        enabled: false,
        strategy: 'reset',
        order: ['default'],
        preferredId: 'default',
      };
      this.accounts = [this.blank('default', '原有 Claude 账号')];
      this.save();
    }
  }
  private blank(id: string, name: string): ServerPoolAccount {
    return {
      id,
      name,
      enabled: true,
      loggedIn: null,
      limits: null,
      checkedAt: null,
      blockedUntil: null,
      login: null,
      busy: false,
    };
  }
  get(id: string) {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) throw new DomainError('account_missing', '这个 Claude 账号已不存在。');
    return account;
  }
  snapshot(): ServerPoolState {
    return structuredClone({
      settings: this.settings,
      accounts: this.accounts,
      refreshing: this.refreshing,
    });
  }
  add(id: string, name: string) {
    const existing = this.accounts.find((item) => item.id === id);
    if (existing) return existing;
    if (this.accounts.length >= 10)
      throw new DomainError('pool_full', '最多保存 10 个 Claude 账号。');
    const account = this.blank(id, name);
    this.accounts.push(account);
    this.settings.order.push(id);
    mkdirSync(this.configDirectory(id), { recursive: true, mode: 0o700 });
    this.save();
    return account;
  }
  configure(values: Partial<ServerPoolSettings>) {
    if (values.preferredId) this.get(values.preferredId);
    for (const id of values.order ?? []) this.get(id);
    this.settings = { ...this.settings, ...values };
    this.settings.order = [
      ...new Set([...this.settings.order, ...this.accounts.map((item) => item.id)]),
    ];
    this.save();
  }
  update(id: string, values: Partial<ServerPoolAccount>) {
    Object.assign(this.get(id), values);
    this.save();
  }
  configDirectory(id: string) {
    this.get(id);
    return id === 'default'
      ? (this.base.environment?.CLAUDE_CONFIG_DIR ??
          process.env.CLAUDE_CONFIG_DIR ??
          join(homedir(), '.claude'))
      : join(this.directory, 'accounts', id, 'config');
  }
  options(id: string): ClaudeOptions {
    this.get(id);
    if (id === 'default') return this.base;
    // A provider key inherited by the service must not override an isolated account's official login.
    const environment: Record<string, string | undefined> = { ...this.base.environment };
    for (const key of new Set([...Object.keys(process.env), ...Object.keys(environment)]))
      if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR$)/.test(key))
        environment[key] = undefined;
    environment.CLAUDE_CONFIG_DIR = this.configDirectory(id);
    return { ...this.base, settingsPath: undefined, environment };
  }
  observe(id: string, limits: ServerPoolAccount['limits'], error?: string) {
    const account = this.get(id);
    const now = Date.now();
    const measuredAt = limits?.measuredAt ? Date.parse(limits.measuredAt) : now;
    if (!error && account.checkedAt !== null && measuredAt < account.checkedAt) return;
    const blockedUntil =
      account.blockedUntil && account.blockedUntil > now ? account.blockedUntil : null;
    this.update(id, {
      limits,
      checkedAt: measuredAt,
      error: error ?? (limits?.available ? undefined : '额度暂不可用，请重新检测'),
      blockedUntil,
    });
  }
  block(id: string, resetsAt?: string) {
    const reset = Date.parse(resetsAt ?? '');
    this.update(id, { blockedUntil: reset > Date.now() ? reset : Date.now() + 300_000 });
  }
  choose(current?: string, excluded: string[] = []) {
    excluded = [...excluded, ...this.locked];
    if (!this.settings.enabled) {
      const selected = this.get(current ?? this.settings.preferredId);
      if (
        excluded.includes(selected.id) ||
        !selected.enabled ||
        selected.loggedIn === false ||
        selected.login
      )
        throw new DomainError('account_unavailable', '所选账号已停用或未登录，请在账号池中处理。');
      return selected;
    }
    if (current && !excluded.includes(current)) {
      const selected = this.get(current);
      if (availableAccount(selected)) return selected;
    }
    const next = orderedAccounts(this.snapshot(), excluded)[0];
    if (!next)
      throw new DomainError('pool_unavailable', '账号池暂无可用额度，请检测账号或等待额度重置。');
    return next;
  }
  private save() {
    const data = {
      settings: this.settings,
      accounts: this.accounts.map((account) => ({ ...account, login: null, busy: false })),
    };
    this.database
      .prepare(
        'INSERT INTO account_pool VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      )
      .run(JSON.stringify(data));
  }
}
