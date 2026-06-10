const { evaluatePlan, evaluateCommand } = require('./command-guard');

/**
 * Orchestrator wykonania planu z guardrailem, trybem dry-run i bramką
 * zatwierdzania.
 *
 * Cykl: zbuduj plan -> (podgląd + ocena ryzyka) -> zatwierdź -> wykonaj.
 * Wykonanie deleguje do wstrzykniętego `executor(step)` (testowalność), więc
 * orchestrator nie zna szczegółów SSH/WinRM.
 *
 * Statusy kroków:
 *  - success        : wykonany pomyślnie
 *  - error          : błąd wykonania
 *  - blocked        : zablokowany przez guard (ryzyko 'critical')
 *  - needs_approval : ryzyko 'high', brak zatwierdzenia
 *  - dry_run        : tryb podglądu, nie wykonano
 *  - skipped        : pominięty (np. po stopOnError)
 */
class Orchestrator {
  constructor(config = {}) {
    this.logger = config.logger || null;
  }

  /**
   * Buduje podgląd planu z oceną ryzyka (bez wykonania).
   * @param {{summary?:string, steps:Array}} plan
   */
  buildPlan(plan) {
    const { summary = '', steps = [] } = plan || {};
    const evaluated = evaluatePlan(steps);
    return {
      summary,
      steps: evaluated.steps,
      maxRisk: evaluated.maxRisk,
      hasBlocked: evaluated.hasBlocked,
      requiresApproval: evaluated.requiresApproval || evaluated.hasBlocked,
    };
  }

  /**
   * Wykonuje plan przez wstrzyknięty executor.
   * @param {{summary?:string, steps:Array}} plan
   * @param {Object} options
   *  - executor: async (step) => wynik
   *  - approveHighRisk?: boolean        (blankietowa zgoda na wszystkie 'high')
   *  - approvals?: Iterable<string>     (zgoda per-krok: zbiór id kroków)
   *  - dryRun?: boolean
   *  - stopOnError?: boolean (default true)
   *  - os?: string
   * @returns {Promise<{status:string, results:Array}>}
   */
  async execute(plan, options = {}) {
    const {
      executor,
      approveHighRisk = false,
      approvals = null,
      dryRun = false,
      stopOnError = true,
      os = undefined,
    } = options;

    if (typeof executor !== 'function' && !dryRun) {
      throw new Error('Orchestrator.execute wymaga executor() (lub dryRun=true)');
    }

    const approvedSet = approvals instanceof Set ? approvals : new Set(approvals || []);
    const steps = (plan && plan.steps) || [];
    const results = [];
    let halted = false;

    for (const step of steps) {
      if (halted) {
        results.push(this._mk(step, 'skipped', { reason: 'przerwano po błędzie' }));
        continue;
      }

      const guard = step.command
        ? evaluateCommand(step.command, { os: step.os || os })
        : (step.guard || { risk: 'low', allowed: true, violations: [] });

      // 1. Blokada (critical) — nigdy nie wykonujemy.
      if (!guard.allowed) {
        results.push(this._mk(step, 'blocked', { guard }));
        if (stopOnError) halted = true;
        continue;
      }

      // 2. Wymagane zatwierdzenie (high) — blankietowe lub per-krok.
      const approved = approveHighRisk || approvedSet.has(step.id);
      if (guard.risk === 'high' && !approved) {
        results.push(this._mk(step, 'needs_approval', { guard }));
        if (stopOnError) halted = true;
        continue;
      }

      // 3. Dry-run — pokaż, nie wykonuj
      if (dryRun) {
        results.push(this._mk(step, 'dry_run', { guard }));
        continue;
      }

      // 4. Wykonanie
      try {
        const result = await executor(step);
        results.push(this._mk(step, 'success', { guard, result }));
      } catch (error) {
        results.push(this._mk(step, 'error', { guard, error: error.message }));
        if (this.logger) {
          this.logger.error('Orchestrator: błąd kroku', error, { stepId: step.id });
        }
        if (stopOnError) halted = true;
      }
    }

    const status = this._aggregateStatus(results, dryRun);
    return { status, results };
  }

  _mk(step, status, extra = {}) {
    return {
      id: step.id,
      type: step.type,
      description: step.description,
      command: step.command || null,
      risk: (extra.guard && extra.guard.risk) || 'low',
      violations: (extra.guard && extra.guard.violations) || [],
      status,
      result: extra.result !== undefined ? extra.result : null,
      error: extra.error || null,
      reason: extra.reason || null,
      timestamp: new Date().toISOString(),
    };
  }

  _aggregateStatus(results, dryRun) {
    if (dryRun) return 'dry_run';
    if (results.some((r) => r.status === 'blocked')) return 'blocked';
    if (results.some((r) => r.status === 'needs_approval')) return 'needs_approval';
    if (results.some((r) => r.status === 'error')) return 'partial_error';
    if (results.length === 0) return 'empty';
    return 'executed';
  }
}

module.exports = Orchestrator;
