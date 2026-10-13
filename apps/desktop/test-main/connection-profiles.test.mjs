import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { loadProfiles, encodeProfiles, profileFile } from '../electron/connection-profiles.cjs';
import { validateConnection, profileKey } from '../src/connections.ts';

function storage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}
function profile(id) {
  return {
    id,
    name: `账号 ${id}`,
    url: `wss://${id}.example.com/ws`,
    token: randomBytes(32).toString('hex'),
    fingerprint: '',
    mode: 'remote',
    remember: true,
    autoLogin: true,
  };
}

test('account profiles round-trip independently and only encrypted tokens reach settings', () => {
  const vault = storage();
  const collection = { profiles: [profile('a'), profile('b')], activeId: 'b' };
  const encoded = encodeProfiles(collection, vault);
  for (const item of collection.profiles) assert.ok(!JSON.stringify(encoded).includes(item.token));
  assert.deepEqual(loadProfiles({ connectionProfiles: encoded }, vault), collection);
  const changed = structuredClone(collection);
  changed.profiles[0].remember = false;
  const saved = encodeProfiles(changed, vault);
  assert.equal(saved.profiles[0].token, undefined);
  const restored = loadProfiles({ connectionProfiles: saved }, vault);
  assert.equal(restored.profiles[0].token, '');
  assert.equal(restored.profiles[0].autoLogin, false);
  assert.equal(restored.profiles[1].token, collection.profiles[1].token);
  const removed = encodeProfiles({ profiles: [collection.profiles[1]], activeId: 'b' }, vault);
  assert.deepEqual(
    removed.profiles.map((item) => item.id),
    ['b'],
  );
});

test('the old encrypted sign-in becomes the default profile without losing auto-login', () => {
  const vault = storage();
  const original = profile('old');
  const login = { ...original, token: vault.encryptString(original.token).toString('base64') };
  const loaded = loadProfiles({ login }, vault);
  assert.equal(loaded.activeId, 'default');
  assert.equal(loaded.profiles[0].name, '默认代理服务');
  assert.equal(loaded.profiles[0].token, original.token);
  assert.equal(loaded.profiles[0].autoLogin, true);
  const inaccessible = loadProfiles({ login }, storage());
  assert.equal(inaccessible.profiles[0].token, '');
  assert.equal(inaccessible.profiles[0].autoLogin, false);
});

test('remembering a token requires secure OS storage, including on Linux', () => {
  const collection = { profiles: [profile('a')], activeId: 'a' };
  for (const vault of [
    { ...storage(), isEncryptionAvailable: () => false },
    { ...storage(), getSelectedStorageBackend: () => 'basic_text' },
  ])
    assert.throws(() => encodeProfiles(collection, vault), /安全存储不可用/);
  collection.profiles[0].remember = false;
  assert.equal(
    encodeProfiles(collection, { isEncryptionAvailable: () => false }).profiles[0].token,
    undefined,
  );
});

test('profile files isolate overlapping session IDs and reject path traversal', () => {
  assert.equal(profileFile('/tmp/user', 'drafts', 'default'), join('/tmp/user', 'drafts.json'));
  for (const name of ['drafts', 'schedules']) {
    assert.notEqual(profileFile('/tmp/user', name, 'a'), profileFile('/tmp/user', name, 'b'));
    assert.throws(() => profileFile('/tmp/user', name, '../other'));
  }
  assert.equal(profileKey('proxy-drafts', 'default'), 'proxy-drafts');
  assert.notEqual(profileKey('proxy-schedules', 'a'), profileKey('proxy-schedules', 'b'));
});

test('connection validation requires WSS and a complete SHA-256 pin when one is supplied', () => {
  const form = profile('a');
  assert.doesNotThrow(() => validateConnection(form));
  assert.doesNotThrow(() =>
    validateConnection({ ...form, fingerprint: Array(32).fill('AB').join(':') }),
  );
  assert.throws(() => validateConnection({ ...form, fingerprint: 'AB:CD' }), /32 字节/);
  assert.throws(() => validateConnection({ ...form, url: 'ws://example.com/ws' }), /wss/);
  assert.throws(
    () => validateConnection({ ...form, url: 'wss://user:secret@example.com/ws' }),
    /不能包含凭据/,
  );
  assert.throws(
    () => validateConnection({ ...form, url: 'wss://example.com/ws?token=private' }),
    /不能包含凭据/,
  );
});
