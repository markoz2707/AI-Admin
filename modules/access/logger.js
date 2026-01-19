const fs = require('fs');
const path = require('path');
const AuditLogRepository = require('../audit/audit-log-repo');

class Logger {
  constructor(logFile = 'access.log') {
    this.logFile = path.join(__dirname, logFile);
    this.levels = {
      ERROR: 0,
      WARN: 1,
      INFO: 2,
      DEBUG: 3,
    };
    this.currentLevel = this.levels.INFO; // Domyślny poziom logowania
    this.auditRepo = AuditLogRepository || null;
  }

  /**
   * Ustawia poziom logowania
   * @param {string} level - Poziom logowania: ERROR, WARN, INFO, DEBUG
   */
  setLevel(level) {
    if (this.levels[level] !== undefined) {
      this.currentLevel = this.levels[level];
    }
  }

  /**
   * Zapisuje wiadomość do pliku logu
   * @param {string} level - Poziom logowania
   * @param {string} message - Wiadomość do zalogowania
   * @param {Error} error - Obiekt błędu (opcjonalny)
   * @param {Object} context - Dodatkowy kontekst (opcjonalny)
   */
  _writeLog(level, message, error = null, context = null) {
    if (this.levels[level] > this.currentLevel) {
      return; // Pomijaj wiadomości poniżej aktualnego poziomu
    }

    const timestamp = new Date().toISOString();
    let logEntry = `[${timestamp}] ${level}: ${message}`;

    if (context && Object.keys(context).length > 0) {
      try {
        logEntry += ` | ctx=${JSON.stringify(context)}`;
      } catch {
        // pomiń, jeśli nie da się zserializować
      }
    }

    if (error) {
      logEntry += `\n  Error: ${error.message}`;
      if (error.stack) {
        logEntry += `\n  Stack: ${error.stack}`;
      }
    }

    logEntry += '\n';

    try {
      fs.appendFileSync(this.logFile, logEntry);
    } catch (err) {
      // Ostateczny fallback – nie przerywamy wykonania logiem.
      console.error('Błąd zapisu do pliku logu:', err.message);
    }
  }

  // Podstawowe poziomy

  error(message, error = null, context = null) {
    this._writeLog('ERROR', message, error, context);
    console.error(`[ERROR] ${message}`, error ? error.message : '', context || '');
  }

  warn(message, context = null) {
    this._writeLog('WARN', message, null, context);
    console.warn(`[WARN] ${message}`, context || '');
  }

  info(message, context = null) {
    this._writeLog('INFO', message, null, context);
    console.log(`[INFO] ${message}`, context || '');
  }

  debug(message, context = null) {
    this._writeLog('DEBUG', message, null, context);
    console.debug(`[DEBUG] ${message}`, context || '');
  }

  // Alias for info - for compatibility
  log(message, context = null) {
    this.info(message, context);
  }

  // Akcje domenowe

  /**
   * Loguje akcję użytkownika / systemu (lekki wrapper).
   * Używane głównie dla telemetrycznych wpisów, nie zawsze audyt krytyczny.
   * @param {string} actionType - Typ akcji (np. 'SERVER_CREATE', 'SERVICE_START')
   * @param {Object} details - Szczegóły akcji (plain object)
   */
  logAction(actionType, details = {}) {
    const msg = `Action: ${actionType}`;
    this.info(msg, details);
  }

  /**
   * Loguje błąd połączenia
   * @param {string|number} serverId - ID serwera
   * @param {string} type - Typ połączenia (SSH/RDP)
   * @param {Error} error - Obiekt błędu
   */
  logConnectionError(serverId, type, error) {
    this.error(`Connection error for server ${serverId} (${type})`, error);
  }

  /**
   * Loguje pomyślne połączenie
   * @param {string|number} serverId - ID serwera
   * @param {string} type - Typ połączenia (SSH/RDP)
   */
  logConnectionSuccess(serverId, type) {
    this.info(`Successfully connected to server ${serverId} (${type})`);
  }

  /**
   * Loguje rozłączenie
   * @param {string|number} serverId
   * @param {string} type
   */
  logDisconnection(serverId, type) {
    this.info(`Disconnected from server ${serverId} (${type})`);
  }

  /**
   * Loguje operację na zasobie (pod audyt) oraz zapisuje do tabeli audit_log.
   *
   * payload:
   *  - actionType (string, wymagane)
   *  - targetType (string)
   *  - targetId (string|number)
   *  - actorUserId (number)
   *  - sessionId (number)
   *  - success (bool, default: true)
   *  - source (string, np. 'ui' | 'llm' | 'system')
   *  - details (object|string) - BEZ wrażliwych danych
   */
  async logAuditLike(payload) {
    const {
      actionType,
      targetType,
      targetId,
      actorUserId,
      sessionId,
      success = true,
      source = 'system',
      details,
    } = payload || {};

    if (!actionType) {
      this.warn('logAuditLike called without actionType', { payload });
      return;
    }

    const safeDetails =
      details && typeof details === 'object'
        ? this._sanitizeDetails(details)
        : details;

    const base = `Audit: ${actionType} on ${targetType || 'N/A'}${
      targetId ? `#${targetId}` : ''
    }`;
    const ctx = {
      actorUserId: actorUserId || null,
      sessionId: sessionId || null,
      targetType: targetType || null,
      targetId: targetId || null,
      source,
      success: !!success,
      details: safeDetails || {},
    };

    // Log do pliku/konsoli
    this.info(base, ctx);

    // Zapis do DB (audit_log)
    if (this.auditRepo && typeof this.auditRepo.insert === 'function') {
      try {
        await this.auditRepo.insert({
          actionType,
          targetType,
          targetId,
          actorUserId,
          sessionId,
          success,
          source,
          details: safeDetails,
        });
      } catch (err) {
        // Nie blokujemy ścieżki krytycznej jeśli audyt nie działa;
        // tylko logujemy błąd lokalnie.
        this.error('Nie udało się zapisać wpisu audit_log', err, {
          actionType,
          targetType,
          targetId,
        });
      }
    }
  }

  /**
   * Prosty sanitizator szczegółów audytu – usuwa oczywiste wrażliwe pola.
   */
  _sanitizeDetails(obj) {
    const forbiddenKeys = [
      'password',
      'passwordHash',
      'secret',
      'token',
      'accessToken',
      'refreshToken',
      'apikey',
      'apiKey',
      'privateKey',
    ];

    const clone = {};
    for (const [key, value] of Object.entries(obj)) {
      if (forbiddenKeys.includes(key)) {
        clone[key] = '[REDACTED]';
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        clone[key] = this._sanitizeDetails(value);
      } else {
        clone[key] = value;
      }
    }
    return clone;
  }
}

module.exports = Logger;