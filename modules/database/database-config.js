// Minimalna konfiguracja SQLite z kontraktem pod resztę modułów.
// Implementacja używa wbudowanego modułu 'sqlite3' JEŚLI jest dostępny.
// Jeśli nie, pozostawia TODO, ale struktura API (getConnection, run, get, all, close) jest stała.

const path = require('path');
const fs = require('fs');

let sqlite3 = null;
try {
  // Nie wymuszamy instalacji, ale jeśli jest dostępna, użyjemy jej.
  // Docelowo projekt powinien mieć sqlite3 w dependencies.
  // eslint-disable-next-line import/no-extraneous-dependencies
  sqlite3 = require('sqlite3').verbose();
} catch (e) {
  console.warn('[database-config] Moduł sqlite3 nie jest dostępny. Połączenie będzie działać jako stub. TODO: dodać zależność sqlite3.');
}

/**
 * Ścieżka do pliku bazy SQLite.
 * Domyślnie w katalogu projektu (można nadpisać ENV).
 */
const DB_PATH =
  process.env.AI_ADMIN_DB_PATH ||
  path.join(__dirname, '..', '..', 'ai-admin.sqlite');

/**
 * Singleton połączenia.
 * @type {{ db: any } | null}
 */
let connection = null;

/**
 * Tworzy katalog dla bazy jeśli nie istnieje.
 */
function ensureDbDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Zwraca singleton połączenia do SQLite z prostym API:
 * - run(sql, params?) -> Promise<{ lastID, changes }>
 * - get(sql, params?) -> Promise<any>
 * - all(sql, params?) -> Promise<any[]>
 * - exec(sql) -> Promise<void>
 * - close() -> Promise<void>
 */
function getConnection() {
  if (connection) {
    return connection;
  }

  ensureDbDir();

  if (!sqlite3) {
    // Stub pozwalający uniknąć natychmiastowego crasha w środowisku bez sqlite3.
    console.warn('[database-config] Zwracam stub connection (brak sqlite3). Wszystkie operacje zakończą się błędem.');
    const errorFn = async () => {
      throw new Error('SQLite driver (sqlite3) not available. TODO: dodać zależność i zainstalować.');
    };
    connection = {
      db: null,
      run: errorFn,
      get: errorFn,
      all: errorFn,
      exec: errorFn,
      close: async () => {},
    };
    return connection;
  }

  const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('[database-config] Błąd otwierania bazy SQLite:', err.message);
    } else {
      console.log('[database-config] Połączono z bazą SQLite:', DB_PATH);
    }
  });

  connection = {
    db,
    run(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.run(sql, params, function runCb(err) {
          if (err) {
            return reject(err);
          }
          resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    },
    get(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
          if (err) {
            return reject(err);
          }
          resolve(row || null);
        });
      });
    },
    all(sql, params = []) {
      return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
          if (err) {
            return reject(err);
          }
          resolve(rows || []);
        });
      });
    },
    exec(sql) {
      return new Promise((resolve, reject) => {
        db.exec(sql, (err) => {
          if (err) {
            return reject(err);
          }
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        db.close((err) => {
          if (err) {
            return reject(err);
          }
          connection = null;
          resolve();
        });
      });
    },
  };

  return connection;
}

module.exports = {
  getConnection,
};