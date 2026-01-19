const Logger = require('../access/logger');
const ServerManager = require('./server-manager');

/**
 * LogsManager
 * Bezpieczny i ujednolicony dostęp do logów systemowych z serwerów zarządzanych przez AI-Admin.
 *
 * Założenia:
 * - Korzysta z istniejącego ServerManager (w tym z AccessManager.executeCommand na aktywnym połączeniu).
 * - Dostarcza dwa główne entrypointy:
 *   - tailSystemLogs(serverId, options)
 *   - fetchLogs(serverId, options)
 * - Zwraca lightweight strukturę:
 *   {
 *     entries: [{ timestamp, level, source, message }],
 *     truncated: boolean
 *   }
 * - Nie modyfikuje logów po stronie serwera, tylko je odczytuje.
 * - W przyszłości integruje się z AuditLogRepository (LOGS_VIEW) na wyższej warstwie (ipcMain).
 */

class LogsManager {
  /**
   * @param {ServerManager} serverManager
   * @param {Logger} logger
   */
  constructor(serverManager = null, logger = null) {
    this.serverManager = serverManager || new ServerManager();
    this.logger = logger || new Logger('logs-manager.log');
  }

  async _getServer(serverId) {
    const server = await this.serverManager.getServer(serverId);
    if (!server) {
      throw new Error(`Serwer ${serverId} nie istnieje`);
    }
    if (!server.os) {
      throw new Error(
        `Serwer ${serverId} nie ma zdefiniowanego pola OS (wymagane do logów systemowych)`
      );
    }
    if (!this.serverManager.isServerConnected(serverId)) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }
    return server;
  }

  _normalizeLevel(levelRaw) {
    if (!levelRaw) return 'INFO';
    const lvl = String(levelRaw).toLowerCase();
    if (lvl.includes('err') || lvl.includes('crit') || lvl.includes('alert') || lvl.includes('emerg')) {
      return 'ERROR';
    }
    if (lvl.includes('warn')) return 'WARN';
    if (lvl.includes('info')) return 'INFO';
    if (lvl.includes('debug')) return 'DEBUG';
    return 'INFO';
  }

  _parseLinuxJournalctl(stdout) {
    const entries = [];
    const lines = (stdout || '').split('\n');
    // Zakładamy format journalctl --output=short:
    // "YYYY-MM-DD HH:MM:SS HOST UNIT[PID]: message"
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Prosty parser: timestamp do pierwszej spacji + reszta jako message.
      const m = trimmed.match(
        /^(\d{4}-\d{2}-\d{2}|\w{3}\s+\d{1,2})\s+([\d:]+)\s+([^ ]+)\s+(.*)$/
      );
      if (!m) {
        entries.push({
          timestamp: null,
          level: 'INFO',
          source: null,
          message: trimmed,
        });
        continue;
      }

      const [, datePart, timePart, hostOrSource, rest] = m;
      entries.push({
        timestamp: `${datePart} ${timePart}`,
        level: 'INFO',
        source: hostOrSource,
        message: rest,
      });
    }
    return entries;
  }

  _parseLinuxTail(stdout, fileHint) {
    const entries = [];
    const lines = (stdout || '').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      entries.push({
        timestamp: null,
        level: 'INFO',
        source: fileHint || null,
        message: trimmed,
      });
    }
    return entries;
  }

  _parseWindowsWevtutil(stdout) {
    const entries = [];
    const lines = (stdout || '').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Minimalny parser: traktuj każdą linię jako wiadomość
      entries.push({
        timestamp: null,
        level: 'INFO',
        source: 'EventLog',
        message: trimmed,
      });
    }
    return entries;
  }

  _limitEntries(entries, limit) {
    if (!Array.isArray(entries)) return { entries: [], truncated: false };
    if (!limit || entries.length <= limit) {
      return { entries, truncated: false };
    }
    return {
      entries: entries.slice(entries.length - limit),
      truncated: true,
    };
  }

  /**
   * Zwraca końcówkę logów systemowych (tail).
   * options:
   *  - lines?: number (domyślnie 200, max 1000)
   *  - level?: 'INFO'|'WARN'|'ERROR'
   *  - service?: string (dla journalctl --unit)
   */
  async tailSystemLogs(serverId, options = {}) {
    const { lines = 200, level, service } = options;
    const safeLines = Math.max(1, Math.min(lines, 1000));
    const server = await this._getServer(serverId);
    const os = String(server.os || '').toLowerCase();

    let cmd;
    if (os.includes('win')) {
      // Prosty podgląd logów systemowych na Windows
      cmd = `wevtutil qe System /c:${safeLines} /rd:true /f:text`;
    } else {
      // Preferuj journalctl, fallback na syslog/messages
      const levelArg = level
        ? `--priority=${level === 'ERROR' ? 'err' : level === 'WARN' ? 'warning' : 'info'}`
        : '';
      const unitArg = service ? `--unit=${service}` : '';
      cmd = `if command -v journalctl >/dev/null 2>&1; then journalctl -n ${safeLines} --no-pager ${unitArg} ${levelArg}; ` +
        `elif [ -f /var/log/syslog ]; then tail -n ${safeLines} /var/log/syslog; ` +
        `elif [ -f /var/log/messages ]; then tail -n ${safeLines} /var/log/messages; ` +
        `else echo "Brak standardowych logów systemowych"; fi`;
    }

    const res = await this.serverManager.accessManager.executeCommand(serverId, cmd);
    const stdout = res.stdout || '';

    let entries;
    if (os.includes('win')) {
      entries = this._parseWindowsWevtutil(stdout);
    } else if (stdout.includes('journalctl')) {
      // heurystycznie: jeśli zawiera "journalctl", to użyto pierwszej gałęzi; ale to może być mylące
      entries = this._parseLinuxJournalctl(stdout);
    } else if (stdout) {
      // tail syslog/messages
      entries = this._parseLinuxTail(stdout, '/var/log');
    } else {
      entries = [];
    }

    const limited = this._limitEntries(entries, safeLines);
    return limited;
  }

  /**
   * Pobiera wycinek logów według filtrów.
   * options:
   *  - timeframe?: { from?: string, to?: string } lub preset: '15m'|'1h'|'24h'
   *  - service?: string
   *  - level?: string
   *  - pattern?: string
   *  - limit?: number (max 1000)
   */
  async fetchLogs(serverId, options = {}) {
    const { timeframe, service, level, pattern, limit = 500 } = options;
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const server = await this._getServer(serverId);
    const os = String(server.os || '').toLowerCase();

    let from = null;
    let to = null;

    if (typeof timeframe === 'string') {
      const now = new Date();
      if (timeframe === '15m') {
        from = new Date(now.getTime() - 15 * 60 * 1000);
      } else if (timeframe === '1h') {
        from = new Date(now.getTime() - 60 * 60 * 1000);
      } else if (timeframe === '24h') {
        from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      }
    } else if (timeframe && timeframe.from) {
      from = new Date(timeframe.from);
      if (timeframe.to) {
        to = new Date(timeframe.to);
      }
    }

    const fmt = (d) =>
      d && !isNaN(d.getTime())
        ? d.toISOString().replace('T', ' ').split('.')[0]
        : null;

    let cmd;
    if (os.includes('win')) {
      // Uproszczony fetch logów Windows (wevtutil)
      // Można rozszerzyć o pattern/timeframe; tu minimalnie:
      cmd = `wevtutil qe System /c:${safeLimit} /rd:true /f:text`;
    } else {
      // Linux + journalctl
      const parts = ['journalctl', '--no-pager', `-n ${safeLimit}`];
      if (service) parts.push(`--unit=${service}`);
      if (level) {
        const lvl = String(level).toLowerCase();
        if (lvl === 'error') parts.push('--priority=err');
        else if (lvl === 'warn' || lvl === 'warning') parts.push('--priority=warning');
        else parts.push('--priority=info');
      }
      if (from) parts.push(`--since="${fmt(from)}"`);
      if (to) parts.push(`--until="${fmt(to)}"`);
      cmd = parts.join(' ');
      if (pattern) {
        // Ostrożnie, grep tylko jako filtr lokalny, bez -r i bez zapisywania pattern do logów
        cmd += ` | grep -i "${pattern.replace(/"/g, '')}" || true`;
      }
    }

    const res = await this.serverManager.accessManager.executeCommand(serverId, cmd);
    const stdout = res.stdout || '';

    let entries;
    if (os.includes('win')) {
      entries = this._parseWindowsWevtutil(stdout);
    } else {
      entries = this._parseLinuxJournalctl(stdout);
      if (!entries.length) {
        entries = this._parseLinuxTail(stdout, 'journalctl');
      }
    }

    const limited = this._limitEntries(entries, safeLimit);
    return limited;
  }
}

module.exports = LogsManager;