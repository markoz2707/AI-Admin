/**
 * Trwały journal wykonania planów.
 *
 * Cel: wykonywanie wielokrokowych zmian musi przetrwać awarię kontrolera.
 * Journal zapisuje stan każdego kroku (pending → executing → done/error), co
 * daje:
 *  - idempotencję (krok już 'done' nie jest wykonywany ponownie przy wznowieniu),
 *  - wykrycie kroków przerwanych awarią (status 'executing' po restarcie),
 *  - read-back-before-retry (przerwane kroki trafiają do 'needs_verification',
 *    a nie do ślepego ponowienia).
 *
 * Logika jest oddzielona od składowania (store), dzięki czemu można ją testować
 * z magazynem in-memory, a w produkcji używać SQLite.
 */

let getConnection = null;
try {
  ({ getConnection } = require('../database/database-config'));
} catch {
  getConnection = null;
}

const STATUSES = [
  'pending',
  'executing',
  'done',
  'error',
  'skipped',
  'needs_verification',
  'verify_failed',
  'compensated',
];

// ---------------------------------------------------------------------------
// Store: SQLite
// ---------------------------------------------------------------------------
class SqliteJournalStore {
  constructor(db) {
    this.db = db;
    this._ready = false;
  }

  async ensureReady() {
    if (this._ready) return;
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL,
        plan_hash TEXT,
        server_id INTEGER,
        step_id TEXT NOT NULL,
        step_index INTEGER,
        command TEXT,
        verify TEXT,
        compensation TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (plan_id, step_id)
      );
    `);
    // Migracja defensywna dla istniejących baz (kolumny dodane później).
    for (const col of ['verify TEXT', 'compensation TEXT']) {
      try {
        await this.db.exec(`ALTER TABLE execution_journal ADD COLUMN ${col};`);
      } catch {
        /* kolumna już istnieje */
      }
    }
    await this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_exec_journal_status ON execution_journal (status);`
    );
    this._ready = true;
  }

  async upsertPending(row) {
    await this.db.run(
      `INSERT OR IGNORE INTO execution_journal
        (plan_id, plan_hash, server_id, step_id, step_index, command, verify, compensation, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        row.planId, row.planHash, row.serverId, row.stepId, row.stepIndex,
        row.command, row.verify || null, row.compensation || null,
      ]
    );
  }

  async update(planId, stepId, fields) {
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = k === 'attempt' ? 'attempt' : k;
      sets.push(`${col} = ?`);
      params.push(v);
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    params.push(planId, stepId);
    await this.db.run(
      `UPDATE execution_journal SET ${sets.join(', ')} WHERE plan_id = ? AND step_id = ?`,
      params
    );
  }

  async get(planId, stepId) {
    return this.db.get(
      `SELECT * FROM execution_journal WHERE plan_id = ? AND step_id = ?`,
      [planId, stepId]
    );
  }

  async listByPlan(planId) {
    return this.db.all(
      `SELECT * FROM execution_journal WHERE plan_id = ? ORDER BY step_index ASC`,
      [planId]
    );
  }

  async listByStatus(status) {
    return this.db.all(
      `SELECT * FROM execution_journal WHERE status = ? ORDER BY updated_at ASC`,
      [status]
    );
  }
}

// ---------------------------------------------------------------------------
// Store: in-memory (testy / fallback bez bazy)
// ---------------------------------------------------------------------------
function createMemoryStore() {
  const rows = new Map(); // key: planId::stepId
  const key = (p, s) => `${p}::${s}`;
  return {
    async ensureReady() {},
    async upsertPending(row) {
      const k = key(row.planId, row.stepId);
      if (!rows.has(k)) {
        rows.set(k, {
          plan_id: row.planId,
          plan_hash: row.planHash || null,
          server_id: row.serverId != null ? row.serverId : null,
          step_id: row.stepId,
          step_index: row.stepIndex,
          command: row.command || null,
          verify: row.verify || null,
          compensation: row.compensation || null,
          status: 'pending',
          attempt: 0,
          result: null,
          error: null,
        });
      }
    },
    async update(planId, stepId, fields) {
      const k = key(planId, stepId);
      const cur = rows.get(k);
      if (cur) rows.set(k, { ...cur, ...fields });
    },
    async get(planId, stepId) {
      return rows.get(key(planId, stepId)) || null;
    },
    async listByPlan(planId) {
      return [...rows.values()]
        .filter((r) => r.plan_id === planId)
        .sort((a, b) => (a.step_index || 0) - (b.step_index || 0));
    },
    async listByStatus(status) {
      return [...rows.values()].filter((r) => r.status === status);
    },
  };
}

// ---------------------------------------------------------------------------
// Logika journala
// ---------------------------------------------------------------------------
class ExecutionJournal {
  constructor(store) {
    this.store = store;
  }

  /**
   * Tworzy domyślny journal: SQLite jeśli baza dostępna, inaczej in-memory.
   */
  static createDefault() {
    if (getConnection) {
      try {
        const conn = getConnection();
        if (conn && conn.db) {
          return new ExecutionJournal(new SqliteJournalStore(conn));
        }
      } catch {
        /* fallback poniżej */
      }
    }
    return new ExecutionJournal(createMemoryStore());
  }

  async ensureReady() {
    if (this.store.ensureReady) await this.store.ensureReady();
  }

  /** Rejestruje kroki planu jako pending (idempotentnie). */
  async startRun({ planId, planHash, serverId, steps = [] }) {
    await this.ensureReady();
    let i = 0;
    for (const step of steps) {
      await this.store.upsertPending({
        planId,
        planHash: planHash || null,
        serverId: serverId != null ? serverId : null,
        stepId: step.id,
        stepIndex: i++,
        command: step.command || null,
        verify: step.verify || null,
        compensation: step.compensation || null,
      });
    }
  }

  async beginStep(planId, stepId) {
    const cur = await this.store.get(planId, stepId);
    await this.store.update(planId, stepId, {
      status: 'executing',
      attempt: ((cur && cur.attempt) || 0) + 1,
    });
  }

  async completeStep(planId, stepId, { status = 'done', result = null, error = null } = {}) {
    await this.store.update(planId, stepId, {
      status: STATUSES.includes(status) ? status : 'done',
      result: result != null ? JSON.stringify(result) : null,
      error: error || null,
    });
  }

  async isStepDone(planId, stepId) {
    const r = await this.store.get(planId, stepId);
    return !!(r && r.status === 'done');
  }

  async getRun(planId) {
    return this.store.listByPlan(planId);
  }

  /** Kroki przerwane awarią (zostały w 'executing' po restarcie). */
  async findInterrupted() {
    return this.store.listByStatus('executing');
  }

  /** Kroki oczekujące na weryfikację (read-back po odzyskaniu). */
  async listNeedsVerification() {
    return this.store.listByStatus('needs_verification');
  }

  /** Oznacza krok jako zweryfikowany-OK ('done') po udanym read-backu. */
  async markVerifiedDone(planId, stepId) {
    await this.store.update(planId, stepId, { status: 'done' });
  }

  /**
   * Odzyskiwanie: przerwane kroki ('executing') NIE są ślepo ponawiane —
   * trafiają do 'needs_verification' (wymagają read-back / weryfikacji stanu).
   * @returns {Promise<Array>} lista odzyskanych kroków
   */
  async recover() {
    const interrupted = await this.findInterrupted();
    for (const row of interrupted) {
      await this.store.update(row.plan_id, row.step_id, {
        status: 'needs_verification',
      });
    }
    return interrupted;
  }
}

module.exports = {
  ExecutionJournal,
  SqliteJournalStore,
  createMemoryStore,
  STATUSES,
};
