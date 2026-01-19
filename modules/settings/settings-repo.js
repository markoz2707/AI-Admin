const { getConnection } = require('../database/database-config');
const Logger = require('../access/logger');

const logger = new Logger('settings-repo.log');

class SettingsRepository {
  constructor() {
    this.conn = getConnection();
  }

  /**
   * Pobiera wartość ustawienia.
   * @param {string} scope - 'global' | 'user' | 'server' | inne
   * @param {string} key
   * @param {number} [appUserId]
   * @param {number} [serverId]
   * @returns {Promise<any|null>}
   */
  async get(scope, key, appUserId, serverId) {
    try {
      const row = await this.conn.get(
        `
        SELECT value
        FROM settings
        WHERE scope = ?
          AND key = ?
          AND (app_user_id IS NULL OR app_user_id = COALESCE(?, app_user_id))
          AND (server_id IS NULL OR server_id = COALESCE(?, server_id))
        ORDER BY
          CASE WHEN app_user_id IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN server_id IS NOT NULL THEN 0 ELSE 1 END,
          id DESC
        LIMIT 1
      `,
        [scope, key, appUserId || null, serverId || null]
      );

      if (!row) return null;

      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    } catch (error) {
      logger.error('SettingsRepository.get failed', error, {
        scope,
        key,
        appUserId,
        serverId,
      });
      throw error;
    }
  }

  /**
   * Ustawia wartość ustawienia (upsert).
   * @param {string} scope
   * @param {string} key
   * @param {any} value
   * @param {number} [appUserId]
   * @param {number} [serverId]
   */
  async set(scope, key, value, appUserId, serverId) {
    const jsonValue =
      typeof value === 'string' ? value : JSON.stringify(value);

    const normUserId = appUserId || null;
    const normServerId = serverId || null;

    try {
      // Check if record exists
      const existing = await this.conn.get(
        `
        SELECT id FROM settings
        WHERE scope = ?
          AND key = ?
          AND (app_user_id IS ? OR (app_user_id IS NOT NULL AND app_user_id = ?))
          AND (server_id IS ? OR (server_id IS NOT NULL AND server_id = ?))
        LIMIT 1
        `,
        [scope, key, normUserId, normUserId, normServerId, normServerId]
      );

      if (existing) {
        // Update existing record
        await this.conn.run(
          `
          UPDATE settings
          SET value = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `,
          [jsonValue, existing.id]
        );
      } else {
        // Insert new record
        await this.conn.run(
          `
          INSERT INTO settings (scope, key, value, app_user_id, server_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `,
          [scope, key, jsonValue, normUserId, normServerId]
        );
      }
    } catch (error) {
      logger.error('SettingsRepository.set failed', error, {
        scope,
        key,
        appUserId: normUserId,
        serverId: normServerId,
      });
      throw error;
    }
  }

  /**
   * Pobiera wiele ustawień wg prefiksu klucza.
   * Zwraca mapę key -> parsedValue.
   */
  async getByPrefix(scope, prefix, appUserId, serverId) {
    try {
      const rows = await this.conn.all(
        `
        SELECT key, value
        FROM settings
        WHERE scope = ?
          AND key LIKE ?
          AND (app_user_id IS NULL OR app_user_id = COALESCE(?, app_user_id))
          AND (server_id IS NULL OR server_id = COALESCE(?, server_id))
        ORDER BY id DESC
      `,
        [scope, `${prefix}%`, appUserId || null, serverId || null]
      );

      const result = {};
      for (const row of rows || []) {
        try {
          result[row.key] = JSON.parse(row.value);
        } catch {
          result[row.key] = row.value;
        }
      }
      return result;
    } catch (error) {
      logger.error('SettingsRepository.getByPrefix failed', error, {
        scope,
        prefix,
        appUserId,
        serverId,
      });
      throw error;
    }
  }
}

module.exports = new SettingsRepository();