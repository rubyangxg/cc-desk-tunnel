import type { DatabaseSync } from 'node:sqlite';
import { projectPathKey } from '@cc-desk-tunnel/protocol';

// A project belongs to a device. Identical paths on another computer have independent settings.
export class ProjectQuotaSettings {
  private database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
    database.exec(`CREATE TABLE IF NOT EXISTS project_quota_resume (
      device_id TEXT NOT NULL, project_path TEXT NOT NULL,
      PRIMARY KEY (device_id, project_path)
    )`);
  }
  enabled(deviceId: string, projectPath: string) {
    return !!this.database
      .prepare('SELECT 1 FROM project_quota_resume WHERE device_id = ? AND project_path = ?')
      .get(deviceId, projectPathKey(projectPath));
  }
  set(deviceId: string, projectPath: string, enabled: boolean) {
    this.database
      .prepare(
        enabled
          ? 'INSERT OR IGNORE INTO project_quota_resume VALUES (?, ?)'
          : 'DELETE FROM project_quota_resume WHERE device_id = ? AND project_path = ?',
      )
      .run(deviceId, projectPathKey(projectPath));
  }
  list() {
    return this.database
      .prepare('SELECT * FROM project_quota_resume')
      .all()
      .map((row) => ({
        deviceId: String(row.device_id),
        projectPath: String(row.project_path),
      }));
  }
}
