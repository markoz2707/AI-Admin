// LLMManager - szkic orchestracji spójny z projektem i nową architekturą.
//
// Cele:
// - processAndExecutePrompt(prompt, serverId, options?)
//   - walidacja i wstępne przetworzenie promptu
//   - zbudowanie planu zadań (mock, bez realnego providera LLM)
//   - jeśli options.autoExecute === true, wykonanie zadań przez ServerManager/ServiceManager
//   - zwrot: { plan, tasks, executionResults, status }
// - getServerConfig(serverId)
// - getTaskHistory(serverId)
// - addToTaskHistory(serverId, entry)
// - generateReport(serverId)
//
// Punkty rozszerzeń:
// - prywatna metoda _callProvider(modelPrompt) do integracji z realnym LLM
// - możliwość zapisu historii do DB (LLMTask, LLMTaskResult, AuditLog) w przyszłości

const LLMRouter = require('./llm-router'); // router: wewnętrzny vs zewnętrzny LLM
const TaskGenerator = require('./task-generator');
const PromptProcessor = require('./prompt-processor');
const Orchestrator = require('./orchestrator');
const { evaluateCommand } = require('./command-guard');
const ServerManager = require('../management/server-manager');
const Logger = require('../access/logger');
const { shQuote, winCmdArg } = require('../access/shell-escape');
const llmTaskRepo = require('./llm-task-repo');
const commandHistoryRepo = require('../history/command-history-repo');

class LLMManager {
 constructor(config = {}) {
   const {
     apiKey = null,
     logger = null,
     serverManager = null,
     externalModel = undefined,
     policy = undefined,
     local = undefined,
     allowAnonymization = undefined,
   } = config;

   this.logger = logger || new Logger('llm-manager.log');

   // Konfiguracja routingu LLM (trzymana, by móc rebuildować pipeline).
   this._llmConfig = {
     apiKey,
     externalModel,
     policy,
     local,
     allowAnonymization,
   };

   this._buildPipeline();
   this.serverManager = serverManager || new ServerManager(null, this.logger);

   // Repozytoria persistencji (singletons)
   this.llmTaskRepo = llmTaskRepo;
   this.commandHistoryRepo = commandHistoryRepo;

   // Orchestrator: guardrail + dry-run + bramka zatwierdzania.
   this.orchestrator = new Orchestrator({ logger: this.logger });

   // In-memory historia dalej utrzymywana jako cache, ale źródłem prawdy jest DB.
   // Map: serverId -> [{ id, prompt, plan, tasks, executionResults, status, createdAt }]
   this.taskHistory = new Map();
 }

 /**
  * Jedyny punkt wykonywania poleceń przez LLM. Każde polecenie przechodzi przez
  * guardrail:
  *  - 'critical' -> blokada (GUARD_BLOCKED),
  *  - 'high'     -> wymaga approveHighRisk (NEEDS_APPROVAL),
  *  - dryRun     -> zwraca podgląd bez wykonania.
  * @param {number|string} serverId
  * @param {string} command
  * @param {Object} [opts] – { approveHighRisk, dryRun }
  */
 async _runGuardedCommand(serverId, command, opts = {}) {
   const guard = evaluateCommand(command);

   if (!guard.allowed) {
     const err = new Error(
       `Polecenie zablokowane przez guardrail: ${guard.violations.map((v) => v.reason).join(', ')}`
     );
     err.code = 'GUARD_BLOCKED';
     err.guard = guard;
     throw err;
   }
   if (guard.risk === 'high' && !opts.approveHighRisk) {
     const err = new Error(
       `Polecenie wysokiego ryzyka wymaga zatwierdzenia: ${guard.violations.map((v) => v.reason).join(', ')}`
     );
     err.code = 'NEEDS_APPROVAL';
     err.guard = guard;
     throw err;
   }

   if (opts.dryRun) {
     return { dryRun: true, command, guard, stdout: '', stderr: '', code: 0 };
   }

   if (!this.serverManager.isServerConnected(serverId)) {
     await this.serverManager.connectToServer(serverId);
   }
   return this.serverManager.executeCommand(serverId, command);
 }

 /** Buduje router LLM oraz zależne komponenty na podstawie this._llmConfig. */
 _buildPipeline() {
   const cfg = this._llmConfig;
   this.apiKey = cfg.apiKey;
   this.router = new LLMRouter({
     logger: this.logger,
     policy: cfg.policy,
     allowAnonymization: cfg.allowAnonymization,
     external: { apiKey: cfg.apiKey, model: cfg.externalModel },
     local: cfg.local || {},
   });
   // Alias zachowany dla kompatybilności z istniejącym kodem.
   this.llmClient = this.router;
   this.taskGenerator = new TaskGenerator(this.router, this.logger);
   this.promptProcessor = new PromptProcessor(this.taskGenerator, this.logger);
 }

 /**
  * Aktualizuje klucz API dla LLM. Używane gdy użytkownik zmienia klucz w ustawieniach.
  */
 setApiKey(newApiKey) {
   this._llmConfig.apiKey = newApiKey;
   this._buildPipeline();
   this.logger.info('API key updated in LLMManager');
 }

 /**
  * Aktualizuje konfigurację routingu LLM (polityka, lokalny provider, model itp.).
  * @param {Object} partial – pola: policy, externalModel, local, allowAnonymization
  */
 setLLMConfig(partial = {}) {
   this._llmConfig = { ...this._llmConfig, ...partial };
   this._buildPipeline();
   this.logger.info('LLM config updated in LLMManager', {
     policy: this._llmConfig.policy,
   });
 }

 /** Zwraca status routingu/providerów (do UI/diagnostyki). */
 getLLMStatus() {
   return this.router.getStatus();
 }

  // --- Public API ---

  /**
   * Główna metoda orchestration.
   *
   * Bezpieczeństwo: domyślnie NIE wykonuje (autoExecute=false) — zwraca plan
   * z oceną ryzyka (guardedPlan) do zatwierdzenia w UI. Wykonanie wymaga jawnego
   * autoExecute=true, a kroki wysokiego ryzyka dodatkowo approveHighRisk=true.
   * Polecenia 'critical' są zawsze blokowane przez guardrail.
   *
   * @param {string} prompt
   * @param {number|string} serverId
   * @param {Object} options
   *  - autoExecute?: boolean (default: false)
   *  - approveHighRisk?: boolean (default: false)
   *  - dryRun?: boolean (default: false)
   *  - stopOnError?: boolean (default: true)
   * @returns {Promise<{plan, tasks, guardedPlan, executionResults, status}>}
   */
  async processAndExecutePrompt(prompt, serverId, options = {}) {
    const {
      autoExecute = false,
      stopOnError = true,
      approveHighRisk = false,
      dryRun = false,
    } = options;

    if (!prompt || String(prompt).trim().length === 0) {
      throw new Error('Prompt nie może być pusty');
    }

    const serverConfig = await this.getServerConfig(serverId);
    if (!serverConfig) {
      throw new Error(`Serwer ${serverId} nie istnieje lub nie jest zarejestrowany`);
    }

    try {
      this.logger.logAction('LLM_PROMPT_RECEIVED', {
        serverId,
        snippet: prompt.slice(0, 200),
      });

      // 1. Walidacja / wstępne przetwarzanie
      const validation = this.promptProcessor.validatePrompt(prompt);
      if (!validation.isValid) {
        throw new Error(
          `Prompt nieprawidłowy: ${validation.issues.join(', ')}`
        );
      }

      // 2. Zbudowanie planu i listy zadań (mockowane lokalnie)
      const { plan, tasks } = await this._buildPlanAndTasks(
        prompt,
        serverConfig
      );

      // 2b. Podgląd planu z oceną ryzyka (guardrail) — zawsze dostępny.
      const { planFromTasks } = require('./plan-schema');
      const normalized = planFromTasks(tasks, plan);
      const guardedPlan = this.orchestrator.buildPlan(normalized);

      let executionResults = [];
      let status = 'planned';

      // 3. Opcjonalne wykonanie planu (domyślnie WYŁĄCZONE).
      if (autoExecute && tasks.length > 0) {
        executionResults = await this._executeTasksInternal(serverId, tasks, {
          stopOnError,
          approveHighRisk,
          dryRun,
        });
        status =
          executionResults.some((r) => r.status === 'error') && stopOnError
            ? 'partial_error'
            : 'executed';
      }

     // Persistencja zadania LLM
     const llmTask = await this.llmTaskRepo.insertTask({
       serverId,
       appUserId: options.appUserId || null,
       prompt,
       plan,
       status,
       autoExecute,
     });

     // Zapis wyników poszczególnych kroków
     let stepIndex = 0;
     for (const exec of executionResults) {
       await this.llmTaskRepo.insertResult({
         llmTaskId: llmTask.id,
         stepIndex: stepIndex++,
         taskType: exec.type || null,
         description: exec.description || null,
         command: exec.command || null,
         status: exec.status || 'success',
         result: exec.result ? JSON.stringify(exec.result) : null,
         errorMessage: exec.error || null,
       });

       // Równoległy CommandHistory dla komend
       if (exec.command) {
         await this.commandHistoryRepo.insert({
           serverId,
           appUserId: options.appUserId || null,
           source: 'llm',
           command: exec.command,
           result: exec.result ? JSON.stringify(exec.result) : null,
           exitCode:
             typeof exec.exitCode === 'number'
               ? exec.exitCode
               : exec.status === 'error'
               ? 1
               : 0,
         });
       }
     }

     const entry = {
       id: llmTask.id,
       serverId,
       prompt,
       plan,
       tasks,
       guardedPlan,
       executionResults,
       status,
       createdAt: llmTask.created_at || new Date().toISOString(),
     };

     this.addToTaskHistory(serverId, entry);

      this.logger.logAction('LLM_PROMPT_PROCESSED', {
        serverId,
        status,
        autoExecute,
        maxRisk: guardedPlan.maxRisk,
        tasks: tasks.length,
      });

      return {
        plan,
        tasks,
        guardedPlan,
        executionResults,
        status,
      };
    } catch (error) {
      this.logger.error('Błąd processAndExecutePrompt', error, { serverId });
      throw error;
    }
  }

  /**
   * Zwraca konfigurację serwera używaną przez LLM.
   * @param {number|string} serverId
   * @returns {Promise<Object|null>}
   */
  async getServerConfig(serverId) {
    try {
      const server = await this.serverManager.getServer(serverId);
      if (!server) return null;

      return {
        id: server.id,
        name: server.name,
        host: server.host,
        os: server.os,
        accessType: server.accessType,
        environment: server.environment,
        tags: server.tags,
        isEnabled: server.isEnabled,
        connected: this.serverManager.isServerConnected(server.id),
      };
    } catch (error) {
      this.logger.error('Błąd getServerConfig', error, { serverId });
      throw error;
    }
  }

  /**
   * Zwraca historię zadań dla serwera (z pamięci).
   * @param {number|string} serverId
   * @returns {Array}
   */
 async getTaskHistory(serverId) {
   // Pierwszeństwo ma baza (pełna historia), w pamięci trzymamy tylko cache ostatnich wpisów.
   try {
     const history = await this.llmTaskRepo.getHistoryByServer(serverId, 50);
     if (history && history.length) {
       return history.map((h) => ({
         id: h.task.id,
         serverId: h.task.server_id,
         prompt: h.task.prompt,
         plan: h.task.plan,
         status: h.task.status,
         createdAt: h.task.created_at,
         results: h.results,
       }));
     }
   } catch (error) {
     this.logger.error('Błąd getTaskHistory z DB, fallback do in-memory', error, {
       serverId,
     });
   }
   return this.taskHistory.get(String(serverId)) || [];
 }

  /**
   * Dodaje wpis do historii zadań.
   * @param {number|string} serverId
   * @param {Object} entry
   */
  addToTaskHistory(serverId, entry) {
    const key = String(serverId);
    if (!this.taskHistory.has(key)) {
      this.taskHistory.set(key, []);
    }

    const list = this.taskHistory.get(key);
    list.push({
      ...entry,
      createdAt: entry.createdAt || new Date().toISOString(),
    });

    // Ograniczenie do 200 wpisów na serwer (można dostroić).
    if (list.length > 200) {
      list.splice(0, list.length - 200);
    }
  }

  /**
   * Generuje prosty raport z historii zadań.
   * @param {number|string} serverId
   * @returns {{serverId, stats: {total, success, error}, tasks: Array}}
   */
  generateReport(serverId) {
    const history = this.getTaskHistory(serverId);
    const stats = {
      total: history.length,
      success: history.filter((h) =>
        (h.executionResults || []).every((r) => r.status === 'success')
      ).length,
      error: history.filter((h) =>
        (h.executionResults || []).some((r) => r.status === 'error')
      ).length,
    };

    return {
      serverId,
      stats,
      tasks: history.slice(-20),
    };
  }

  /**
   * Prosty health-check dostępności LLM/komponentów.
   * @returns {Promise<boolean>}
   */
  async checkAvailability() {
    try {
      const ok = await this.llmClient.checkAvailability();
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  // --- Wewnętrzne helpery orchestracji ---

  /**
   * Buduje plan i zadania na podstawie promptu i konfiguracji serwera.
   * W tej wersji wykorzystujemy istniejący PromptProcessor/TaskGenerator.
   * Jeśli nie są dostępne, fallback do prostego, lokalnego parsera.
   */
  async _buildPlanAndTasks(prompt, serverConfig) {
    this.logger.log(`Budowanie planu przez PromptProcessor dla promptu: "${truncate(prompt, 50)}..."`);
    
    // Delegacja do PromptProcessor, który jest teraz głównym źródłem planów.
    const processed = await this.promptProcessor.processPrompt(
      prompt,
      serverConfig
    );

    // Walidacja odpowiedzi z processora
    if (!processed || !Array.isArray(processed.tasks) || !processed.plan) {
      throw new Error('PromptProcessor zwrócił nieprawidłowy wynik - brak planu lub listy zadań.');
    }

    return {
      plan: processed.plan,
      tasks: processed.tasks,
    };
  }

  /**
   * Wykonuje listę zadań na serwerze z użyciem ServerManager/ServiceManager.
   * tasks: [{ id?, type, description, command?, serviceName?, action? }]
   */
  async _executeTasksInternal(serverId, tasks, options = {}) {
    const { stopOnError = true, approveHighRisk = false, dryRun = false } = options;
    const results = [];

    for (const task of tasks) {
      const taskId = task.id || generateId();
      try {
        const execResult = await this._executeSingleTask(serverId, task, {
          approveHighRisk,
          dryRun,
        });
        const entry = {
          taskId,
          type: task.type,
          description: task.description,
          status: 'success',
          result: execResult,
          timestamp: new Date().toISOString(),
        };
        results.push(entry);
        this.addToTaskHistory(serverId, {
          id: taskId,
          prompt: null,
          plan: null,
          tasks: [task],
          executionResults: [entry],
          status: 'executed',
        });
      } catch (error) {
        const entry = {
          taskId,
          type: task.type,
          description: task.description,
          status: 'error',
          error: error.message,
          timestamp: new Date().toISOString(),
        };
        results.push(entry);
        this.addToTaskHistory(serverId, {
          id: taskId,
          prompt: null,
          plan: null,
          tasks: [task],
          executionResults: [entry],
          status: 'error',
        });

        this.logger.error(
          `Błąd wykonania zadania LLMTask na serwerze ${serverId}`,
          error,
          { task }
        );

        if (stopOnError) {
          break;
        }
      }
    }

    return results;
  }

  /**
   * Mapuje pojedyncze zadanie na konkretne operacje managerów.
   * @param {number|string} serverId
   * @param {Object} task
   * @param {Object} [opts] – { approveHighRisk, dryRun }
   */
  async _executeSingleTask(serverId, task, opts = {}) {
    const type = (task.type || '').toLowerCase();

    // Obsługa komend shell — przez guardrail.
    if (type === 'command' && task.command) {
      return this._runGuardedCommand(serverId, task.command, opts);
    }

    // Obsługa usług
    if (type === 'service') {
      const action = (task.action || '').toLowerCase();
      const serviceName = task.serviceName || task.name;
      if (!serviceName) {
        throw new Error('Brak serviceName w zadaniu typu service');
      }
      if (!this.serverManager.isServerConnected(serverId)) {
        await this.serverManager.connectToServer(serverId);
      }

      switch (action) {
        case 'start':
          return this.serverManager.manageServices(serverId, 'start', {
            serviceName,
          });
        case 'stop':
          return this.serverManager.manageServices(serverId, 'stop', {
            serviceName,
          });
        case 'restart':
          return this.serverManager.manageServices(serverId, 'restart', {
            serviceName,
          });
        default:
          throw new Error(`Nieobsługwana akcja usługi: ${action}`);
      }
    }

    // Obsługa instalacji pakietów
    if (type === 'installation' || type === 'package') {
      const packageName = task.app || task.packageName || task.name;
      if (!packageName) {
        throw new Error('Brak nazwy pakietu w zadaniu typu installation');
      }
      if (!this.serverManager.isServerConnected(serverId)) {
        await this.serverManager.connectToServer(serverId);
      }
      // Generuj komendę instalacji w zależności od OS.
      // Nazwa pakietu jest escapowana (anty-injection), a całość przechodzi
      // przez guardrail w _runGuardedCommand.
      const server = await this.serverManager.getServer(serverId);
      const os = (server?.os || 'linux').toLowerCase();
      let installCmd;
      if (os === 'windows') {
        installCmd = `choco install ${winCmdArg(packageName)} -y`;
      } else {
        const pkg = shQuote(packageName);
        installCmd = `if command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y ${pkg}; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y ${pkg}; elif command -v yum >/dev/null 2>&1; then sudo yum install -y ${pkg}; else echo "Nieznany menedżer pakietów"; exit 1; fi`;
      }
      this.logger.info(`Komenda instalacji (przed guardrailem): ${installCmd}`);
      return this._runGuardedCommand(serverId, installCmd, opts);
    }

    // Inne typy można rozbudować (user/share itp.)
    // TODO: mapowanie typów 'user', 'share' itd.

    // Jeśli jest konkretna komenda, wykonaj ją — przez guardrail.
    if (task.command) {
      return this._runGuardedCommand(serverId, task.command, opts);
    }

    throw new Error(`Nieobsługiwany typ zadania: ${task.type}. Brak komendy do wykonania.`);
  }

  // --- Punkty rozszerzeń pod realnego providera LLM ---

  /**
   * Prywatny szkic wywołania providera LLM.
   * Nie jest używany w wersji mock, ale zostawiony jako stabilny kontrakt.
   */
  async _callProvider(modelPrompt, options = {}) {
    // TODO: Podłączyć konkretnego providera (OpenAI, Azure, itp.)
    // Interfejs: przyjmuje przygotowany modelPrompt oraz opcje,
    // zwraca tekst/strukturę gotową do dalszego parsowania.
    this.logger.debug('LLM _callProvider (mock)', { snippet: modelPrompt.slice(0, 120) });

    // Mock: delegacja do LLMClient jeśli ma prosty interfejs 'complete'.
    if (typeof this.llmClient.complete === 'function') {
      return this.llmClient.complete(modelPrompt, options);
    }

    // Minimalny fallback.
    return `PLAN:\n1) Zbadaj stan serwera.\n2) Wykonaj: ${truncate(
      modelPrompt,
      80
    )}`;
  }
}

// --- Helpers ---

function generateId() {
  return 'task_' + Math.random().toString(36).substring(2, 10);
}

function truncate(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

module.exports = LLMManager;