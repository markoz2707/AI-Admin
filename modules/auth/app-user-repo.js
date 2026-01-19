const crypto = require('crypto');
const { getConnection } = require('../database/database-config');
const Logger = require('../access/logger');

const logger = new Logger('auth-app-user-repo.log');

/**
 * Prosty wrapper na hashowanie haseł.
 * Docelowo warto podmienić na scrypt/bcrypt/argon2.
 */
function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required for hashing');
  }

  try {
    // TODO: Zastąpić mocniejszym KDF (scrypt/argon2/bcrypt) + salt w konfiguracji.
    return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
  } catch (err) {
    logger.error('Błąd podczas generowania hash hasła', err);
    throw err;
  }
}

class AppUserRepository {
  constructor() {
    this.conn = getConnection();
  }

  async getByUsername(username) {
    try {
      return await this.conn.get(
        'SELECT * FROM app_users WHERE username = ? LIMIT 1',
        [username]
      );
    } catch (error) {
      logger.error('AppUserRepository.getByUsername failed', error, {
        username,
      });
      throw error;
    }
  }

  async getById(id) {
    try {
      return await this.conn.get(
        'SELECT * FROM app_users WHERE id = ? LIMIT 1',
        [id]
      );
    } catch (error) {
      logger.error('AppUserRepository.getById failed', error, { id });
      throw error;
    }
  }

  async create(username, password, role = 'admin', isActive = 1) {
    const passwordHash = hashPassword(password);
    try {
      const result = await this.conn.run(
        `
        INSERT INTO app_users (username, password_hash, role, is_active)
        VALUES (?, ?, ?, ?)
      `,
        [username, passwordHash, role, isActive ? 1 : 0]
      );

      const id = result && (result.lastID || result.lastId || result.id);
      return this.getById(id);
    } catch (error) {
      logger.error('AppUserRepository.create failed', error, {
        username,
        role,
      });
      throw error;
    }
  }

  /**
   * Tworzy konto admina, jeśli tabela jest pusta.
   * Hasło generowane losowo; wypisywane do loga z ostrzeżeniem.
   */
  async createInitialAdminIfEmpty() {
    try {
      const row = await this.conn.get(
        'SELECT COUNT(1) as cnt FROM app_users',
        []
      );
      if (row && row.cnt > 0) {
        return null;
      }

      const username = 'admin';
      const password = crypto.randomBytes(12).toString('base64url');
      const passwordHash = hashPassword(password);

      const result = await this.conn.run(
        `
        INSERT INTO app_users (username, password_hash, role, is_active)
        VALUES (?, ?, 'admin', 1)
      `,
        [username, passwordHash]
      );

      const id = result && (result.lastID || result.lastId || result.id);

      logger.warn(
        'Utworzono początkowego użytkownika admin. Zmień hasło po pierwszym zalogowaniu.',
        { username, generatedPassword: password }
      );

      return { id, username, password, role: 'admin' };
    } catch (error) {
      logger.error(
        'AppUserRepository.createInitialAdminIfEmpty failed',
        error
      );
      throw error;
    }
  }

  async verifyPassword(username, password) {
    try {
      const user = await this.getByUsername(username);
      if (!user || !user.password_hash) {
        return null;
      }
      const candidate = hashPassword(password);
      if (candidate !== user.password_hash) {
        return null;
      }
      return user;
    } catch (error) {
      logger.error('AppUserRepository.verifyPassword failed', error, {
        username,
      });
      throw error;
    }
  }
}

module.exports = new AppUserRepository();