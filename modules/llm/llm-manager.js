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
const crypto = require('crypto');
const Orchestrator = require('./orchestrator');
const { evaluateCommand } = require('./command-guard');
const { planFromTasks, computePlanHash } = require('./plan-schema');
const actionRegistry = require('../actions/action-registry');
const DeferredScheduler = require('../agent/deferred-scheduler');
const { ExecutionJournal } = require('../journal/execution-journal');
const ServerManager = require('../management/server-manager');
const Logger = require('../access/logger');
const { shQuote, winCmdArg, assertIdentifier } = require('../access/shell-escape');
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
     journal = null,
   } = config;

   this.logger = logger || new Logger('llm-manager.log');

   // Trwały journal wykonania (idempotencja + odzyskiwanie po awarii).
   this._journal = journal;

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

   // Magazyn zbudowanych planów (pin pod zatwierdzanie / ochrona TOCTOU).
   // planId -> { serverId, os, steps, planHash, summary, prompt, createdAt }
   this._planStore = new Map();

   // Scheduler odroczonego wykonania z prawem weta.
   this._deferred = new DeferredScheduler({
     logger: this.logger,
     execute: (item) => this.executePlan(item.serverId, item.planId, item.options || {}),
   });

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

 /** Leniwie tworzy journal wykonania (SQLite lub in-memory fallback). */
 _getJournal() {
   if (!this._journal) {
     this._journal = ExecutionJournal.createDefault();
   }
   return this._journal;
 }

 /** Wywołuje operację journala best-effort — awaria journala nie blokuje wykonania. */
 async _journalSafe(fn) {
   try {
     return await fn();
   } catch (err) {
     this.logger.error('Błąd journala wykonania (kontynuuję)', err);
     return null;
   }
 }

 /**
  * Uruchamia pomocnicze polecenie (weryfikacja/kompensacja) z guardrailem.
  * Blokuje krytyczne; nie żurnaluje (to nie jest krok planu).
  */
 async _execGuardedRaw(serverId, command, os, appUserId) {
   const g = evaluateCommand(command, { os });
   if (!g.allowed) {
     const e = new Error('Polecenie zablokowane przez guardrail'); e.code = 'GUARD_BLOCKED'; throw e;
   }
   if (!this.serverManager.isServerConnected(serverId)) {
     await this.serverManager.connectToServer(serverId);
   }
   return this.serverManager.executeCommand(serverId, command, {
     actorUserId: appUserId || null, source: 'llm',
   });
 }

 /**
  * Odzyskiwanie po awarii: kroki przerwane (status 'executing') trafiają do
  * 'needs_verification' zamiast ślepego ponowienia. Zwraca listę takich kroków.
  */
 async recoverInterruptedPlans() {
   try {
     return await this._getJournal().recover();
   } catch (err) {
     this.logger.error('Błąd odzyskiwania journala wykonania', err);
     return [];
   }
 }

 /**
  * Read-back: dla kroków 'needs_verification' (przerwanych awarią) uruchamia ich
  * postcondition `verify`, by ustalić, czy faktycznie się wykonały — BEZ ślepego
  * ponawiania samej operacji. Krok z udaną weryfikacją → 'done'; pozostałe
  * (brak verify, błąd połączenia, verify != 0) zostają 'needs_verification' do
  * ręcznej decyzji. Best-effort i bezpieczne (read-only verify).
  * @returns {Promise<{checked:number, confirmedDone:number, unresolved:number}>}
  */
 async verifyInterruptedSteps() {
   const journal = this._getJournal();
   let rows = [];
   try {
     rows = await journal.listNeedsVerification();
   } catch (err) {
     this.logger.error('Nie można odczytać kroków do weryfikacji', err);
     return { checked: 0, confirmedDone: 0, unresolved: 0 };
   }

   let confirmedDone = 0;
   let unresolved = 0;
   for (const row of rows) {
     const verify = row.verify;
     const serverId = row.server_id;
     // Bez polecenia weryfikującego albo bez serwera — nie ryzykujemy; zostawiamy.
     if (!verify || serverId == null) {
       unresolved++;
       continue;
     }
     try {
       const res = await this._execGuardedRaw(serverId, verify, null, null);
       if (res && (res.code === 0 || res.code === undefined)) {
         await this._journalSafe(() => journal.markVerifiedDone(row.plan_id, row.step_id));
         confirmedDone++;
       } else {
         unresolved++;
       }
     } catch (err) {
       // Serwer niedostępny / guard / inny błąd — NIE ponawiamy operacji.
       this.logger.warn('Read-back nierozstrzygnięty (krok zostaje do weryfikacji)', {
         planId: row.plan_id, stepId: row.step_id, reason: err.message,
       });
       unresolved++;
     }
   }
   return { checked: rows.length, confirmedDone, unresolved };
 }

 /**
  * Planuje ODROCZONE wykonanie planu z prawem weta: po `delayMs` plan zostanie
  * wykonany (executePlan), o ile nie zostanie wcześniej zawetowany.
  * @returns {{deferredId, fireAt, status}}
  */
 scheduleDeferredExecution(serverId, planId, options = {}) {
   const { delayMs = 0, planHash, approvals, appUserId } = options;
   return this._deferred.schedule(
     { serverId, planId, options: { planHash, approvals, appUserId } },
     delayMs
   );
 }

 /** Weto odroczonego wykonania (jeśli jeszcze nie wystartowało). */
 vetoDeferredExecution(deferredId, reason = null) {
   const ok = this._deferred.veto(deferredId, reason);
   return { vetoed: ok, deferredId };
 }

 /** Lista odroczonych wykonań. */
 listDeferredExecutions() {
   return this._deferred.list();
 }

  // --- Public API ---

  /**
   * Buduje plan wykonania z oceną ryzyka, BEZ wykonywania.
   * Każdy krok jest rozstrzygany do konkretnego polecenia (podgląd == wykonanie),
   * oceniany guardrailem i zapisywany w magazynie planów pod stabilnym hashem
   * (pin pod zatwierdzanie — ochrona przed TOCTOU).
   * @returns {Promise<{planId,planHash,summary,steps,maxRisk,requiresApproval,hasBlocked}>}
   */
  async buildPlan(prompt, serverId, options = {}) {
    if (!prompt || String(prompt).trim().length === 0) {
      throw new Error('Prompt nie może być pusty');
    }
    const serverConfig = await this.getServerConfig(serverId);
    if (!serverConfig) {
      throw new Error(`Serwer ${serverId} nie istnieje lub nie jest zarejestrowany`);
    }
    const validation = this.promptProcessor.validatePrompt(prompt);
    if (!validation.isValid) {
      throw new Error(`Prompt nieprawidłowy: ${validation.issues.join(', ')}`);
    }

    this.logger.logAction('LLM_PROMPT_RECEIVED', { serverId, snippet: prompt.slice(0, 200) });

    const { plan, tasks } = await this._buildPlanAndTasks(prompt, serverConfig);
    const os = (serverConfig.os || 'linux').toLowerCase();

    // Rozstrzygnij każdy krok do konkretnego polecenia (to, co realnie zostanie
    // wykonane), aby podgląd, hash i wykonanie były identyczne. Typed actions
    // (usługa/pakiet) zyskują automatycznie verify + compensation + metadane.
    const typedOnly = !!options.typedOnly;
    const resolved = [];
    let rejectedRaw = 0;
    planFromTasks(tasks, plan).steps.forEach((s, i) => {
      const id = s.id || `step_${i + 1}`;
      const r = actionRegistry.resolve({ ...s, id }, os);
      if (r.typed) {
        resolved.push({ ...r.step, id });
        return;
      }
      // Surowe polecenie — w trybie autonomicznym (typedOnly) niedozwolone.
      if (typedOnly) {
        rejectedRaw++;
        return;
      }
      const command = this._resolveStepCommand(s, os);
      if (s.type === 'noop' || command) {
        resolved.push({ ...s, id, os, command: command || undefined });
      }
    });
    if (typedOnly && rejectedRaw > 0) {
      this.logger.warn(
        `Tryb typedOnly: odrzucono ${rejectedRaw} kroków bez typed-action (surowe polecenia).`
      );
    }

    const guarded = this.orchestrator.buildPlan({ summary: plan, steps: resolved });
    const planHash = computePlanHash(guarded.steps);
    const planId = 'plan_' + Math.random().toString(36).slice(2, 10);

    // Opcjonalny pin prekondycji stanu serwera (aprobata wygasa, gdy stan się
    // zmieni między zatwierdzeniem a wykonaniem). Domyślnie wyłączony.
    let preconditionHash = null;
    if (options.capturePrecondition || options.preconditionProvider) {
      try {
        preconditionHash = await this._computePrecondition(serverId, options);
      } catch (e) {
        this.logger.warn('Nie udało się pobrać prekondycji stanu', { error: e.message });
      }
    }

    this._planStore.set(planId, {
      planId, serverId, os, prompt, summary: plan,
      steps: guarded.steps, planHash, preconditionHash, createdAt: new Date().toISOString(),
    });

    return {
      planId, planHash, preconditionHash, summary: plan, steps: guarded.steps,
      maxRisk: guarded.maxRisk,
      requiresApproval: guarded.requiresApproval,
      hasBlocked: guarded.hasBlocked,
      rejectedRaw,
    };
  }

  /** Liczy hash prekondycji (z wstrzykniętego providera lub fingerprintu serwera). */
  async _computePrecondition(serverId, options = {}) {
    let value;
    if (typeof options.preconditionProvider === 'function') {
      value = await options.preconditionProvider(serverId);
    } else {
      value = await this._serverStateFingerprint(serverId);
    }
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  /** Lekki odcisk stanu serwera (read-only): OS/kernel + hostname. */
  async _serverStateFingerprint(serverId) {
    const exec = async (cmd) => {
      try {
        if (!this.serverManager.isServerConnected(serverId)) {
          await this.serverManager.connectToServer(serverId);
        }
        const r = await this.serverManager.executeCommand(serverId, cmd, { source: 'system' });
        return (r && r.stdout) || '';
      } catch {
        return '';
      }
    };
    const parts = [];
    parts.push(await exec('uname -a 2>/dev/null || ver'));
    parts.push(await exec('hostname'));
    return parts.join('\n');
  }

  /**
   * Wykonuje WCZEŚNIEJ zbudowany plan (po planId), weryfikując, że nie zmienił
   * się od zatwierdzenia (planHash). Kroki 'high' wykonują się tylko, gdy ich id
   * jest w `approvals` (zgoda per-krok); 'critical' są zawsze blokowane.
   * @param {number|string} serverId
   * @param {string} planId
   * @param {Object} options – { planHash, approvals, dryRun, stopOnError, appUserId }
   */
  async executePlan(serverId, planId, options = {}) {
    const stored = this._planStore.get(planId);
    if (!stored) {
      const e = new Error('Plan nie istnieje lub wygasł'); e.code = 'PLAN_NOT_FOUND'; throw e;
    }
    if (String(stored.serverId) !== String(serverId)) {
      const e = new Error('Plan nie pasuje do serwera'); e.code = 'PLAN_SERVER_MISMATCH'; throw e;
    }
    if (options.planHash && options.planHash !== stored.planHash) {
      const e = new Error('Plan zmienił się od zatwierdzenia — odśwież i zatwierdź ponownie');
      e.code = 'PLAN_CHANGED'; throw e;
    }
    // Prekondycja stanu: aprobata wygasa, jeśli stan serwera zmienił się od
    // zbudowania planu (chyba że dry-run lub jawne pominięcie).
    if (stored.preconditionHash && !options.dryRun && !options.skipPreconditionCheck) {
      let current = null;
      try {
        current = await this._computePrecondition(serverId, options);
      } catch (e) {
        this.logger.warn('Nie można zweryfikować prekondycji stanu', { error: e.message });
      }
      if (current !== stored.preconditionHash) {
        const e = new Error('Stan serwera zmienił się od zatwierdzenia — wymagane ponowne zatwierdzenie');
        e.code = 'PLAN_STATE_CHANGED'; throw e;
      }
    }

    const approvals = Array.isArray(options.approvals)
      ? options.approvals
      : options.approvals && typeof options.approvals === 'object'
      ? Object.keys(options.approvals).filter((k) => options.approvals[k])
      : [];
    const os = stored.os;
    const journal = this._getJournal();
    const dryRun = !!options.dryRun;

    // Zarejestruj kroki w journalu (idempotentnie) — chyba że dry-run.
    if (!dryRun) {
      await this._journalSafe(() =>
        journal.startRun({ planId, planHash: stored.planHash, serverId, steps: stored.steps })
      );
    }

    const executor = async (step) => {
      // Idempotencja: krok już wykonany (np. wznowienie) nie powtarza się.
      if (!dryRun && (await this._journalSafe(() => journal.isStepDone(planId, step.id)))) {
        return { skipped: true, reason: 'idempotent: krok już wykonany' };
      }
      if (!dryRun) await this._journalSafe(() => journal.beginStep(planId, step.id));

      // Defense-in-depth: krytyczne polecenie nigdy nie przechodzi.
      const g = evaluateCommand(step.command, { os });
      if (!g.allowed) {
        if (!dryRun) {
          await this._journalSafe(() =>
            journal.completeStep(planId, step.id, { status: 'error', error: 'GUARD_BLOCKED' })
          );
        }
        const e = new Error('Polecenie zablokowane przez guardrail'); e.code = 'GUARD_BLOCKED'; throw e;
      }
      if (!this.serverManager.isServerConnected(serverId)) {
        await this.serverManager.connectToServer(serverId);
      }
      try {
        const res = await this.serverManager.executeCommand(serverId, step.command, {
          actorUserId: options.appUserId || null, source: 'llm',
        });
        if (!dryRun) {
          await this._journalSafe(() =>
            journal.completeStep(planId, step.id, { status: 'done', result: res })
          );
        }
        return res;
      } catch (err) {
        if (!dryRun) {
          await this._journalSafe(() =>
            journal.completeStep(planId, step.id, { status: 'error', error: err.message })
          );
        }
        throw err;
      }
    };

    // Weryfikacja po wykonaniu (postcondition): polecenie `verify` z kodem 0 = OK.
    const verifier = async (step) => {
      if (!step.verify) return { ok: true };
      try {
        const r = await this._execGuardedRaw(serverId, step.verify, os, options.appUserId);
        const ok = (r && (r.code === 0 || r.code === undefined)) || false;
        return { ok, detail: ok ? null : (r && (r.stderr || r.stdout)) || 'verify exit != 0' };
      } catch (err) {
        return { ok: false, detail: err.message };
      }
    };

    // Kompensacja (rollback) kroku w trybie saga.
    const compensator = async (step) => {
      if (!step.compensation) return;
      await this._execGuardedRaw(serverId, step.compensation, os, options.appUserId);
    };

    // Saga aktywna, gdy którykolwiek krok deklaruje kompensację.
    const saga = !dryRun && stored.steps.some((s) => s.compensation);

    const { status, results } = await this.orchestrator.execute(
      { summary: stored.summary, steps: stored.steps },
      {
        executor,
        approvals,
        dryRun,
        stopOnError: options.stopOnError !== false,
        os,
        verifier,
        compensator,
        saga,
      }
    );

    // Odzwierciedl w journalu kroki nie wykonane oraz wyniki weryfikacji/kompensacji.
    if (!dryRun) {
      for (const r of results) {
        let jStatus = null;
        if (r.compensated) jStatus = 'compensated';
        else if (r.status === 'verify_failed') jStatus = 'verify_failed';
        else if (r.status === 'needs_approval') jStatus = 'pending';
        else if (['blocked', 'skipped'].includes(r.status)) jStatus = r.status;
        if (jStatus) {
          await this._journalSafe(() =>
            journal.completeStep(planId, r.id, { status: jStatus, error: r.error || null })
          );
        }
      }
    }

    await this._persistExecution(serverId, {
      prompt: stored.prompt, plan: stored.summary, status, results, appUserId: options.appUserId,
    });
    this.logger.logAction('LLM_PLAN_EXECUTED', { serverId, planId, status, approvals: approvals.length });

    // Plan jednorazowy — po realnym wykonaniu usuwamy z magazynu.
    if (!options.dryRun) this._planStore.delete(planId);
    return { planId, planHash: stored.planHash, status, results };
  }

  /**
   * Zgodny wstecznie wrapper. Buduje plan i — przy autoExecute — wykonuje przez
   * executePlan. Bezpieczeństwo: tryb jednowywołaniowy NIE zatwierdza kroków
   * 'high' (brak zgody per-krok) — wracają jako needs_approval, a 'critical' jako
   * blocked. Pełne zatwierdzanie odbywa się przez executePlan z `approvals`.
   * @returns {Promise<{planId,planHash,plan,guardedPlan,tasks,executionResults,status}>}
   */
  async processAndExecutePrompt(prompt, serverId, options = {}) {
    const { autoExecute = false, stopOnError = true, dryRun = false } = options;
    try {
      const built = await this.buildPlan(prompt, serverId, options);

      let executionResults = [];
      let status = built.hasBlocked
        ? 'blocked'
        : built.requiresApproval
        ? 'needs_approval'
        : 'planned';

      if (autoExecute && built.steps.length > 0) {
        const exec = await this.executePlan(serverId, built.planId, {
          planHash: built.planHash, dryRun, stopOnError, appUserId: options.appUserId,
        });
        executionResults = exec.results;
        status = exec.status;
      }

      this.logger.logAction('LLM_PROMPT_PROCESSED', {
        serverId, status, autoExecute, maxRisk: built.maxRisk, steps: built.steps.length,
      });

      return {
        planId: built.planId, planHash: built.planHash, plan: built.summary,
        guardedPlan: built, tasks: built.steps, executionResults, status,
      };
    } catch (error) {
      this.logger.error('Błąd processAndExecutePrompt', error, { serverId });
      throw error;
    }
  }

  /**
   * Persistencja wyników wykonania planu (llm_tasks + llm_task_results + history).
   */
  async _persistExecution(serverId, { prompt, plan, status, results = [], appUserId = null }) {
    try {
      const llmTask = await this.llmTaskRepo.insertTask({
        serverId, appUserId: appUserId || null, prompt, plan, status, autoExecute: true,
      });
      let stepIndex = 0;
      for (const exec of results) {
        await this.llmTaskRepo.insertResult({
          llmTaskId: llmTask.id, stepIndex: stepIndex++, taskType: exec.type || null,
          description: exec.description || null, command: exec.command || null,
          status: exec.status || 'success',
          result: exec.result ? JSON.stringify(exec.result) : null,
          errorMessage: exec.error || null,
        });
        if (exec.command && exec.status !== 'dry_run') {
          await this.commandHistoryRepo.insert({
            serverId, appUserId: appUserId || null, source: 'llm', command: exec.command,
            result: exec.result ? JSON.stringify(exec.result) : null,
            exitCode: typeof (exec.result && exec.result.code) === 'number'
              ? exec.result.code : exec.status === 'error' ? 1 : 0,
          });
        }
      }
      this.addToTaskHistory(serverId, {
        id: llmTask.id, serverId, prompt, plan, executionResults: results, status,
        createdAt: llmTask.created_at || new Date().toISOString(),
      });
    } catch (err) {
      this.logger.error('Błąd persistencji wykonania planu', err, { serverId });
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
   * Rozstrzyga krok planu do konkretnego polecenia powłoki (lub null dla noop /
   * kroków niewykonywalnych). Wartości użytkownika są escapowane / walidowane
   * (anty-injection). Wynik jest tym, co realnie zostanie wykonane — dzięki czemu
   * podgląd, hash i wykonanie są identyczne.
   * @param {Object} step
   * @param {string} os
   * @returns {string|null}
   */
  _resolveStepCommand(step, os) {
    const type = (step.type || '').toLowerCase();
    const isWin = String(os).toLowerCase() === 'windows';

    if (type === 'noop') return null;

    if (type === 'command') {
      return typeof step.command === 'string' && step.command.trim()
        ? step.command.trim()
        : null;
    }

    if (type === 'service') {
      const serviceName = step.serviceName || step.name;
      const action = (step.action || '').toLowerCase();
      if (!serviceName) return null;
      assertIdentifier(serviceName, 'serviceName');
      if (isWin) {
        if (action === 'restart') {
          return `sc stop ${winCmdArg(serviceName)} && sc start ${winCmdArg(serviceName)}`;
        }
        if (action === 'start' || action === 'stop') {
          return `sc ${action} ${winCmdArg(serviceName)}`;
        }
        return null;
      }
      if (['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action)) {
        return `sudo systemctl ${action} ${shQuote(serviceName)}`;
      }
      return null;
    }

    if (type === 'installation' || type === 'package') {
      const packageName = step.packageName || step.app || step.name;
      if (!packageName) return null;
      if (isWin) return `choco install ${winCmdArg(packageName)} -y`;
      const pkg = shQuote(packageName);
      return `if command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y ${pkg}; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y ${pkg}; elif command -v yum >/dev/null 2>&1; then sudo yum install -y ${pkg}; else echo "Nieznany menedżer pakietów"; exit 1; fi`;
    }

    // Fallback: surowa komenda, jeśli krok ją zawiera.
    return typeof step.command === 'string' && step.command.trim()
      ? step.command.trim()
      : null;
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