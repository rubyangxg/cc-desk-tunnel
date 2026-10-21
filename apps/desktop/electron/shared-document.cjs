const { createHash, randomUUID } = require('node:crypto');
const {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { join, extname } = require('node:path');

// A single ordinary Markdown file, shared by all connection processes on this computer.
// Nothing is written to a project or to a server's account-specific CLAUDE.md.
const LIMIT = 512 * 1024;
const documentPath = (base) => join(base, 'shared', 'reference.md');
const version = (text) => createHash('sha256').update(text).digest('hex');
function validate(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMIT)
    throw new Error('共享文档不能超过 512 KB。');
  if (text.includes('\0')) throw new Error('请选择 UTF-8 Markdown 文本文件。');
  return text;
}
function readText(file) {
  if (statSync(file).size > LIMIT) throw new Error('共享文档不能超过 512 KB。');
  const bytes = readFileSync(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('请选择 UTF-8 Markdown 文本文件。');
  }
  return validate(text);
}
function load(base) {
  const path = documentPath(base);
  const text = existsSync(path) ? readText(path) : '';
  return { path, text, version: version(text) };
}
function importFile(file) {
  if (!['.md', '.markdown'].includes(extname(file).toLowerCase()))
    throw new Error('请选择 .md 或 .markdown 文件。');
  return readText(file);
}
function save(base, text, expectedVersion) {
  validate(text);
  const target = documentPath(base);
  mkdirSync(join(base, 'shared'), { recursive: true, mode: 0o700 });
  const lock = `${target}.lock`;
  // Save is synchronous and short. A second window must reload/retry, never silently overwrite.
  // Never evict locks on a timer: a suspended process might still be committing a save.
  let descriptor;
  try {
    descriptor = openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new Error(
        `共享文档正在保存，请稍后重试。若客户端曾异常退出，请退出所有客户端后删除 ${lock}。`,
      );
    throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(descriptor, String(process.pid));
    if (load(base).version !== expectedVersion)
      throw new Error('共享文档已在别处修改，草稿已保留。请先复制草稿，再重新载入合并。');
    const file = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(file, text, 'utf8');
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    // Windows can briefly refuse a rename while another connection is reading the file.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, target);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    return { path: target, text, version: version(text) };
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {}
    unlinkSync(lock);
  }
}
module.exports = { LIMIT, documentPath, importFile, load, save };
