/**
 * AppService — rdzeń control-plane niezależny od Electrona.
 *
 * Skupia konstrukcję managerów/repozytoriów/LLM oraz cykl życia (start/stop),
 * dzięki czemu ten sam backend można uruchomić:
 *  - w procesie głównym Electrona (UI jako klient), albo
 *  - jako zawsze-włączoną usługę headless (service/headless.js).
 *
 * Zasada (zgodna z recenzją): Electron to UI, control plane to usługa.
 * start() jest idempotentne i wykonuje migracje, przygotowuje journal
 * wykonania, odzyskuje przerwane plany i inicjalizuje LLMManager.
 */

const {
  ServerManager,
  ServiceManager,
  UserManager,
  ShareManager,
  PackageManager,
  LogsManager,
} = require('../management');
const passwordManager = require('../password-manager/password-manager');
const LLMManager = require('../llm/llm-manager');
const migrationManager = require('../database/migration-manager');
const { decrypt } = require('../database/encryption-manager');
const Logger = require('../access/logger');
const AppUserRepository = require('../auth/app-user-repo');
const SessionRepository = require('../session/session-repo');
const SettingsRepository = require('../settings/settings-repo');
const AuditLogRepository = require('../audit/audit-log-repo');
const CommandHistoryRepository = require('../history/command-history-repo');
const { ExecutionJournal } = require('../journal/execution-journal');

class AppService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('app-service.log');

    // Managery (pojedyncze instancje współdzielące AccessManager).
    this.serverManager = new ServerManager();
    this.serviceManager = new ServiceManager(this.serverManager.accessManager, this.logger);
    this.userManager = new UserManager(this.serverManager.accessManager, this.logger);
    this.shareManager = new ShareManager(this.serverManager.accessManager, this.logger);
    this.packageManager = PackageManager
      ? new PackageManager(this.serverManager, this.logger)
      : null;
    this.logsManager = LogsManager
      ? new LogsManager(this.serverManager, this.logger)
      : null;
    this.passwordManager = passwordManager;

    // Repozytoria (singletony).
    this.appUserRepo = AppUserRepository;
    this.sessionRepo = SessionRepository;
    this.settingsRepo = SettingsRepository;
    this.auditLogRepo = AuditLogRepository;
    this.commandHistoryRepo = CommandHistoryRepository;

    this.journal = null;
    this.llmManager = null;
    this._started = false;
  }

  /**
   * Inicjalizuje backend: migracje, journal, odzyskiwanie, LLMManager.
   * Idempotentne.
   */
  async start() {
    if (this._started) return this;

    await migrationManager.runMigrations();
    this.logger.info('Migracje wykonane');

    // Journal wykonania + przygotowanie schematu (CREATE TABLE IF NOT EXISTS).
    this.journal = ExecutionJournal.createDefault();
    try {
      await this.journal.ensureReady();
    } catch (e) {
      this.logger.error('Nie udało się przygotować journala wykonania', e);
    }

    const apiKey = await this._loadApiKey();
    if (!apiKey) {
      this.logger.warn('Klucz API LLM (llm.apiKey) nie jest ustawiony.');
    }
    const routing = await this.loadLLMRoutingConfig();

    this.llmManager = new LLMManager({
      logger: this.logger,
      serverManager: this.serverManager,
      apiKey,
      journal: this.journal,
      ...routing,
    });

    // Odzyskiwanie po awarii: przerwane kroki -> needs_verification.
    try {
      const recovered = await this.llmManager.recoverInterruptedPlans();
      if (recovered.length) {
        this.logger.warn(
          `Odzyskano ${recovered.length} przerwanych kroków wykonania (wymagają weryfikacji).`
        );
      }
    } catch (e) {
      this.logger.error('Błąd odzyskiwania przerwanych planów', e);
    }

    this._started = true;
    this.logger.info('AppService uruchomiony');
    return this;
  }

  /** Czyste zamknięcie — rozłącza wszystkie połączenia do serwerów. */
  async stop() {
    try {
      await this.serverManager.disconnectAll();
    } catch (e) {
      this.logger.error('Błąd podczas zamykania połączeń', e);
    }
    this._started = false;
    this.logger.info('AppService zatrzymany');
  }

  /** Wczytuje i deszyfruje klucz API LLM z ustawień. */
  async _loadApiKey() {
    try {
      const stored = await this.settingsRepo.get('global', 'llm.apiKey');
      return stored ? decrypt(stored) : null;
    } catch (e) {
      this.logger.error('Błąd wczytywania klucza API LLM', e);
      return null;
    }
  }

  /**
   * Czyta konfigurację routingu LLM (wewnętrzny vs zewnętrzny) z ustawień.
   * Klucze (scope 'global'): llm.provider, llm.model, llm.allowAnonymization,
   * llm.local.enabled, llm.local.baseUrl, llm.local.model.
   */
  async loadLLMRoutingConfig() {
    const get = async (key, dflt) => {
      try {
        const v = await this.settingsRepo.get('global', key);
        return v === null || v === undefined ? dflt : v;
      } catch {
        return dflt;
      }
    };

    const provider = await get('llm.provider', 'auto');
    const policy =
      provider === 'local' || provider === 'anonymize' || provider === 'openai'
        ? provider
        : 'auto';

    return {
      policy,
      externalModel: (await get('llm.model', '')) || undefined,
      allowAnonymization: (await get('llm.allowAnonymization', true)) !== false,
      local: {
        enabled: (await get('llm.local.enabled', false)) === true,
        baseUrl: (await get('llm.local.baseUrl', '')) || undefined,
        model: (await get('llm.local.model', '')) || undefined,
      },
    };
  }

  /** Przeładowuje konfigurację routingu LLM na żywo (po zmianie ustawień). */
  async reloadLLMConfig() {
    if (!this.llmManager) return;
    this.llmManager.setLLMConfig(await this.loadLLMRoutingConfig());
  }
}

module.exports = AppService;
