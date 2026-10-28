import type {
  AccountInfo,
  ModelInfo,
  Query,
  SDKRateLimitEvent,
  SDKResultMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { eventPayloadSchema } from '@cc-desk-tunnel/protocol';
import type {
  EventPayload,
  NativeCapabilities,
  NativeMetrics as Metrics,
} from '@cc-desk-tunnel/protocol';

type ContextUsage = Awaited<ReturnType<Query['getContextUsage']>>;
type Windows = NonNullable<Metrics['rateLimits']>['windows'];
export type ObservedQuota = { windows: Windows; measuredAt: string };
// `seven_day_overage_included` is the weekly window of the models the plan counts apart. The response headers do not
// say which models those are, so it keeps its own name rather than one guessed after native `/usage`, which names the
// same window after the model the server calls it by.
type UnifiedWindow = { utilization?: number; resetsAt?: number };

// Who the CLI is signed in as. A reading seen under one login says nothing about another.
export function loginOf(account: AccountInfo, accountScope = '') {
  const { apiProvider, tokenSource, apiKeySource, email, organization, subscriptionType } = account;
  return JSON.stringify([
    accountScope,
    apiProvider,
    tokenSource,
    apiKeySource,
    email,
    organization,
    subscriptionType,
  ]);
}

// The CLI passes on the quota its own model requests were answered with as `rate_limit_event`. A login with
// CLAUDE_CODE_OAUTH_TOKEN may not read the plan quota through `/usage`, but its requests carry it all the same.
// `unifiedWindows` names every window of the response; it is not in the SDK's published type. Without it the event
// speaks for one window. Utilization comes as a fraction and the reset as Unix seconds.
export function observedQuota(
  event: SDKRateLimitEvent,
  previous: ObservedQuota | null,
  now = Date.now(),
): ObservedQuota | null {
  const info = event.rate_limit_info as SDKRateLimitEvent['rate_limit_info'] & {
    unifiedWindows?: Record<string, UnifiedWindow | undefined>;
  };
  const named: [string, UnifiedWindow | undefined][] = info.unifiedWindows
    ? Object.entries(info.unifiedWindows)
    : info.rateLimitType && info.rateLimitType !== 'overage'
      ? [[info.rateLimitType, info]]
      : [];
  const windows = named.flatMap(([name, window]) =>
    window && Number.isFinite(window.utilization)
      ? [
          {
            name,
            utilization: Math.max(0, window.utilization! * 100),
            resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null,
          },
        ]
      : [],
  );
  if (!windows.length) return null;
  // A window the event leaves out keeps its last reading until it resets (see `unexpired`).
  const kept = (previous?.windows ?? []).filter(
    (window) => !windows.some((row) => row.name === window.name),
  );
  return { windows: [...kept, ...windows], measuredAt: new Date(now).toISOString() };
}

// The quota last seen in the message stream, kept by the login it came under (see `loginOf`). A project whose
// settings sign in otherwise (an API key, another token) keeps apart, and a run still going under a login since
// replaced writes to its own, not to the new one's.
export class ObservedQuotas {
  private readings = new Map<string, ObservedQuota>();
  of(login: string) {
    return this.readings.get(login) ?? null;
  }
  observe(login: string, event: SDKRateLimitEvent, now = Date.now()) {
    const reading = observedQuota(event, this.of(login), now);
    if (reading) this.readings.set(login, reading);
  }
}

// A stored reading outlives its window: once the reset time passes, the figure no longer holds. The CLI drops such
// windows from `unifiedWindows` the same way; a window without a reset time cannot be told apart and is dropped too.
export function unexpired(observed: ObservedQuota | null, now = Date.now()): ObservedQuota | null {
  const windows = (observed?.windows ?? []).filter(
    (window) => window.resetsAt !== null && Date.parse(window.resetsAt) > now,
  );
  return windows.length ? { ...observed!, windows } : null;
}

export function nativeCapabilities(
  models: ModelInfo[],
  account: AccountInfo,
  commands: (SlashCommand | string)[],
  configuredModel?: string,
  // Commands whose use is bound to the CLI's own terminal, as the CLI names them.
  terminal: string[] = [],
): EventPayload {
  const usable = commands
    .map((command) =>
      typeof command === 'string'
        ? { name: command, description: '', argumentHint: '', aliases: undefined }
        : command,
    )
    .filter((command) => !terminal.includes(command.name));
  const catalog: NativeCapabilities['models'] = models.map((model) => ({
    value: model.value,
    resolvedModel: model.resolvedModel,
    displayName: model.displayName,
    description: model.description,
    source: 'native',
    supportedEffortLevels: model.supportedEffortLevels ?? [],
  }));
  if (
    configuredModel &&
    !catalog.some(
      (model) =>
        model.value === configuredModel ||
        models.find((row) => row.value === model.value)?.resolvedModel === configuredModel,
    )
  )
    catalog.unshift({
      value: configuredModel,
      displayName: configuredModel,
      description: '',
      source: 'configured',
      supportedEffortLevels: [],
    });
  // Send named public identity fields only; no credentials or arbitrary initialization payload.
  return eventPayloadSchema.parse({
    type: 'native.capabilities',
    models: catalog,
    commands: usable.map((command) => command.name),
    commandDetails: usable.map(({ name, description, argumentHint, aliases }) => ({
      name,
      description: description ?? '',
      argumentHint: argumentHint ?? '',
      ...(aliases?.length ? { aliases } : {}),
    })),
    terminalCommands: terminal,
    account: {
      email: account.email,
      organization: account.organization,
      subscriptionType: account.subscriptionType,
      apiProvider: account.apiProvider,
      apiKeySource: account.apiKeySource,
      tokenSource: account.tokenSource,
    },
  });
}

export function resultUsage(result: SDKResultMessage): Metrics['usage'] {
  if (!result.modelUsage) return null;
  const values = Object.values(result.modelUsage);
  return {
    costUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
    inputTokens: values.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: values.reduce((sum, value) => sum + value.outputTokens, 0),
    cacheReadTokens: values.reduce((sum, value) => sum + value.cacheReadInputTokens, 0),
    cacheWriteTokens: values.reduce((sum, value) => sum + value.cacheCreationInputTokens, 0),
    measuredAt: new Date().toISOString(),
  };
}

async function optionalStatus<T>(
  read: () => Promise<T>,
  timeoutMs: number,
): Promise<{ value: T | null; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(read)
        .then(
          (value) => ({ value }),
          () => ({ value: null, error: '原生接口读取失败' }),
        ),
      new Promise<{ value: null; error: string }>((resolve) => {
        timer = setTimeout(() => resolve({ value: null, error: '原生接口读取超时' }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function contextSummary(context: ContextUsage | null): Metrics['context'] {
  return context && context.rawMaxTokens > 0
    ? {
        model: context.model,
        usedTokens: context.totalTokens,
        windowTokens: context.rawMaxTokens,
        percentage: context.percentage,
        measuredAt: new Date().toISOString(),
        categories: context.categories.map(({ name, tokens, kind }) => ({ name, tokens, kind })),
      }
    : null;
}

// Mid-turn refresh: only the context changes with each model call; quota and totals keep their last native reading.
export async function nativeContextRefresh(
  query: Query,
  previous: Metrics,
  timeoutMs = 5000,
): Promise<Metrics | null> {
  const context = contextSummary(
    (await optionalStatus(() => query.getContextUsage({ detail: 'summary' }), timeoutMs)).value,
  );
  if (!context) return null;
  return {
    type: 'native.metrics',
    context,
    usage: previous.usage,
    rateLimits: previous.rateLimits,
    ...(previous.errors?.usage ? { errors: { usage: previous.errors.usage } } : {}),
  };
}

// `observed` is the quota last seen in the message stream, used when the CLI says the plan quota does not apply.
export async function nativeMetrics(
  query: Query,
  result?: SDKResultMessage,
  {
    timeoutMs = 5000,
    observed = null,
  }: { timeoutMs?: number; observed?: ObservedQuota | null } = {},
): Promise<EventPayload> {
  // Order readings by when they were requested, not when concurrent status calls happened to finish.
  const measuredAt = new Date().toISOString();
  const [contextStatus, usageStatus] = await Promise.all([
    optionalStatus(() => query.getContextUsage({ detail: 'summary' }), timeoutMs),
    optionalStatus(
      () =>
        query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      timeoutMs,
    ),
  ]);
  const context = contextStatus.value,
    usage = usageStatus.value;
  const windows = usage?.rate_limits
    ? Object.entries(usage.rate_limits).flatMap(([name, value]) => {
        if (!value || name === 'extra_usage') return [];
        // Per-model weekly rows (a Max plan's Fable limit) are named after the weekly window they belong to.
        if (name === 'model_scoped' && Array.isArray(value))
          return value.map((item) => ({
            name: `seven_day:${item.display_name}`,
            utilization: item.utilization,
            resetsAt: item.resets_at,
          }));
        if (!Array.isArray(value) && 'utilization' in value && 'resets_at' in value)
          return [{ name, utilization: value.utilization, resetsAt: value.resets_at }];
        return [];
      })
    : [];
  // A failed reading stays failed; only one that says the plan quota does not apply is completed.
  const current = unexpired(observed, Date.parse(measuredAt));
  const rateLimits =
    usage && !usage.rate_limits_available && current
      ? { available: true, ...current }
      : usage
        ? { available: usage.rate_limits_available, windows, measuredAt }
        : null;
  const totals =
    result ??
    (usage?.session
      ? ({
          total_cost_usd: usage.session.total_cost_usd,
          modelUsage: usage.session.model_usage,
        } as SDKResultMessage)
      : undefined);
  return eventPayloadSchema.parse({
    type: 'native.metrics',
    context: contextSummary(context),
    usage: totals ? resultUsage(totals) : null,
    rateLimits,
    ...(contextStatus.error || usageStatus.error
      ? {
          errors: { context: contextStatus.error, usage: usageStatus.error },
        }
      : {}),
  });
}
