import { test, expect } from '@playwright/test';

test('pending history retries a transient abort and preserves the last backup when storage is full', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { saveSharedHistory, sharedHistory } = await import('../src/sharedHistory.ts');
    const put = IDBObjectStore.prototype.put;
    let attempts = 0;
    let full = false;
    IDBObjectStore.prototype.put = function (value, key) {
      if (key === 'pending:source' && full)
        throw new DOMException('Disk full', 'QuotaExceededError');
      const request = put.call(this, value, key);
      if (key === 'pending:source' && ++attempts === 1)
        request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
    try {
      await saveSharedHistory('pending:source', { segments: [], prompt: '完整上下文' });
      full = true;
      let error = '';
      try {
        await saveSharedHistory('pending:source', { segments: [], prompt: '新的上下文' });
      } catch (e) {
        error = String(e);
      }
      return { attempts, error, saved: await sharedHistory('pending:source') };
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  });
  expect(result.attempts).toBe(2);
  expect(result.error).toContain('本机会话历史保存失败');
  expect(result.error).toContain('本地存储空间不足');
  expect(result.saved?.prompt).toBe('完整上下文');
});

test('large handoffs reuse bounded chunks, preserve legacy history and reopen every source', async ({
  page,
}) => {
  await page.goto('/');
  const saved = await page.evaluate(async () => {
    const { attachSharedHistory, saveSharedHistory, sharedHistory, historyKey } =
      await import('../src/sharedHistory.ts');
    const profile = (id: string) =>
      ({ id, url: `wss://${id}.example/ws` }) as import('../src/connections.ts').ConnectionProfile;
    const session = (id: string) =>
      ({ id, title: id, activeRun: null }) as import('@cc-desk-tunnel/protocol').Session;
    const events = (id: string, text: string) => [
      {
        sessionId: id,
        runId: id,
        sequence: 1,
        createdAt: '2026-10-27T00:00:00Z',
        payload: { type: 'native.notice' as const, text },
      },
    ];
    const firstKey = historyKey(profile('first'), 'first-session');
    const oldKey = historyKey(profile('old'), 'old-session');
    const largeText = '历史🧩上下文'.repeat(90000);
    const legacy = {
      segments: [
        {
          key: oldKey,
          service: 'old',
          session: session('old-session'),
          events: events('old', largeText),
        },
      ],
      prompt: 'legacy prompt',
    };
    // Seed exactly the inline format shipped before this fix.
    const open = indexedDB.open('cc-shared-conversations', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('history');
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('history', 'readwrite');
      tx.objectStore('history').put(legacy, firstKey);
      tx.oncomplete = () => resolve();
    });
    const archive = await sharedHistory(firstKey);
    const value = {
      segments: [
        ...archive!.segments,
        {
          key: firstKey,
          service: 'first',
          session: session('first-session'),
          events: events('first', '最新任务进度'),
        },
      ],
      prompt: 'continue with context',
    };
    await saveSharedHistory(`pending:${firstKey}`, value);
    // A real IndexedDB transaction rejects oversized writes. Once the pending archive is saved,
    // attaching it must write only small routing records, regardless of transcript length.
    const original = IDBObjectStore.prototype.put;
    let maxWrite = 0;
    IDBObjectStore.prototype.put = function (value, key) {
      const size =
        value instanceof Uint8Array
          ? value.byteLength
          : new TextEncoder().encode(JSON.stringify(value)).length;
      maxWrite = Math.max(maxWrite, size);
      if (size > 64 * 1024) throw new DOMException('Oversized handoff write', 'QuotaExceededError');
      return original.call(this, value, key);
    };
    try {
      await attachSharedHistory(profile('second'), 'second-session', value);
    } finally {
      IDBObjectStore.prototype.put = original;
    }
    const secondKey = historyKey(profile('second'), 'second-session');
    const next = await sharedHistory(secondKey);
    const third = {
      ...next!,
      segments: [
        ...next!.segments,
        {
          key: secondKey,
          service: 'second',
          session: session('second-session'),
          events: events('second', '又完成一步'),
        },
      ],
    };
    await saveSharedHistory(`pending:${secondKey}`, third);
    await attachSharedHistory(profile('third'), 'third-session', third);
    const rows = await new Promise<unknown[]>((resolve) => {
      const tx = db.transaction('history', 'readonly');
      const request = tx.objectStore('history').getAll();
      tx.oncomplete = () => resolve(request.result);
    });
    db.close();
    const chunks = rows.filter((row): row is Uint8Array => row instanceof Uint8Array);
    return {
      firstKey,
      secondKey,
      oldKey,
      thirdKey: historyKey(profile('third'), 'third-session'),
      maxWrite,
      largestChunk: Math.max(...chunks.map((chunk) => chunk.byteLength)),
      chunkBytes: chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
      rawBytes: new TextEncoder().encode(
        JSON.stringify(third.segments.map((segment) => segment.events)),
      ).length,
      legacyBytes: new TextEncoder().encode(largeText).length,
    };
  });
  expect(saved.maxWrite).toBeLessThan(64 * 1024);
  expect(saved.largestChunk).toBeLessThanOrEqual(512 * 1024);
  expect(saved.chunkBytes).toBeLessThanOrEqual(saved.rawBytes);
  await page.reload();
  const reopened = await page.evaluate(async (keys) => {
    const { sharedHistory } = await import('../src/sharedHistory.ts');
    const sources = await Promise.all(
      [keys.oldKey, keys.firstKey, keys.secondKey].map(sharedHistory),
    );
    const target = await sharedHistory(keys.thirdKey);
    const pending = await sharedHistory(`pending:${keys.secondKey}`);
    return {
      destinations: sources.map((entry) => entry?.forward?.sessionId),
      prompts: sources.map((entry) => entry?.prompt),
      texts: target?.segments.map((segment) => segment.events[0]!.payload),
      pending,
    };
  }, saved);
  expect(reopened.destinations).toEqual(['third-session', 'third-session', 'third-session']);
  expect(reopened.prompts[1]).toBe('legacy prompt');
  expect(reopened.texts).toHaveLength(3);
  expect(reopened.texts![0]).toEqual({ type: 'native.notice', text: '历史🧩上下文'.repeat(90000) });
  expect(reopened.texts![2]).toEqual({ type: 'native.notice', text: '又完成一步' });
  expect(reopened.pending).toBeNull();
});

test('failed attachment rolls back pointers and keeps its pending archive; missing chunks never become empty history', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { attachSharedHistory, saveSharedHistory, sharedHistory, historyKey } =
      await import('../src/sharedHistory.ts');
    const profile = {
      id: 'target',
      url: 'wss://target.example/ws',
    } as import('../src/connections.ts').ConnectionProfile;
    const source = 'source';
    const value = {
      prompt: 'continue',
      segments: [
        {
          key: source,
          service: 'source',
          session: { id: source } as import('@cc-desk-tunnel/protocol').Session,
          events: [],
        },
      ],
    };
    await saveSharedHistory(`pending:${source}`, value);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      if (Array.isArray(key) && key[0] === 'forward')
        throw new DOMException('Disk full', 'QuotaExceededError');
      return put.call(this, value, key);
    };
    let error = '';
    try {
      await attachSharedHistory(profile, 'target-session', value);
    } catch (e) {
      error = String(e);
    }
    IDBObjectStore.prototype.put = put;
    const targetBeforeRetry = await sharedHistory(historyKey(profile, 'target-session'));
    const sourceBeforeRetry = await sharedHistory(source);
    const pendingBeforeRetry = await sharedHistory(`pending:${source}`);
    await attachSharedHistory(profile, 'target-session', value);
    const open = indexedDB.open('cc-shared-conversations', 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('history', 'readwrite');
      const store = tx.objectStore('history');
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        if (Array.isArray(cursor.result.key) && cursor.result.key[0] === 'chunk')
          cursor.result.delete();
        cursor.result.continue();
      };
      tx.oncomplete = () => resolve();
    });
    db.close();
    let missing = '';
    try {
      await sharedHistory(historyKey(profile, 'target-session'));
    } catch (e) {
      missing = String(e);
    }
    return { error, targetBeforeRetry, sourceBeforeRetry, pendingBeforeRetry, missing };
  });
  expect(result.error).toContain('本地存储空间不足');
  expect(result.targetBeforeRetry).toBeNull();
  expect(result.sourceBeforeRetry).toBeNull();
  expect(result.pendingBeforeRetry?.prompt).toBe('continue');
  expect(result.missing).toContain('本地历史数据不完整');
});
