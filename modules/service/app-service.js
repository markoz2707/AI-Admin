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
const { ROLES, PERMISSIONS, checkPermission } = require('../access/rbac');
const osDetector = require('../management/os-detector');
const environmentCollector = require('../management/environment-collector');

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

    // Bootstrap: utwórz początkowego admina, jeśli baza kont jest pusta
    // (repo loguje wygenerowane hasło z ostrzeżeniem o zmianie).
    try {
      const initial = await this.appUserRepo.createInitialAdminIfEmpty();
      if (initial) {
        this.logger.warn('Utworzono początkowego administratora — zmień hasło po pierwszym logowaniu.', {
          username: initial.username,
        });
      }
    } catch (e) {
      this.logger.error('Bootstrap administratora nieudany', e);
    }

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

    // Odzyskiwanie po awarii: przerwane kroki -> needs_verification, następnie
    // read-back (uruchom `verify`, nie powtarzaj operacji).
    try {
      const recovered = await this.llmManager.recoverInterruptedPlans();
      if (recovered.length) {
        this.logger.warn(
          `Odzyskano ${recovered.length} przerwanych kroków wykonania — próbuję read-back.`
        );
        const rb = await this.llmManager.verifyInterruptedSteps();
        this.logger.warn(
          `Read-back: sprawdzono ${rb.checked}, potwierdzono ${rb.confirmedDone}, nierozstrzygnięte ${rb.unresolved}.`
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

  // ---------------------------------------------------------------------------
  // Uwierzytelnianie + dyspozytor poleceń (wspólny dla UI i transportu headless)
  // ---------------------------------------------------------------------------

  /**
   * Rozwiązuje kontekst sesji na podstawie tokenu (identycznie jak warstwa UI):
   * sprawdza ważność, wygaśnięcie i aktywność użytkownika.
   * @returns {Promise<{session, user:{id,username,role}}>}
   */
  async resolveContext(sessionToken) {
    if (!sessionToken) {
      const err = new Error('Brak tokenu sesji'); err.code = 'UNAUTHORIZED'; throw err;
    }
    const session = await this.sessionRepo.getSessionByToken(sessionToken);
    if (!session || !session.is_valid) {
      const err = new Error('Sesja nieważna lub nie istnieje'); err.code = 'UNAUTHORIZED'; throw err;
    }
    if (session.expires_at) {
      const exp = new Date(session.expires_at);
      if (isFinite(exp.getTime()) && exp < new Date()) {
        await this.sessionRepo.invalidateSession(session.id);
        const err = new Error('Sesja wygasła'); err.code = 'UNAUTHORIZED'; throw err;
      }
    }
    const user = await this.appUserRepo.getById(session.app_user_id);
    if (!user || !user.is_active) {
      const err = new Error('Użytkownik sesji nieaktywny'); err.code = 'UNAUTHORIZED'; throw err;
    }
    await this.sessionRepo.touchSession(session.id);
    return { session, user: { id: user.id, username: user.username, role: user.role } };
  }

  /** Buduje executor związany z serwerem (z gwarancją połączenia). */
  _makeServerExecutor(serverId, context) {
    return async (command) => {
      if (!this.serverManager.isServerConnected(serverId)) {
        await this.serverManager.connectToServer(serverId);
      }
      return this.serverManager.executeCommand(serverId, command, {
        actorUserId: context && context.user ? context.user.id : null,
        source: 'system',
      });
    };
  }

  /** Rejestr handlerów rdzeniowych (auth + autonomia + percepcja). */
  _handlers() {
    return {
      'auth:login': async ({ username, password }) => {
        const user = await this.appUserRepo.verifyPassword(username, password);
        if (!user) {
          const err = new Error('Nieprawidłowe dane logowania'); err.code = 'UNAUTHORIZED'; throw err;
        }
        const session = await this.sessionRepo.createSession(user.id);
        return {
          user: { id: user.id, username: user.username, role: user.role },
          sessionToken: session.token,
        };
      },
      'auth:logout': async ({ sessionToken }, context) => {
        if (sessionToken) await this.sessionRepo.invalidateByToken(sessionToken);
        else if (context && context.session) await this.sessionRepo.invalidateSession(context.session.id);
        return { success: true };
      },
      'auth:getCurrentUser': async (_payload, context) => ({ user: context.user }),

      'servers:list': async (payload) => {
        const servers = await this.serverManager.listServers(payload.filter || {});
        return servers.map((s) => ({
          ...s,
          isConnected: this.serverManager.isServerConnected(s.id),
        }));
      },
      'servers:get': async ({ id }) => this.serverManager.getServer(id),

      'llm:ask': async ({ prompt, serverId, autoExecute, dryRun }, context) =>
        this.llmManager.processAndExecutePrompt(prompt, serverId, {
          autoExecute: !!autoExecute,
          dryRun: !!dryRun,
          appUserId: context.user ? context.user.id : null,
        }),

      'llm:executePlan': async ({ serverId, planId, planHash, approvals, dryRun }, context) => {
        const isAdmin = context.user && context.user.role === ROLES.ADMIN;
        return this.llmManager.executePlan(serverId, planId, {
          planHash,
          approvals: isAdmin ? approvals || [] : [], // zatwierdzać 'high' może tylko admin
          dryRun: !!dryRun,
          appUserId: context.user ? context.user.id : null,
        });
      },

      'env:detectOS': async ({ serverId }, context) => {
        const server = await this.serverManager.getServer(serverId);
        const execute = this._makeServerExecutor(serverId, context);
        return osDetector.detectAndVerify(execute, server ? server.os : null);
      },
      'env:collect': async ({ serverId, anonymize }, context) => {
        const server = await this.serverManager.getServer(serverId);
        const execute = this._makeServerExecutor(serverId, context);
        const snapshot = await environmentCollector.collect({
          execute,
          server: server || { id: serverId },
          os: server ? server.os : undefined,
          serverId,
          serviceManager: this.serviceManager,
          userManager: this.userManager,
          packageManager: this.packageManager,
        });
        return anonymize
          ? environmentCollector.anonymizeSnapshot(snapshot).anonymized
          : snapshot;
      },
    };
  }

  /**
   * Dyspozytor poleceń: wspólna ścieżka dla transportu headless (i docelowo UI).
   * Rozwiązuje sesję, egzekwuje RBAC, woła handler, zwraca {ok, data|error}.
   * @param {string} channel
   * @param {Object} payload  (zawiera sessionToken)
   */
  async dispatch(channel, payload = {}) {
    try {
      const perms = PERMISSIONS[channel];
      const isPublic = Array.isArray(perms) && perms.length === 0;

      let context = null;
      if (!isPublic) {
        context = await this.resolveContext(payload.sessionToken);
        checkPermission(context, channel);
      }

      const handler = this._handlers()[channel];
      if (!handler) {
        const err = new Error(`Nieobsługiwany kanał: ${channel}`); err.code = 'UNKNOWN_CHANNEL'; throw err;
      }

      const data = await handler(payload, context);

      await this.logger.logAuditLike({
        actionType: 'DISPATCH',
        targetType: 'channel',
        targetId: channel,
        actorUserId: context && context.user ? context.user.id : null,
        source: 'service',
        success: true,
      });
      return { ok: true, data };
    } catch (error) {
      this.logger.error(`dispatch failed: ${channel}`, error);
      return { ok: false, error: { code: error.code || 'DISPATCH_ERROR', message: error.message } };
    }
  }
}

module.exports = AppService;
