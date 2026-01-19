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

const LLMClient = require('./llm-client'); // istniejący klient (może być stub)
const TaskGenerator = require('./task-generator');
const PromptProcessor = require('./prompt-processor');
const ServerManager = require('../management/server-manager');
const Logger = require('../access/logger');
const llmTaskRepo = require('./llm-task-repo');
const commandHistoryRepo = require('../history/command-history-repo');

class LLMManager {
 constructor(config = {}) {
   const { apiKey = null, logger = null, serverManager = null } = config;

   this.logger = logger || new Logger('llm-manager.log');
   this.apiKey = apiKey;
   this.llmClient = new LLMClient(apiKey, this.logger);
   this.taskGenerator = new TaskGenerator(this.llmClient, this.logger);
   this.promptProcessor = new PromptProcessor(this.taskGenerator, this.logger);
   this.serverManager = serverManager || new ServerManager(null, this.logger);

   // Repozytoria persistencji (singletons)
   this.llmTaskRepo = llmTaskRepo;
   this.commandHistoryRepo = commandHistoryRepo;

   // In-memory historia dalej utrzymywana jako cache, ale źródłem prawdy jest DB.
   // Map: serverId -> [{ id, prompt, plan, tasks, executionResults, status, createdAt }]
   this.taskHistory = new Map();
 }

 /**
  * Aktualizuje klucz API dla LLM. Używane gdy użytkownik zmienia klucz w ustawieniach.
  */
 setApiKey(newApiKey) {
   this.apiKey = newApiKey;
   this.llmClient = new LLMClient(newApiKey, this.logger);
   this.taskGenerator = new TaskGenerator(this.llmClient, this.logger);
   this.promptProcessor = new PromptProcessor(this.taskGenerator, this.logger);
   this.logger.info('API key updated in LLMManager');
 }

  // --- Public API ---

  /**
   * Główna metoda orchestration.
   * @param {string} prompt
   * @param {number|string} serverId
   * @param {Object} options
   *  - autoExecute?: boolean (default: true)
   *  - stopOnError?: boolean (default: true)
   * @returns {Promise<{plan: string, tasks: Array, executionResults: Array, status: string}>}
   */
  async processAndExecutePrompt(prompt, serverId, options = {}) {
    const { autoExecute = true, stopOnError = true } = options;

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

      let executionResults = [];
      let status = 'planned';

      // 3. Opcjonalne wykonanie planu
      if (autoExecute && tasks.length > 0) {
        executionResults = await this._executeTasksInternal(serverId, tasks, {
          stopOnError,
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
       executionResults,
       status,
       createdAt: llmTask.created_at || new Date().toISOString(),
     };

     this.addToTaskHistory(serverId, entry);

      this.logger.logAction('LLM_PROMPT_PROCESSED', {
        serverId,
        status,
        tasks: tasks.length,
      });

      return {
        plan,
        tasks,
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
    const { stopOnError = true } = options;
    const results = [];

    for (const task of tasks) {
      const taskId = task.id || generateId();
      try {
        const execResult = await this._executeSingleTask(serverId, task);
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
   */
  async _executeSingleTask(serverId, task) {
    const type = (task.type || '').toLowerCase();

    // Obsługa komend shell
    if (type === 'command' && task.command) {
      if (!this.serverManager.isServerConnected(serverId)) {
        await this.serverManager.connectToServer(serverId);
      }
      return this.serverManager.executeCommand(serverId, task.command);
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
      // Generuj komendę instalacji w zależności od OS
      const server = await this.serverManager.getServer(serverId);
      const os = (server?.os || 'linux').toLowerCase();
      let installCmd;
      if (os === 'windows') {
        installCmd = `choco install ${packageName} -y`;
      } else {
        // Linux - sprawdź dostępny menedżer pakietów
        installCmd = `if command -v apt-get &> /dev/null; then sudo apt-get install -y ${packageName}; elif command -v yum &> /dev/null; then sudo yum install -y ${packageName}; elif command -v dnf &> /dev/null; then sudo dnf install -y ${packageName}; else echo "Nieznany menedżer pakietów"; exit 1; fi`;
      }
      this.logger.info(`Wykonywanie komendy instalacji: ${installCmd}`);
      return this.serverManager.executeCommand(serverId, installCmd);
    }

    // Inne typy można rozbudować (user/share itp.)
    // TODO: mapowanie typów 'user', 'share' itd.

    // Jeśli jest konkretna komenda, wykonaj ją
    if (task.command) {
      if (!this.serverManager.isServerConnected(serverId)) {
        await this.serverManager.connectToServer(serverId);
      }
      this.logger.info(`Wykonywanie komendy: ${task.command}`);
      return this.serverManager.executeCommand(serverId, task.command);
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