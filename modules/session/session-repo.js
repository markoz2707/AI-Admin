const crypto = require('crypto');
const { getConnection } = require('../database/database-config');
const Logger = require('../access/logger');

const logger = new Logger('session-repo.log');

function generateToken() {
  // TODO: ew. przejść na signed JWT/HMAC; na razie losowy token 256-bit
  return crypto.randomBytes(32).toString('hex');
}

class SessionRepository {
  constructor() {
    this.conn = getConnection();
  }

  /**
   * Tworzy nową sesję dla użytkownika.
   * @param {number} appUserId
   * @param {object} options
   *  - ttlSeconds?: number
   * @returns {Promise<{id, token, app_user_id, expires_at}>}
   */
  async createSession(appUserId, options = {}) {
    const { ttlSeconds = 60 * 60 * 8 } = options; // domyślnie 8h
    const token = generateToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    try {
      const result = await this.conn.run(
        `
        INSERT INTO sessions (app_user_id, token, created_at, updated_at, expires_at, is_valid)
        VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, 1)
      `,
        [appUserId, token, expiresAt]
      );

      const id = result && (result.lastID || result.lastId || result.id);

      return {
        id,
        token,
        app_user_id: appUserId,
        expires_at: expiresAt,
      };
    } catch (error) {
      logger.error('SessionRepository.createSession failed', error, {
        appUserId,
      });
      throw error;
    }
  }

  /**
   * Pobiera sesję po tokenie (w tym nieważne, do wyższej logiki należy walidacja).
   */
  async getSessionByToken(token) {
    try {
      return await this.conn.get(
        'SELECT * FROM sessions WHERE token = ? LIMIT 1',
        [token]
      );
    } catch (error) {
      logger.error('SessionRepository.getSessionByToken failed', error, {
        tokenSnippet: token ? token.slice(0, 8) : null,
      });
      throw error;
    }
  }

  /**
   * Aktualizuje znacznik updated_at oraz ewentualnie przedłuża ważność.
   */
  async touchSession(id, options = {}) {
    const { extendTtlSeconds = 0 } = options;
    try {
      if (extendTtlSeconds > 0) {
        await this.conn.run(
          `
          UPDATE sessions
          SET updated_at = CURRENT_TIMESTAMP,
              expires_at = DATETIME(CURRENT_TIMESTAMP, ? || ' seconds')
          WHERE id = ? AND is_valid = 1
        `,
          [extendTtlSeconds, id]
        );
      } else {
        await this.conn.run(
          `
          UPDATE sessions
          SET updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND is_valid = 1
        `,
          [id]
        );
      }
    } catch (error) {
      logger.error('SessionRepository.touchSession failed', error, { id });
      throw error;
    }
  }

  async invalidateSession(id) {
    try {
      await this.conn.run(
        `
        UPDATE sessions
        SET is_valid = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        [id]
      );
    } catch (error) {
      logger.error('SessionRepository.invalidateSession failed', error, { id });
      throw error;
    }
  }

  async invalidateByToken(token) {
    try {
      await this.conn.run(
        `
        UPDATE sessions
        SET is_valid = 0, updated_at = CURRENT_TIMESTAMP
        WHERE token = ?
      `,
        [token]
      );
    } catch (error) {
      logger.error(
        'SessionRepository.invalidateByToken failed',
        error,
        {
          tokenSnippet: token ? token.slice(0, 8) : null,
        }
      );
      throw error;
    }
  }

  /**
   * Usuwa/przestawia jako nieważne sesje wygasłe.
   */
  async cleanupExpired() {
    try {
      await this.conn.run(
        `
        UPDATE sessions
        SET is_valid = 0
        WHERE is_valid = 1
          AND expires_at IS NOT NULL
          AND expires_at < CURRENT_TIMESTAMP
      `
      );
    } catch (error) {
      logger.error('SessionRepository.cleanupExpired failed', error);
      throw error;
    }
  }
}

module.exports = new SessionRepository();