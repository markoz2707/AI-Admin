// SyncManager przygotowany pod snapshoty oraz współpracę z SQLite i encryption-manager.
// Utrzymuje minimalny, stabilny kontrakt używany przez wyższe warstwy.

const { getConnection } = require('./database-config');
const { encrypt, decrypt } = require('./encryption-manager');

class SyncManager {
  constructor() {
    this.initialized = false;
  }

  /**
   * Inicjalizacja ewentualnych struktur pomocniczych.
   * Obecnie zakładamy, że runMigrations() utworzył wymagane tabele (TODO w schema.sql):
   * - service_snapshots
   * - system_user_snapshots
   * - share_snapshots
   * - inne meta-tabele synchronizacji
   */
  async init() {
    if (this.initialized) return;
    // Brak twardych zależności – zakładamy, że migracje zostały wykonane przez migration-manager.
    this.initialized = true;
  }

  /**
   * Zapisuje snapshot usług dla serwera.
   * @param {Object} snapshot { serverId, data, collectedAt }
   * data może być tablicą usług; jest serializowana do JSON i opcjonalnie szyfrowana.
   */
  async saveServiceSnapshot(snapshot) {
    await this.init();
    const conn = getConnection();
    const { serverId, data, collectedAt } = snapshot;
    const collectedTimestamp = collectedAt || new Date().toISOString();

    if (!Array.isArray(data)) {
      console.error('Service snapshot data is not an array.');
      return;
    }

    const sql = `
      INSERT INTO service_snapshots (server_id, name, status, extra, captured_at)
      VALUES (?, ?, ?, ?, ?)
    `;

    try {
      await conn.run('BEGIN');
      for (const service of data) {
        await conn.run(sql, [
          serverId,
          service.name,
          service.status,
          JSON.stringify(service.extra || {}),
          collectedTimestamp,
        ]);
      }
      await conn.run('COMMIT');
    } catch (err) {
      console.error('Failed to save service snapshot:', err);
      await conn.run('ROLLBACK');
      throw err;
    }
  }

  /**
   * Zwraca ostatni snapshot usług dla serwera.
   */
  async getLatestServiceSnapshot(serverId) {
    await this.init();
    const conn = getConnection();

    const sql = `
      SELECT name, status, extra, captured_at
      FROM service_snapshots
      WHERE server_id = ? AND captured_at = (
        SELECT MAX(captured_at)
        FROM service_snapshots
        WHERE server_id = ?
      )
    `;
    const rows = await conn.all(sql, [serverId, serverId]);
    if (!rows || rows.length === 0) return null;

    const data = rows.map(row => ({
      name: row.name,
      status: row.status,
      extra: safeJsonParse(row.extra, {}),
    }));

    return {
      serverId,
      data,
      collectedAt: rows[0].captured_at,
    };
  }

  /**
   * Zapisuje snapshot użytkowników systemowych.
   * @param {Object} snapshot { serverId, data, collectedAt }
   */
  async saveSystemUserSnapshot(snapshot) {
    await this.init();
    const conn = getConnection();
    const { serverId, data, collectedAt } = snapshot;
    const collectedTimestamp = collectedAt || new Date().toISOString();

    if (!Array.isArray(data)) {
      console.error('System user snapshot data is not an array.');
      return;
    }

    const sql = `
      INSERT INTO system_user_snapshots (server_id, username, uid, gid, home, shell, groups, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    try {
      await conn.run('BEGIN');
      for (const user of data) {
        await conn.run(sql, [
          serverId,
          user.username,
          user.uid,
          user.gid,
          user.home,
          user.shell,
          JSON.stringify(user.groups || []),
          collectedTimestamp,
        ]);
      }
      await conn.run('COMMIT');
    } catch (err) {
      console.error('Failed to save system user snapshot:', err);
      await conn.run('ROLLBACK');
      throw err;
    }
  }

  async getLatestSystemUserSnapshot(serverId) {
    await this.init();
    const conn = getConnection();

    const sql = `
      SELECT username, uid, gid, home, shell, groups, captured_at
      FROM system_user_snapshots
      WHERE server_id = ? AND captured_at = (
        SELECT MAX(captured_at)
        FROM system_user_snapshots
        WHERE server_id = ?
      )
    `;
    const rows = await conn.all(sql, [serverId, serverId]);
    if (!rows || rows.length === 0) return null;

    const data = rows.map(row => ({
      username: row.username,
      uid: row.uid,
      gid: row.gid,
      home: row.home,
      shell: row.shell,
      groups: safeJsonParse(row.groups, []),
    }));

    return {
      serverId,
      data,
      collectedAt: rows[0].captured_at,
    };
  }

  /**
   * Zapisuje snapshot udziałów.
   * @param {Object} snapshot { serverId, data, collectedAt }
   */
  async saveShareSnapshot(snapshot) {
    await this.init();
    const conn = getConnection();
    const { serverId, data, collectedAt } = snapshot;
    const collectedTimestamp = collectedAt || new Date().toISOString();

    if (!Array.isArray(data)) {
      console.error('Share snapshot data is not an array.');
      return;
    }

    const sql = `
      INSERT INTO share_snapshots (server_id, name, path, permissions, extra, captured_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    try {
      await conn.run('BEGIN');
      for (const share of data) {
        await conn.run(sql, [
          serverId,
          share.name,
          share.path,
          share.permissions,
          JSON.stringify(share.extra || {}),
          collectedTimestamp,
        ]);
      }
      await conn.run('COMMIT');
    } catch (err) {
      console.error('Failed to save share snapshot:', err);
      await conn.run('ROLLBACK');
      throw err;
    }
  }

  async getLatestShareSnapshot(serverId) {
    await this.init();
    const conn = getConnection();

    const sql = `
      SELECT name, path, permissions, extra, captured_at
      FROM share_snapshots
      WHERE server_id = ? AND captured_at = (
        SELECT MAX(captured_at)
        FROM share_snapshots
        WHERE server_id = ?
      )
    `;
    const rows = await conn.all(sql, [serverId, serverId]);
    if (!rows || rows.length === 0) return null;

    const data = rows.map(row => ({
      name: row.name,
      path: row.path,
      permissions: row.permissions,
      extra: safeJsonParse(row.extra, {}),
    }));

    return {
      serverId,
      data,
      collectedAt: rows[0].captured_at,
    };
  }

  /**
   * API pod dalszą synchronizację rozproszoną:
   * Poniższe metody stanowią stabilne punkty rozszerzeń i mogą być
   * zaimplementowane z wykorzystaniem powyższych snapshotów i tabel meta.
   */

  /**
   * Zwraca ogólny status synchronizacji dla danego serwera.
   * Obecnie mock, przygotowany pod rozszerzenie.
   */
  async getSyncStatus(serverId) {
    await this.init();

    // TODO: rozbudować o realne dane (ostatnie snapshoty, ewentualne konflikty).
    return {
      serverId,
      lastServiceSnapshotAt: null,
      lastSystemUserSnapshotAt: null,
      lastShareSnapshotAt: null,
      status: 'not_implemented', // placeholder
    };
  }

  /**
   * Rezerwowe API do replikacji danych pomiędzy instancjami.
   * Aktualnie stanowi placeholder bez implementacji.
   */
  async syncWithRemoteNode(_serverId, _remoteConfig) {
    // TODO: implementacja synchronizacji z węzłem zdalnym (HTTP/gRPC/WebSocket itp.).
    // Interfejs zostaje, aby wyższe warstwy mogły go wywołać bez zmian.
    return {
      status: 'not_implemented',
    };
  }
}

/**
 * Bezpieczny parse JSON bez rzucania wyjątku.
 */
function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

module.exports = new SyncManager();