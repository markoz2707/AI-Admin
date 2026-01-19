// MigrationManager dla SQLite wykorzystujący schema.sql oraz prostą tabelę schema_migrations.
// Cel:
// - Włączenie PRAGMA foreign_keys=ON
// - Jednorazowe zastosowanie schema.sql jako "initial_schema"
// - Idempotencja przy kolejnych startach

const fs = require('fs');
const path = require('path');
const { getConnection } = require('./database-config');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const INITIAL_MIGRATION_NAME = 'initial_schema';

class MigrationManager {
  constructor() {
    this.initialized = false;
  }

  async ensureMigrationsTable(conn) {
    await conn.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async hasMigration(conn, name) {
    const row = await conn.get(
      'SELECT id FROM schema_migrations WHERE name = ? LIMIT 1',
      [name]
    );
    return !!row;
  }

  async insertMigration(conn, name) {
    await conn.run(
      'INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)',
      [name]
    );
  }

  /**
   * Uruchamia migracje na bazie SQLite.
   * - Włącza PRAGMA foreign_keys=ON
   * - Tworzy (jeśli brak) tabelę schema_migrations
   * - Jeśli initial_schema nie została zastosowana:
   *    - wykonuje schema.sql
   *    - rejestruje initial_schema w schema_migrations
   * - Idempotentne przy kolejnych wywołaniach.
   */
  async runMigrations() {
    if (this.initialized) {
      return;
    }

    const conn = getConnection();

    try {
      await conn.exec('PRAGMA foreign_keys = ON;');
      await this.ensureMigrationsTable(conn);

      const hasInitial = await this.hasMigration(conn, INITIAL_MIGRATION_NAME);
      if (hasInitial) {
        this.initialized = true;
        return;
      }

      if (!fs.existsSync(SCHEMA_FILE)) {
        console.warn('[migration-manager] Brak pliku schema.sql - nie można zastosować initial_schema.');
        this.initialized = true;
        return;
      }

      const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
      if (!schemaSql.trim()) {
        console.warn('[migration-manager] Plik schema.sql jest pusty - pomijam initial_schema.');
        this.initialized = true;
        return;
      }

      await conn.exec(schemaSql);
      await this.insertMigration(conn, INITIAL_MIGRATION_NAME);

      this.initialized = true;
      console.log('[migration-manager] Zastosowano migrację initial_schema z schema.sql.');
    } catch (error) {
      console.error('[migration-manager] Błąd wykonywania migracji:', error);
      throw error;
    }
  }
}

module.exports = new MigrationManager();