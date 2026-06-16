/**
 * Silnik ciągłej pętli agenta (continuous maintenance loop).
 *
 * Wykonuje cyklicznie wstrzyknięty krok `tick()` (perceive→reason→plan→gate→
 * execute→verify), z twardymi barierami bezpieczeństwa:
 *  - brak nakładania cykli (jeśli poprzedni tick trwa, kolejny jest pomijany),
 *  - circuit breaker (po N kolejnych błędach pętla sama się zatrzymuje),
 *  - kill-switch (stop()) i pauza,
 *  - interwał jako rate-limit.
 *
 * Zegar (`setIntervalFn`/`clearIntervalFn`) jest wstrzykiwalny — pełna
 * testowalność bez czekania w czasie rzeczywistym. Sam tick (percepcja/plan/
 * wykonanie) jest wstrzykiwany, więc silnik nie zna szczegółów infrastruktury.
 */

class AgentLoop {
  constructor(config = {}) {
    this.tick = config.tick; // async () => void  (jeden cykl)
    this.logger = config.logger || null;
    this.intervalMs = config.intervalMs || 60000;
    this.maxFailures = config.maxFailures || 3;
    this._setInterval = config.setIntervalFn || setInterval;
    this._clearInterval = config.clearIntervalFn || clearInterval;

    this.running = false;
    this.tripped = false; // circuit breaker otwarty
    this._inFlight = false;
    this._timer = null;
    this.ticks = 0;
    this.failures = 0; // kolejne błędy
    this.lastError = null;
    this.lastRunAt = null;
  }

  /** Uruchamia pętlę (idempotentne). */
  start(intervalMs) {
    if (this.running) return this.status();
    if (typeof this.tick !== 'function') {
      throw new Error('AgentLoop wymaga funkcji tick()');
    }
    this.running = true;
    this.tripped = false;
    const interval = intervalMs || this.intervalMs;
    this._timer = this._setInterval(() => this.runOnce(), interval);
    if (this.logger) this.logger.info('Pętla agenta uruchomiona', { intervalMs: interval });
    return this.status();
  }

  /** Zatrzymuje pętlę (kill-switch). */
  stop() {
    if (this._timer != null) this._clearInterval(this._timer);
    this._timer = null;
    this.running = false;
    if (this.logger) this.logger.info('Pętla agenta zatrzymana');
    return this.status();
  }

  /** Reset circuit breakera (po naprawie przyczyny błędów). */
  reset() {
    this.tripped = false;
    this.failures = 0;
    this.lastError = null;
    return this.status();
  }

  /**
   * Wykonuje pojedynczy cykl. Bezpieczne do wołania ręcznie (i przez interwał).
   * Pomija się, gdy: circuit breaker otwarty lub poprzedni tick trwa.
   * @returns {Promise<{ran:boolean, reason?:string}>}
   */
  async runOnce() {
    if (this.tripped) return { ran: false, reason: 'circuit_open' };
    if (this._inFlight) return { ran: false, reason: 'overlap' };

    this._inFlight = true;
    this.lastRunAt = new Date().toISOString();
    try {
      await this.tick();
      this.ticks++;
      this.failures = 0;
      return { ran: true };
    } catch (err) {
      this.failures++;
      this.lastError = err.message;
      if (this.logger) this.logger.error('Błąd cyklu pętli agenta', err, { failures: this.failures });
      // Circuit breaker: po N kolejnych błędach zatrzymaj autonomię.
      if (this.failures >= this.maxFailures) {
        this.tripped = true;
        this.stop();
        if (this.logger) {
          this.logger.warn('Circuit breaker: pętla agenta wstrzymana po serii błędów', {
            failures: this.failures,
          });
        }
      }
      return { ran: false, reason: 'error' };
    } finally {
      this._inFlight = false;
    }
  }

  status() {
    return {
      running: this.running,
      tripped: this.tripped,
      ticks: this.ticks,
      failures: this.failures,
      lastError: this.lastError,
      lastRunAt: this.lastRunAt,
      intervalMs: this.intervalMs,
    };
  }
}

module.exports = AgentLoop;
