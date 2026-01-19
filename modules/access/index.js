/**
 * Warstwa dostępu / repozytoria oparte o SQLite.
 * Utrzymuje CommonJS oraz spójny punkt wejścia dla reszty aplikacji.
 */

const Logger = require('./logger');
const AccessManager = require('./access-manager');

const AppUserRepository = require('../auth/app-user-repo');
const SessionRepository = require('../session/session-repo');
const SettingsRepository = require('../settings/settings-repo');
const AuditLogRepository = require('../audit/audit-log-repo');
const LLMTaskRepository = require('../llm/llm-task-repo');
const CommandHistoryRepository = require('../history/command-history-repo');

module.exports = {
  Logger,
  AccessManager,
  repositories: {
    AppUserRepository,
    SessionRepository,
    SettingsRepository,
    AuditLogRepository,
    LLMTaskRepository,
    CommandHistoryRepository,
  },
};