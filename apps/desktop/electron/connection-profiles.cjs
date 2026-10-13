const path = require('node:path');

function profileId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
    throw new Error('无效的代理服务配置 ID。');
  return id;
}

function profileFile(directory, name, id = 'default') {
  profileId(id);
  if (!['drafts', 'schedules'].includes(name)) throw new Error('Invalid profile file');
  return path.join(directory, id === 'default' ? `${name}.json` : `${name}-${id}.json`);
}

function encryptionAvailable(storage) {
  return storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== 'basic_text';
}

function decode(profile, storage) {
  let token = '';
  try {
    if (profile.token && encryptionAvailable(storage))
      token = storage.decryptString(Buffer.from(profile.token, 'base64'));
  } catch {
    // A different OS account cannot decrypt the credential; require it again.
  }
  return {
    id: profileId(profile.id),
    name: String(profile.name || '默认代理服务'),
    url: String(profile.url ?? ''),
    fingerprint: String(profile.fingerprint ?? ''),
    mode: profile.mode === 'local' ? 'local' : 'remote',
    token,
    remember: !!token,
    autoLogin: !!token && profile.autoLogin === true,
  };
}

function loadProfiles(settings, storage) {
  const saved = settings.connectionProfiles;
  if (saved?.profiles?.length) {
    const profiles = saved.profiles.map((profile) => decode(profile, storage));
    return {
      profiles,
      activeId: profiles.some((profile) => profile.id === saved.activeId)
        ? saved.activeId
        : profiles[0].id,
    };
  }
  if (!settings.login) return null;
  return {
    profiles: [decode({ ...settings.login, id: 'default', name: '默认代理服务' }, storage)],
    activeId: 'default',
  };
}

function encodeProfiles(collection, storage) {
  if (
    !Array.isArray(collection?.profiles) ||
    !collection.profiles.length ||
    collection.profiles.length > 50
  )
    throw new Error('请保留 1 到 50 个代理服务配置。');
  const ids = new Set();
  const profiles = collection.profiles.map((profile) => {
    const id = profileId(profile.id);
    if (ids.has(id)) throw new Error('代理服务配置 ID 重复。');
    ids.add(id);
    const name = String(profile.name ?? '').trim();
    if (!name || name.length > 80) throw new Error('服务名称应为 1 到 80 个字符。');
    const remember = profile.remember === true && !!profile.token;
    if (remember && !encryptionAvailable(storage))
      throw new Error('系统安全存储不可用，请取消“记住凭据”后保存。');
    return {
      id,
      name,
      url: String(profile.url ?? '').trim(),
      fingerprint: String(profile.fingerprint ?? '').trim(),
      mode: profile.mode === 'local' ? 'local' : 'remote',
      ...(remember
        ? { token: storage.encryptString(String(profile.token).trim()).toString('base64') }
        : {}),
      autoLogin: remember && profile.autoLogin === true,
    };
  });
  if (!ids.has(collection.activeId)) throw new Error('请选择已有代理服务配置。');
  return { profiles, activeId: collection.activeId };
}

module.exports = { loadProfiles, encodeProfiles, profileFile };
