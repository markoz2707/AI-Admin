const { getConnection } = require('../database/database-config');

/**
 * AuditLogRepository
 *
 * Ważne:
 * - Ten moduł jest używany pośrednio przez logger (logger.logAuditLike),
 *   dlatego musi być odporny na cykliczne zależności.
 * - NIE importujemy Logger na poziomie top-level i NIE tworzymy tu jego instancji.
 * - Wszystkie błędy traktujemy miękko: w razie problemu z DB nie blokujemy startu aplikacji.
 */

const AuditLogRepository = {
  /**
   * Wstawia wpis audytowy do bazy (jeśli dostępna).
   * W przypadku braku DB lub błędu – loguje do konsoli i zwraca stub.
   */
  async insert(entry) {
    try {
      const conn = getConnection();
      if (!conn || typeof conn.run !== 'function') {
        console.log('[AuditLogRepo] insert (no-db stub)', entry);
        return { id: Date.now(), ...entry };
      }

      const {
        actionType,
        targetType = null,
        targetId = null,
        actorUserId = null,
        sessionId = null,
        source = null,
        success = true,
        details = null,
      } = entry || {};

      if (!actionType) {
        throw new Error('AuditLogRepository.insert: actionType is required');
      }

      let detailsJson = null;
      if (details !== null && details !== undefined) {
        try {
          detailsJson =
            typeof details === 'string' ? details : JSON.stringify(details);
        } catch {
          detailsJson = null;
        }
      }

      await conn.run(
        `
        INSERT INTO audit_log
          (action_type, target_type, target_id, actor_user_id, session_id, source, success, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `,
        [
          actionType,
          targetType,
          targetId != null ? String(targetId) : null,
          actorUserId,
          sessionId,
          source,
          success ? 1 : 0,
          detailsJson,
        ]
      );

      return { ...entry };
    } catch (err) {
      console.log(
        '[AuditLogRepo] insert error (soft-fail)',
        err && err.message ? err.message : err,
        entry
      );
      return { id: Date.now(), ...entry };
    }
  },

  /**
   * Lista wpisów audytowych z prostym filtrem/paginacją.
   * Gdy DB nie jest dostępna – zwraca pustą listę.
   */
  async list(filter = {}, pagination = {}) {
    try {
      const conn = getConnection();
      if (!conn || typeof conn.all !== 'function') {
        console.log('[AuditLogRepo] list (no-db stub)', { filter, pagination });
        return { items: [], total: 0 };
      }

      const {
        actorUserId,
        actionType,
        targetType,
        targetId,
        source,
        success,
        from,
        to,
      } = filter;

      const { limit = 50, offset = 0 } = pagination;

      const where = [];
      const params = [];

      if (actorUserId) {
        where.push('actor_user_id = ?');
        params.push(actorUserId);
      }
      if (actionType) {
        where.push('action_type = ?');
        params.push(actionType);
      }
      if (targetType) {
        where.push('target_type = ?');
        params.push(targetType);
      }
      if (targetId) {
        where.push('target_id = ?');
        params.push(String(targetId));
      }
      if (source) {
        where.push('source = ?');
        params.push(source);
      }
      if (typeof success === 'boolean') {
        where.push('success = ?');
        params.push(success ? 1 : 0);
      }
      if (from) {
        where.push('created_at >= ?');
        params.push(from);
      }
      if (to) {
        where.push('created_at <= ?');
        params.push(to);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const safeLimit = Math.max(
        1,
        Math.min(parseInt(limit, 10) || 50, 500)
      );
      const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

      const sql = `
        SELECT
          id,
          action_type as actionType,
          target_type as targetType,
          target_id as targetId,
          actor_user_id as actorUserId,
          session_id as sessionId,
          source,
          success,
          details,
          created_at as createdAt
        FROM audit_log
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ${safeLimit}
        OFFSET ${safeOffset}
      `;

      const items = await conn.all(sql, params);
      const totalRow = await conn.get(
        `
        SELECT COUNT(*) as cnt
        FROM audit_log
        ${whereSql}
      `,
        params
      );

      return {
        items: items || [],
        total: totalRow ? totalRow.cnt : 0,
      };
    } catch (err) {
      console.log(
        '[AuditLogRepo] list error (soft-fail)',
        err && err.message ? err.message : err,
        { filter, pagination }
      );
      return { items: [], total: 0 };
    }
  },

  /**
   * Pobiera pojedynczy wpis audytowy po ID.
   * W trybie stub lub przy błędzie – zwraca null.
   */
  async get(id) {
    try {
      const conn = getConnection();
      if (!conn || typeof conn.get !== 'function') {
        console.log('[AuditLogRepo] get (no-db stub)', { id });
        return null;
      }

      const row = await conn.get(
        `
        SELECT
          id,
          action_type as actionType,
          target_type as targetType,
          target_id as targetId,
          actor_user_id as actorUserId,
          session_id as sessionId,
          source,
          success,
          details,
          created_at as createdAt
        FROM audit_log
        WHERE id = ?
      `,
        [id]
      );

      return row || null;
    } catch (err) {
      console.log(
        '[AuditLogRepo] get error (soft-fail)',
        err && err.message ? err.message : err,
        { id }
      );
      return null;
    }
  },
};

module.exports = AuditLogRepository;