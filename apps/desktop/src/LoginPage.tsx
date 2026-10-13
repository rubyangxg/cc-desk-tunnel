import { Download, Plus, Save, Settings, SquareTerminal, Trash2, Unplug } from 'lucide-react';
import { GithubMark, openProject, project } from './project.tsx';
import type { ConnectionForm, ConnectionProfile } from './connections.ts';
import type { ReactNode } from 'react';
export type { ConnectionForm } from './connections.ts';
import { useConnectionName } from './shared.ts';

export default function LoginPage({
  form,
  change,
  connecting,
  error,
  upgrade,
  direct,
  downloaded,
  install,
  newer,
  showNotes,
  submit,
  openSettings,
  profiles,
  profileId,
  name,
  changeName,
  selectProfile,
  addProfile,
  saveProfile,
  removeProfile,
  notice,
  pool,
}: {
  form: ConnectionForm;
  change: (values: Partial<ConnectionForm>) => void;
  connecting: boolean;
  error: string | null;
  // The version of the installer a service of another version offers this client.
  upgrade: string | null;
  // The service's version, when this client is the older one: its installer can be fetched from the release
  // page instead, and `downloaded` is how far that is, from 0 to 1.
  direct: string | null;
  downloaded: number | null;
  // Fetches and runs the installer the service holds, or the given version's from the release page.
  install: (version?: string) => void;
  // The version the service is at or offers, when it is newer than this client: its notes can be read.
  newer: string | null;
  // Shows what a version changed.
  showNotes: (version: string) => void;
  submit: () => void;
  // This computer's own settings, which need no connection.
  openSettings: () => void;
  profiles: ConnectionProfile[];
  profileId: string;
  name: string;
  changeName: (name: string) => void;
  selectProfile: (id: string) => void;
  addProfile: () => void;
  saveProfile: () => void;
  removeProfile: () => void;
  notice: string | null;
  pool: ReactNode;
}) {
  const connectionName = useConnectionName();
  return (
    <main className="login-page">
      <div className="window-drag" />
      <div className="login-content">
        <div className="brand">
          <SquareTerminal />
          <span>CC Desk Tunnel</span>
          {connectionName && <span className="brand-connection">{connectionName}</span>}
        </div>
        <div className="login-title">
          <h1>连接代理服务</h1>
          {form.mode === 'local' && <span className="badge simulation">离线模拟</span>}
        </div>
        <p className="login-intro">
          连接你的云端 Claude 工作台。新版服务支持在一个连接中管理多个 Claude 账号。
        </p>
        <div className="login-steps">
          <span>
            <b>1</b>连接服务
          </span>
          <span>
            <b>2</b>登录 Claude 账号
          </span>
          <span>
            <b>3</b>选择本机项目
          </span>
        </div>
        <div className="profile-picker">
          <label>
            代理服务
            <select
              aria-label="代理服务"
              value={profileId}
              disabled={connecting}
              onChange={(event) => selectProfile(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            disabled={connecting || profiles.length >= 50}
            onClick={addProfile}
          >
            <Plus />
            新增代理服务
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="connection-form"
        >
          <fieldset className="connection-fields" disabled={connecting}>
            <label>
              服务名称
              <input
                value={name}
                maxLength={80}
                onChange={(event) => changeName(event.target.value)}
                required
                placeholder="例如：工作代理服务"
              />
            </label>
            <p className="profile-hint">
              这里保存服务器连接。Claude 账号在连接后的“账号池”页面添加；原有登录和会话会保留。
            </p>
            {window.desktop?.dev && (
              <div className="connection-modes" role="group" aria-label="连接方式">
                <button
                  type="button"
                  aria-pressed={form.mode === 'local'}
                  onClick={() => change({ mode: 'local' })}
                >
                  本地模拟
                </button>
                <button
                  type="button"
                  aria-pressed={form.mode === 'remote'}
                  onClick={() => change({ mode: 'remote' })}
                >
                  远程代理
                </button>
              </div>
            )}
            <label>
              服务地址
              <input
                autoFocus
                type="url"
                value={form.url}
                onChange={(event) => change({ url: event.target.value })}
                required
                spellCheck={false}
              />
            </label>
            {form.mode === 'remote' && (
              <label>
                服务证书指纹（可选）
                <input
                  aria-label="服务证书指纹"
                  value={form.fingerprint}
                  onChange={(event) => change({ fingerprint: event.target.value })}
                  placeholder="留空使用 CA 验证"
                  spellCheck={false}
                />
              </label>
            )}
            <label>
              服务凭据
              <input
                type="password"
                value={form.token}
                onChange={(event) => change({ token: event.target.value })}
                required
                autoComplete="off"
              />
            </label>
            {window.desktop && (
              <div className="login-options">
                <label>
                  <input
                    type="checkbox"
                    checked={form.remember}
                    onChange={(event) =>
                      change({
                        remember: event.target.checked,
                        autoLogin: event.target.checked && form.autoLogin,
                      })
                    }
                  />
                  记住凭据
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={form.autoLogin}
                    onChange={(event) =>
                      change({
                        autoLogin: event.target.checked,
                        remember: event.target.checked || form.remember,
                      })
                    }
                  />
                  启动时自动连接
                </label>
              </div>
            )}
            <div className="profile-actions">
              <button type="button" className="button" onClick={saveProfile}>
                <Save />
                保存配置
              </button>
              <button
                type="button"
                className="button"
                disabled={profiles.length < 2}
                onClick={removeProfile}
              >
                <Trash2 />
                删除代理服务
              </button>
            </div>
          </fieldset>
          {notice && (
            <p className="profile-hint" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          {upgrade && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting}
              onClick={() => install()}
            >
              <Download />
              升级客户端到 {upgrade}
            </button>
          )}
          {newer && (
            <button className="button login-submit" type="button" onClick={() => showNotes(newer)}>
              查看 {newer} 的更新内容
            </button>
          )}
          {direct && (
            <button
              className="button login-submit"
              type="button"
              disabled={connecting}
              onClick={() => install(direct)}
            >
              <Download />
              {downloaded !== null
                ? `正在从 GitHub 下载 ${Math.floor(downloaded * 100)}%`
                : upgrade
                  ? `改从 GitHub 发布页下载 ${direct}`
                  : `从 GitHub 发布页下载并升级到 ${direct}`}
            </button>
          )}
          <button className="button primary login-submit" disabled={connecting}>
            <Unplug />
            {connecting ? '正在连接选中的服务…' : '连接选中的服务'}
          </button>
          <p className="profile-hint">
            只连接选中的服务。使用新版服务端时，账号切换由服务端完成，不需要另填服务器地址。
          </p>
        </form>
        {pool && (
          <details className="legacy-service-pool">
            <summary>多代理服务切换（兼容模式）</summary>
            {pool}
          </details>
        )}
        <div className="login-links">
          <button className="project-link" type="button" onClick={openSettings}>
            <Settings />
            本机设置
          </button>
          {project.url && (
            <button className="project-link" type="button" onClick={openProject}>
              <GithubMark />
              {project.name}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
