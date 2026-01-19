// Password/Credential Manager
// Implementacja zgodna z architekturą:
// - CRUD Credential: createCredential, updateCredential, deleteCredential, getCredential, listCredentials
// - generatePassword(options)
// - używa modules/database/database-config + modules/database/encryption-manager
// - nie zwraca secret wprost do warstw wyższych (IPC), poza kontrolowanym użyciem po stronie backendu.

const { getConnection } = require('../database/database-config');
const { encrypt, decrypt } = require('../database/encryption-manager');
const PasswordGenerator = require('./password-generator');
const Logger = require('../access/logger');

// Model danych Credential (wymagany w schema.sql / migracjach):
// Table: credentials
//  - id              INTEGER PK
//  - name            TEXT            (np. "Prod SSH root", "RDP Admin")
//  - type            TEXT            (np. "ssh", "rdp", "api", "password")
//  - username        TEXT NULL
//  - secret_encrypted TEXT NOT NULL
//  - description     TEXT NULL
//  - tags            TEXT NULL (csv)
//  - created_at      TEXT (ISO)
//  - updated_at      TEXT (ISO)
//  - last_used_at    TEXT NULL
//
// UWAGA: Ten moduł nie powinien być wywoływany bezpośrednio z UI przez IPC z możliwością wycieku secret.
// Ewentualne metody zwracające secret muszą być konsumowane tylko w backendzie (np. ServerManager).

class PasswordManager {
  constructor(logger = null) {
    this.logger = logger || new Logger('password-manager.log');
  }

  async _getDb() {
    return getConnection();
  }

  _normalizeCredentialRow(row, options = {}) {
    if (!row) return null;
    const base = {
      id: row.id,
      name: row.name,
      type: row.type,
      username: row.username,
      description: row.description,
      tags: row.tags
        ? row.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      // secret nie jest domyślnie wystawiany
    };

    if (options.includeSecret && row.secret_encrypted) {
      try {
        base.secret = decrypt(row.secret_encrypted);
      } catch (err) {
        this.logger.error(
          `Błąd odszyfrowania secret dla credential ${row.id}`,
          err
        );
      }
    }

    return base;
  }

  /**
   * Tworzy nowe poświadczenie.
   * @param {Object} data
   *  - name, type, username?, secret, description?, tags?: string[]
   * @returns {Promise<Object>} Credential bez secret
   */
  async createCredential(data) {
    const db = await this._getDb();
    const now = new Date().toISOString();

    const {
      name,
      type,
      username = null,
      secret,
      description = null,
      tags = [],
    } = data || {};

    if (!name || !type || !secret) {
      throw new Error('Brak wymaganych pól: name, type, secret');
    }

    try {
      const encrypted = encrypt(secret);
      const tagsStr = Array.isArray(tags) ? tags.join(',') : tags || '';

      const sql = `
        INSERT INTO credentials (
          name, type, username, secret_encrypted, description, tags, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const res = await db.run(sql, [
        name,
        type,
        username,
        encrypted,
        description,
        tagsStr,
        now,
        now,
      ]);

      const id = res.lastID;
      this.logger.logAction('CREDENTIAL_CREATE', { id, name, type });
      return this.getCredential(id, { includeSecret: false });
    } catch (err) {
      this.logger.error('Błąd tworzenia credential', err, { name, type });
      throw err;
    }
  }

  /**
   * Aktualizuje istniejące poświadczenie.
   * @param {number} id
   * @param {Object} patch
   * @returns {Promise<Object|null>} Credential bez secret
   */
  async updateCredential(id, patch) {
    const db = await this._getDb();
    const now = new Date().toISOString();

    const allowed = ['name', 'type', 'username', 'secret', 'description', 'tags'];
    const sets = [];
    const params = [];

    for (const key of allowed) {
      if (patch[key] !== undefined) {
        if (key === 'secret') {
          sets.push('secret_encrypted = ?');
          params.push(encrypt(patch.secret));
        } else if (key === 'tags') {
          sets.push('tags = ?');
          params.push(
            Array.isArray(patch.tags) ? patch.tags.join(',') : patch.tags
          );
        } else {
          sets.push(`${key} = ?`);
          params.push(patch[key]);
        }
      }
    }

    if (sets.length === 0) {
      return this.getCredential(id, { includeSecret: false });
    }

    sets.push('updated_at = ?');
    params.push(now);
    params.push(id);

    const sql = `UPDATE credentials SET ${sets.join(', ')} WHERE id = ?`;

    try {
      const res = await db.run(sql, params);
      if (!res.changes) {
        return null;
      }
      this.logger.logAction('CREDENTIAL_UPDATE', { id });
      return this.getCredential(id, { includeSecret: false });
    } catch (err) {
      this.logger.error('Błąd aktualizacji credential', err, { id });
      throw err;
    }
  }

  /**
   * Usuwa poświadczenie.
   * @param {number} id
   * @returns {Promise<boolean>}
   */
  async deleteCredential(id) {
    const db = await this._getDb();

    try {
      const sql = 'DELETE FROM credentials WHERE id = ?';
      const res = await db.run(sql, [id]);
      if (res.changes) {
        this.logger.logAction('CREDENTIAL_DELETE', { id });
        return true;
      }
      return false;
    } catch (err) {
      this.logger.error('Błąd usuwania credential', err, { id });
      throw err;
    }
  }

  /**
   * Pobiera credential po ID.
   * Domyślnie BEZ secret.
   * @param {number} id
   * @param {Object} options { includeSecret?: boolean }
   */
  async getCredential(id, options = {}) {
    const db = await this._getDb();
    const sql = 'SELECT * FROM credentials WHERE id = ?';

    try {
      const row = await db.get(sql, [id]);
      const cred = this._normalizeCredentialRow(row, {
        includeSecret: !!options.includeSecret,
      });
      return cred;
    } catch (err) {
      this.logger.error('Błąd pobierania credential', err, { id });
      throw err;
    }
  }

  /**
   * Lista credentiali wg filtra.
   * ZAWSZE bez secret.
   * filter: { type?, tag?, search? }
   */
  async listCredentials(filter = {}) {
    const db = await this._getDb();

    const where = [];
    const params = [];

    if (filter.type) {
      where.push('type = ?');
      params.push(filter.type);
    }
    if (filter.tag) {
      where.push('tags LIKE ?');
      params.push(`%${filter.tag}%`);
    }
    if (filter.search) {
      where.push('(name LIKE ? OR description LIKE ? OR username LIKE ?)');
      const s = `%${filter.search}%`;
      params.push(s, s, s);
    }

    const sql = `
      SELECT * FROM credentials
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
    `;

    try {
      const rows = await db.all(sql, params);
      return rows.map((r) =>
        this._normalizeCredentialRow(r, { includeSecret: false })
      );
    } catch (err) {
      this.logger.error('Błąd listowania credentiali', err);
      throw err;
    }
  }

  /**
   * BEZPIECZNY backend-only helper:
   * Zwraca pełne dane poświadczenia z odszyfrowanym secret.
   * Nie używać bezpośrednio w IPC do UI.
   */
  async getDecryptedSecret(id) {
    const db = await this._getDb();
    const sql =
      'SELECT id, name, type, username, secret_encrypted FROM credentials WHERE id = ?';

    try {
      const row = await db.get(sql, [id]);
      if (!row) return null;

      const secret = decrypt(row.secret_encrypted);
      // Nie logujemy wartości secret.
      this.logger.logAction('CREDENTIAL_SECRET_READ', {
        id: row.id,
        name: row.name,
        type: row.type,
      });

      return {
        id: row.id,
        name: row.name,
        type: row.type,
        username: row.username,
        secret,
      };
    } catch (err) {
      this.logger.error(
        'Błąd odczytu odszyfrowanego secret dla credential',
        err,
        { id }
      );
      throw err;
    }
  }

  /**
   * Generator haseł:
   * options:
   *  - length?: number
   *  - upper?: boolean
   *  - lower?: boolean
   *  - digits?: boolean
   *  - symbols?: boolean
   */
  generatePassword(options = {}) {
    try {
      const length = options.length || 24;
      const password = PasswordGenerator.generatePassword(length, options);
      this.logger.logAction('PASSWORD_GENERATED', {
        length,
        hasUpper: !!options.upper,
        hasLower: !!options.lower,
        hasDigits: !!options.digits,
        hasSymbols: !!options.symbols,
      });
      return password;
    } catch (err) {
      this.logger.error('Błąd generowania hasła', err);
      throw err;
    }
  }
}

module.exports = new PasswordManager();