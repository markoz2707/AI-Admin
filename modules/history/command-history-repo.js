const { getConnection } = require('../database/database-config');
const Logger = require('../access/logger');

const logger = new Logger('command-history-repo.log');

class CommandHistoryRepository {
  constructor() {
    this.conn = getConnection();
  }

  /**
   * Wstawia nowy wpis historii poleceń.
   * @param {Object} data
   *  - serverId (wymagane)
   *  - appUserId
   *  - source: 'ui' | 'llm' | 'system' | inne
   *  - command (wymagane)
   *  - result
   *  - exitCode
   */
  async insert(data) {
    const {
      serverId,
      appUserId = null,
      source = 'ui',
      command,
      result = null,
      exitCode = null,
    } = data || {};

    if (!serverId) {
      throw new Error('CommandHistoryRepository.insert: serverId is required');
    }
    if (!command) {
      throw new Error('CommandHistoryRepository.insert: command is required');
    }

    try {
      await this.conn.run(
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
          appUserId,
          source,
          command,
          result,
          exitCode,
        ]
      );
    } catch (error) {
      logger.error('CommandHistoryRepository.insert failed', error, {
        serverId,
        appUserId,
        source,
      });
      throw error;
    }
  }

  /**
   * Lista historii dla danego serwera (i opcjonalnie użytkownika).
   * @param {Object} filter
   *  - serverId (wymagane)
   *  - appUserId
   *  - source
   *  - from (ISO)
   *  - to (ISO)
   * @param {Object} pagination
   *  - limit (default 100, max 500)
   *  - offset (default 0)
   */
  async list(filter = {}, pagination = {}) {
    const {
      serverId,
      appUserId,
      source,
      from,
      to,
    } = filter;

    if (!serverId) {
      throw new Error('CommandHistoryRepository.list: serverId is required');
    }

    const { limit = 100, offset = 0 } = pagination;

    const where = ['server_id = ?'];
    const params = [serverId];

    if (appUserId) {
      where.push('app_user_id = ?');
      params.push(appUserId);
    }

    if (source) {
      where.push('source = ?');
      params.push(source);
    }

    if (from) {
      where.push('created_at >= ?');
      params.push(from);
    }

    if (to) {
      where.push('created_at <= ?');
      params.push(to);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const safeLimit = Math.max(
      1,
      Math.min(parseInt(limit, 10) || 100, 500)
    );
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    const sql = `
      SELECT *
      FROM command_history
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ${safeLimit}
      OFFSET ${safeOffset}
    `;

    try {
      return await this.conn.all(sql, params);
    } catch (error) {
      logger.error('CommandHistoryRepository.list failed', error, {
        filter,
        pagination,
      });
      throw error;
    }
  }
}

module.exports = new CommandHistoryRepository();