// ServerManager - pełny CRUD encji Server + integracja z AccessManager, Credential, CommandHistory,
// oraz metody proxy do ServiceManager/UserManager/ShareManager.
// Gotowe do użycia z warstwą IPC jako czysto asynchroniczne API na plain objects.

const { AccessManager } = require('../access');
const ServiceManager = require('./service-manager');
const UserManager = require('./user-manager');
const ShareManager = require('./share-manager');
const { getConnection } = require('../database/database-config');
const { encrypt } = require('../database/encryption-manager');

// Tabela Servers (model docelowy - definicja w schema.sql / migracjach):
// { id, name, host, port, os, accessType, environment, tags, description,
//   isFavorite, isEnabled, credentialId, createdAt, updatedAt, lastCheckAt, lastCheckStatus }
//
// Tabela CommandHistory (TODO w schema.sql):
// { id, serverId, command, stdout, stderr, exitCode, createdAt }

class ServerManager {
 constructor(accessManager = null, logger = null) {
   this.accessManager = accessManager || new AccessManager();
   this.logger = logger || this.accessManager.logger;
   this.serviceManager = new ServiceManager(this.accessManager, this.logger);
   this.userManager = new UserManager(this.accessManager, this.logger);
   this.shareManager = new ShareManager(this.accessManager, this.logger);
 }

  // --- Helpers ---

  _normalizeServerRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      os: row.os,
      accessType: row.access_type,
      environment: row.environment,
      tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      description: row.description,
      isFavorite: !!row.is_favorite,
      isEnabled: !!row.is_enabled,
      credentialId: row.credential_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastCheckAt: row.last_check_at,
      lastCheckStatus: row.last_check_status,
    };
  }

  async _getDb() {
    return getConnection();
  }

 async _logCommandHistory(serverId, command, result, options = {}) {
   // Zachowany helper (nieużywany z nowym CommandHistoryRepository, ale pozostawiony dla kompatybilności).
   try {
     const db = await this._getDb();
     const sql = `
       INSERT INTO command_history (server_id, command, result, exit_code, created_at)
       VALUES (?, ?, ?, ?, ?)
     `;
     const createdAt = new Date().toISOString();
     await db.run(sql, [
       serverId,
       command,
       result ? String(result).slice(0, 4000) : '',
       typeof (result && (result.code ?? result.exitCode)) === 'number'
         ? (result.code ?? result.exitCode)
         : null,
       createdAt,
     ]);
   } catch (err) {
     this.logger &&
       this.logger.error(
         `Nie udało się zapisać CommandHistory (legacy) dla ${serverId}: ${err.message}`
       );
   }
 }

  // --- CRUD: Server ---

  /**
   * Tworzy nowy serwer.
   * @param {Object} data
   * @returns {Promise<Object>} Server
   */
  async createServer(data) {
    const db = await this._getDb();
    const now = new Date().toISOString();

    const {
      name,
      host,
      port = 22,
      os,
      accessType = 'ssh',
      environment = null,
      tags = [],
      description = null,
      isFavorite = false,
      isEnabled = true,
      credentialId = null,
    } = data;

    if (!name || !host || !os) {
      throw new Error('Brak wymaganych pól: name, host, os');
    }

    try {
      const sql = `
        INSERT INTO servers (
          name, host, port, os, access_type, environment, tags, description,
          is_favorite, is_enabled, credential_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');

      const res = await db.run(sql, [
        name,
        host,
        port,
        os.toLowerCase(),
        accessType.toLowerCase(),
        environment,
        tagsStr,
        description,
        isFavorite ? 1 : 0,
        isEnabled ? 1 : 0,
        credentialId,
        now,
        now,
      ]);

      const id = res.lastID;
      this.logger && this.logger.info(`Utworzono serwer ID=${id} (${name}@${host})`);
      return this.getServer(id);
    } catch (err) {
      this.logger && this.logger.error(`Błąd tworzenia serwera: ${err.message}`);
      throw err;
    }
  }

  /**
   * Aktualizuje istniejący serwer.
   * @param {number} id
   * @param {Object} patch
   * @returns {Promise<Object|null>} Server po aktualizacji
   */
  async updateServer(id, patch) {
    const db = await this._getDb();
    const now = new Date().toISOString();

    const allowed = [
      'name',
      'host',
      'port',
      'os',
      'accessType',
      'environment',
      'tags',
      'description',
      'isFavorite',
      'isEnabled',
      'credentialId',
      'lastCheckAt',
      'lastCheckStatus',
    ];

    const sets = [];
    const params = [];

    for (const key of allowed) {
      if (patch[key] !== undefined) {
        switch (key) {
          case 'accessType':
            sets.push('access_type = ?');
            params.push(String(patch[key]).toLowerCase());
            break;
          case 'isFavorite':
            sets.push('is_favorite = ?');
            params.push(patch[key] ? 1 : 0);
            break;
          case 'isEnabled':
            sets.push('is_enabled = ?');
            params.push(patch[key] ? 1 : 0);
            break;
          case 'credentialId':
            sets.push('credential_id = ?');
            params.push(patch[key]);
            break;
          case 'tags':
            sets.push('tags = ?');
            params.push(Array.isArray(patch[key]) ? patch[key].join(',') : patch[key]);
            break;
          case 'lastCheckAt':
            sets.push('last_check_at = ?');
            params.push(patch[key]);
            break;
          case 'lastCheckStatus':
            sets.push('last_check_status = ?');
            params.push(patch[key]);
            break;
          default:
            sets.push(`${key.toLowerCase()} = ?`);
            params.push(patch[key]);
        }
      }
    }

    if (sets.length === 0) {
      return this.getServer(id);
    }

    sets.push('updated_at = ?');
    params.push(now);
    params.push(id);

    const sql = `UPDATE servers SET ${sets.join(', ')} WHERE id = ?`;

    try {
      const res = await db.run(sql, params);
      if (!res.changes) {
        return null;
      }
      this.logger && this.logger.info(`Zaktualizowano serwer ID=${id}`);
      return this.getServer(id);
    } catch (err) {
      this.logger && this.logger.error(`Błąd aktualizacji serwera ID=${id}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Usuwa serwer.
   * @param {number} id
   * @returns {Promise<boolean>}
   */
  async deleteServer(id) {
    const db = await this._getDb();

    try {
      // Rozłącz, jeśli połączony.
      if (this.accessManager.isConnected(id)) {
        await this.disconnectFromServer(id);
      }

      const sql = 'DELETE FROM servers WHERE id = ?';
      const res = await db.run(sql, [id]);
      if (res.changes) {
        this.logger && this.logger.info(`Usunięto serwer ID=${id}`);
        return true;
      }
      return false;
    } catch (err) {
      this.logger && this.logger.error(`Błąd usuwania serwera ID=${id}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Pobiera pojedynczy serwer.
   * @param {number} id
   * @returns {Promise<Object|null>}
   */
  async getServer(id) {
    const db = await this._getDb();
    const sql = 'SELECT * FROM servers WHERE id = ?';

    try {
      const row = await db.get(sql, [id]);
      const server = this._normalizeServerRow(row);
      if (server) {
        server.connected = this.isServerConnected(server.id);
      }
      return server;
    } catch (err) {
      this.logger && this.logger.error(`Błąd pobierania serwera ID=${id}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Listuje serwery z opcjonalnym filtrem.
   * filter: { environment, isFavorite, isEnabled, search, tag, accessType, os }
   * @returns {Promise<Array<Object>>}
   */
  async listServers(filter = {}) {
    const db = await this._getDb();

    const where = [];
    const params = [];

    if (filter.environment) {
      where.push('environment = ?');
      params.push(filter.environment);
    }
    if (filter.isFavorite !== undefined) {
      where.push('is_favorite = ?');
      params.push(filter.isFavorite ? 1 : 0);
    }
    if (filter.isEnabled !== undefined) {
      where.push('is_enabled = ?');
      params.push(filter.isEnabled ? 1 : 0);
    }
    if (filter.accessType) {
      where.push('access_type = ?');
      params.push(filter.accessType.toLowerCase());
    }
    if (filter.os) {
      where.push('os = ?');
      params.push(filter.os.toLowerCase());
    }
    if (filter.tag) {
      where.push('tags LIKE ?');
      params.push(`%${filter.tag}%`);
    }
    if (filter.search) {
      where.push('(name LIKE ? OR host LIKE ? OR description LIKE ?)');
      const s = `%${filter.search}%`;
      params.push(s, s, s);
    }

    const sql = `
      SELECT * FROM servers
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY is_favorite DESC, name ASC
    `;

    try {
      const rows = await db.all(sql, params);
      return rows.map((r) => {
        const server = this._normalizeServerRow(r);
        server.connected = this.isServerConnected(server.id);
        return server;
      });
    } catch (err) {
      this.logger && this.logger.error(`Błąd listowania serwerów: ${err.message}`);
      throw err;
    }
  }

  // --- Połączenia / AccessManager ---

  /**
   * Buduje config połączenia na podstawie danych serwera i Credential.
   * Credential powinien być pobrany z dedykowanego modułu password-manager/credentials
   * (tutaj zostawiamy tylko hook pod decrypt i integrację).
   */
  async _buildAccessConfig(server) {
    const config = {
      host: server.host,
      port: server.port || 22,
    };

    // Pobierz dane logowania z menedżera haseł jeśli przypisano credential
    if (server.credentialId) {
      try {
        const passwordManager = require('../password-manager/password-manager');
        const credential = await passwordManager.getDecryptedSecret(server.credentialId);
        if (credential) {
          config.username = credential.username;
          config.password = credential.secret;
        }
      } catch (err) {
        this.logger && this.logger.error(`Błąd pobierania credential dla serwera ${server.id}: ${err.message}`);
      }
    }

    if (!config.username) {
      throw new Error('Brak danych logowania (username). Przypisz credential do serwera.');
    }

    return config;
  }

  /**
   * Łączy się z serwerem używając AccessManager.
   * @param {number} serverId
   */
  async connectToServer(serverId) {
    const server = await this.getServer(serverId);
    if (!server) {
      throw new Error(`Serwer ${serverId} nie istnieje`);
    }
    if (!server.isEnabled) {
      throw new Error(`Serwer ${serverId} jest wyłączony`);
    }

    const config = await this._buildAccessConfig(server);

    try {
      await this.accessManager.connect(
        server.id,
        server.accessType || 'ssh',
        config
      );
      this.logger && this.logger.info(`Połączono z serwerem ${serverId}`);
      this.logger && this.logger.logConnectionSuccess && this.logger.logConnectionSuccess(serverId, server.accessType || 'ssh');
    } catch (err) {
      this.logger && this.logger.error(`Błąd łączenia z serwerem ${serverId}: ${err.message}`);
      this.logger && this.logger.logConnectionError && this.logger.logConnectionError(serverId, server.accessType || 'ssh', err);
      throw err;
    }
  }

  /**
   * Rozłącza z serwerem.
   * @param {number} serverId
   */
  async disconnectFromServer(serverId) {
    try {
      await this.accessManager.disconnect(serverId);
      this.logger && this.logger.info(`Rozłączono z serwerem ${serverId}`);
      this.logger && this.logger.logDisconnection && this.logger.logDisconnection(serverId, '');
    } catch (err) {
      this.logger && this.logger.error(`Błąd rozłączania z serwerem ${serverId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Czy jest aktywne połączenie z serwerem.
   * @param {number} serverId
   * @returns {boolean}
   */
  isServerConnected(serverId) {
    return this.accessManager.isConnected(serverId);
  }

 /**
  * Wykonuje polecenie na serwerze i zapisuje w CommandHistory + AuditLog.
  * @param {number} serverId
  * @param {string} command
  * @param {Object} [options]
  *  - actorUserId?: number
  *  - source?: 'ui' | 'llm' | 'system'
  */
 async executeCommand(serverId, command, options = {}) {
   const { actorUserId = null, source = 'ui' } = options;

   if (!this.isServerConnected(serverId)) {
     throw new Error(`Brak połączenia z serwerem ${serverId}`);
   }

   try {
     const result = await this.accessManager.executeCommand(serverId, command);

     // Persistencja historii
     try {
       const db = await this._getDb();
       await db.run(
         `
         INSERT INTO command_history (
           server_id,
           app_user_id,
           source,
           command,
           result,
           exit_code,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       `,
         [
           serverId,
           actorUserId,
           source,
           command,
           result ? String(result).slice(0, 4000) : '',
           typeof (result && (result.code ?? result.exitCode)) === 'number'
             ? (result.code ?? result.exitCode)
             : 0,
         ]
       );
     } catch (historyErr) {
       this.logger &&
         this.logger.error(
           'Nie udało się zapisać wpisu CommandHistory',
           historyErr,
           { serverId, actorUserId, source }
         );
     }

     // Audit
     if (this.logger && this.logger.logAuditLike) {
       this.logger.logAuditLike({
         actionType: 'COMMAND_EXECUTE',
         targetType: 'server',
         targetId: serverId,
         actorUserId,
         source,
         success: true,
         details: { command },
       });
     }

     return result;
   } catch (err) {
     if (this.logger && this.logger.logAuditLike) {
       this.logger.logAuditLike({
         actionType: 'COMMAND_EXECUTE',
         targetType: 'server',
         targetId: serverId,
         actorUserId,
         source,
         success: false,
         details: { command, error: err.message },
       });
     }
     this.logger &&
       this.logger.error(
         `Błąd wykonania polecenia na serwerze ${serverId}: ${err.message}`,
         err
       );
     throw err;
   }
 }

  /**
   * Rozłącza wszystkie aktywne połączenia.
   */
  async disconnectAll() {
    await this.accessManager.disconnectAll();
    this.logger && this.logger.info('Wszystkie połączenia zostały rozłączone');
  }

  // --- Proxy: Services / Users / Shares ---

  /**
   * Zarządzanie usługami na serwerze (delegacja do ServiceManager).
   * @param {number} serverId
   * @param {string} action
   * @param {Object} params
   */
  async manageServices(serverId, action, params = {}) {
    const server = await this.getServer(serverId);
    if (!server) {
      throw new Error(`Serwer ${serverId} nie istnieje`);
    }
    if (!this.isServerConnected(serverId)) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }

    try {
      switch (action) {
        case 'list':
          return await this.serviceManager.listServices(serverId, server.os);
        case 'start':
          return await this.serviceManager.startService(serverId, params.serviceName, server.os);
        case 'stop':
          return await this.serviceManager.stopService(serverId, params.serviceName, server.os);
        case 'restart':
          return await this.serviceManager.restartService(serverId, params.serviceName, server.os);
        case 'install':
          return await this.serviceManager.installService(serverId, params.serviceName, params.servicePath, server.os);
        case 'uninstall':
          return await this.serviceManager.uninstallService(serverId, params.serviceName, server.os);
        default:
          throw new Error(`Nieobsługiwana akcja usług: ${action}`);
      }
    } catch (err) {
      this.logger && this.logger.error(`Błąd manageServices(${action}) na serwerze ${serverId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Zarządzanie użytkownikami systemowymi (delegacja do UserManager).
   */
  async manageUsers(serverId, action, params = {}) {
    const server = await this.getServer(serverId);
    if (!server) {
      throw new Error(`Serwer ${serverId} nie istnieje`);
    }
    if (!this.isServerConnected(serverId)) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }

    try {
      switch (action) {
        case 'list':
          return await this.userManager.listUsers(serverId, server.os);
        case 'add':
          return await this.userManager.addUser(serverId, params.username, params.password, server.os, params.options);
        case 'remove':
          return await this.userManager.removeUser(serverId, params.username, server.os);
        case 'changePassword':
          return await this.userManager.changePassword(serverId, params.username, params.newPassword, server.os);
        case 'addToGroup':
          return await this.userManager.addToGroup(serverId, params.username, params.groupName, server.os);
        case 'removeFromGroup':
          return await this.userManager.removeFromGroup(serverId, params.username, params.groupName, server.os);
        default:
          throw new Error(`Nieobsługiwana akcja użytkowników: ${action}`);
      }
    } catch (err) {
      this.logger && this.logger.error(`Błąd manageUsers(${action}) na serwerze ${serverId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Zarządzanie udziałami (delegacja do ShareManager).
   */
  async manageShares(serverId, action, params = {}) {
    const server = await this.getServer(serverId);
    if (!server) {
      throw new Error(`Serwer ${serverId} nie istnieje`);
    }
    if (!this.isServerConnected(serverId)) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }

    try {
      switch (action) {
        case 'list':
          return await this.shareManager.listShares(serverId, server.os);
        case 'create':
          return await this.shareManager.createShare(serverId, params.shareName, params.sharePath, server.os, params.options);
        case 'delete':
          return await this.shareManager.deleteShare(serverId, params.shareName, server.os);
        case 'modifyPermissions':
          return await this.shareManager.modifySharePermissions(serverId, params.shareName, params.permissions, server.os);
        default:
          throw new Error(`Nieobsługiwana akcja udziałów: ${action}`);
      }
    } catch (err) {
      this.logger && this.logger.error(`Błąd manageShares(${action}) na serwerze ${serverId}: ${err.message}`);
      throw err;
    }
  }
}

module.exports = ServerManager;