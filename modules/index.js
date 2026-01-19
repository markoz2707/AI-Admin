/**
 * Centralny eksport repozytoriów i komponentów backendowych.
 * Ułatwia spójne użycie w ui/electron-main.js i innych miejscach.
 * CommonJS only.
 */

const AppUserRepository = require('./auth/app-user-repo');
const SessionRepository = require('./session/session-repo');
const SettingsRepository = require('./settings/settings-repo');
const AuditLogRepository = require('./audit/audit-log-repo');
const LLMTaskRepository = require('./llm/llm-task-repo');
const CommandHistoryRepository = require('./history/command-history-repo');

const serverManager = require('./management/server-manager');
const serviceManager = require('./management/service-manager');
const userManager = require('./management/user-manager');
const shareManager = require('./management/share-manager');
const passwordManager = require('./password-manager/password-manager');
const LLMManager = require('./llm/llm-manager');
const Logger = require('./access/logger');

module.exports = {
  repositories: {
    AppUserRepository,
    SessionRepository,
    SettingsRepository,
    AuditLogRepository,
    LLMTaskRepository,
    CommandHistoryRepository,
  },
  managers: {
    serverManager,
    serviceManager,
    userManager,
    shareManager,
    passwordManager,
    llmManager: new LLMManager(),
  },
  Logger,
};