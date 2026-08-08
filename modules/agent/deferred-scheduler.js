/**
 * Scheduler wykonania ODROCZONEGO Z PRAWEM WETA.
 *
 * Poziom autonomii pośredni między NOTIFY a APPROVAL: agent zapowiada wykonanie
 * za czas T; w tym oknie administrator może je zawetować. Jeśli brak weta —
 * wykonuje się automatycznie. To buduje zaufanie stopniowo: operator widzi, co
 * agent zamierza, i ma realną szansę zatrzymać.
 *
 * Zegar (`setTimeoutFn`/`clearTimeoutFn`) jest wstrzykiwalny — pełna testowalność
 * bez czekania w czasie rzeczywistym. Wykonanie deleguje do wstrzykniętego
 * `execute(item)`.
 */

let counter = 0;

class DeferredScheduler {
  constructor(config = {}) {
    this.execute = config.execute;
    this.logger = config.logger || null;
    this._setTimeout = config.setTimeoutFn || setTimeout;
    this._clearTimeout = config.clearTimeoutFn || clearTimeout;
    this._items = new Map(); // deferredId -> record
  }

  /**
   * Planuje odroczone wykonanie.
   * @param {Object} item  – dane przekazywane do execute() po upływie T
   * @param {number} delayMs
   * @returns {{ deferredId:string, fireAt:string, status:string }}
   */
  schedule(item, delayMs = 0) {
    const deferredId = `def_${Date.now().toString(36)}_${++counter}`;
    const fireAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
    const record = {
      deferredId,
      item,
      status: 'pending', // pending | firing | fired | vetoed | error
      fireAt,
      createdAt: new Date().toISOString(),
      result: null,
      error: null,
      vetoReason: null,
      timer: null,
    };
    record.timer = this._setTimeout(() => {
      // Zwracamy promise, by testy mogły go zaczekać (await cb()).
      return this._fire(deferredId);
    }, Math.max(0, delayMs));
    this._items.set(deferredId, record);
    if (this.logger) {
      this.logger.info('Zaplanowano odroczone wykonanie (prawo weta)', { deferredId, fireAt });
    }
    return { deferredId, fireAt, status: record.status };
  }

  async _fire(deferredId) {
    const record = this._items.get(deferredId);
    if (!record || record.status !== 'pending') return;
    record.status = 'firing';
    try {
      record.result = await this.execute(record.item);
      record.status = 'fired';
      if (this.logger) this.logger.info('Odroczone wykonanie zrealizowane', { deferredId });
    } catch (err) {
      record.status = 'error';
      record.error = err.message;
      if (this.logger) this.logger.error('Błąd odroczonego wykonania', err, { deferredId });
    }
    return record;
  }

  /**
   * Weto: anuluje zaplanowane wykonanie, jeśli jeszcze nie wystartowało.
   * @returns {boolean} true gdy skutecznie zawetowano
   */
  veto(deferredId, reason = null) {
    const record = this._items.get(deferredId);
    if (!record || record.status !== 'pending') return false;
    this._clearTimeout(record.timer);
    record.status = 'vetoed';
    record.vetoReason = reason;
    if (this.logger) this.logger.warn('Zawetowano odroczone wykonanie', { deferredId, reason });
    return true;
  }

  get(deferredId) {
    const r = this._items.get(deferredId);
    return r ? this._public(r) : null;
  }

  /** Lista odroczeń (bez wewnętrznego timera). */
  list() {
    return [...this._items.values()].map((r) => this._public(r));
  }

  _public(r) {
    return {
      deferredId: r.deferredId,
      status: r.status,
      fireAt: r.fireAt,
      createdAt: r.createdAt,
      item: { serverId: r.item.serverId, planId: r.item.planId },
      result: r.result,
      error: r.error,
      vetoReason: r.vetoReason,
    };
  }
}

module.exports = DeferredScheduler;
