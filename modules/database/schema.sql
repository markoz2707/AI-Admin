-- Schemat bazy danych dla aplikacji AI-Admin (SQLite)
-- Idempotentny: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- Wszystkie nazwy w snake_case, klucze główne jako INTEGER PRIMARY KEY AUTOINCREMENT

PRAGMA foreign_keys = ON;

-- =====================================================================
-- Tabela: app_users
-- Użytkownicy aplikacji (RBAC)
-- =====================================================================
CREATE TABLE IF NOT EXISTS app_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin', -- 'admin' | 'operator' | 'readonly'
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_users_username ON app_users (username);
CREATE INDEX IF NOT EXISTS idx_app_users_role ON app_users (role);
CREATE INDEX IF NOT EXISTS idx_app_users_active ON app_users (is_active);

-- =====================================================================
-- Tabela: servers
-- Zarządzane serwery
-- =====================================================================
CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    os TEXT NOT NULL DEFAULT 'linux', -- linux, windows
    access_type TEXT NOT NULL DEFAULT 'ssh', -- ssh, rdp, winrm
    environment TEXT, -- prod, stage, dev, etc.
    description TEXT,
    tags TEXT, -- CSV z tagami
    is_favorite INTEGER NOT NULL DEFAULT 0,
    is_enabled INTEGER NOT NULL DEFAULT 1,
    credential_id INTEGER,
    last_check_at DATETIME,
    last_check_status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_servers_host ON servers (host);
CREATE INDEX IF NOT EXISTS idx_servers_enabled ON servers (is_enabled);
CREATE INDEX IF NOT EXISTS idx_servers_environment ON servers (environment);
CREATE INDEX IF NOT EXISTS idx_servers_favorite ON servers (is_favorite);

-- =====================================================================
-- Tabela: credentials
-- Dane uwierzytelniające do serwerów / usług (zaszyfrowane)
-- =====================================================================
CREATE TABLE IF NOT EXISTS credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    name TEXT NOT NULL,
    username TEXT,
    secret_encrypted TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'ssh', -- ssh_password, ssh_key, rdp, inne
    description TEXT,
    tags TEXT,
    last_used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credentials_server_id ON credentials (server_id);
CREATE INDEX IF NOT EXISTS idx_credentials_name ON credentials (name);

-- =====================================================================
-- Tabela: service_snapshots
-- Migawki usług systemowych na serwerach
-- =====================================================================
CREATE TABLE IF NOT EXISTS service_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT,
    extra JSON,
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_service_snapshots_server_time
    ON service_snapshots (server_id, captured_at DESC);

-- =====================================================================
-- Tabela: system_user_snapshots
-- Migawki użytkowników systemowych na serwerach
-- =====================================================================
CREATE TABLE IF NOT EXISTS system_user_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    uid TEXT,
    gid TEXT,
    home TEXT,
    shell TEXT,
    groups TEXT, -- np. CSV/JSON
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_system_user_snapshots_server_time
    ON system_user_snapshots (server_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_user_snapshots_username
    ON system_user_snapshots (username);

-- =====================================================================
-- Tabela: share_snapshots
-- Migawki udziałów/zasobów współdzielonych
-- =====================================================================
CREATE TABLE IF NOT EXISTS share_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    path TEXT,
    permissions TEXT,
    extra JSON,
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_snapshots_server_time
    ON share_snapshots (server_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_snapshots_name
    ON share_snapshots (name);

-- =====================================================================
-- Tabela: sessions
-- Sesje aplikacyjne (RBAC, auth)
-- =====================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    is_valid INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (app_user_id) REFERENCES app_users(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (app_user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_valid_expires
    ON sessions (is_valid, expires_at);

-- =====================================================================
-- Tabela: command_history
-- Historia wykonanych poleceń (z UI/LLM)
-- =====================================================================
CREATE TABLE IF NOT EXISTS command_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    app_user_id INTEGER,
    source TEXT NOT NULL, -- 'ui' | 'llm' | 'system'
    command TEXT NOT NULL,
    result TEXT,
    exit_code INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (app_user_id) REFERENCES app_users(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_command_history_server_time
    ON command_history (server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_command_history_user_time
    ON command_history (app_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_command_history_source_time
    ON command_history (source, created_at DESC);

-- =====================================================================
-- Tabela: llm_tasks
-- Zadania LLM planowane/wykonane na serwerach
-- =====================================================================
CREATE TABLE IF NOT EXISTS llm_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER,
    app_user_id INTEGER,
    prompt TEXT NOT NULL,
    plan TEXT,
    status TEXT NOT NULL DEFAULT 'planned', -- planned/executed/partial_error/error
    auto_execute INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (app_user_id) REFERENCES app_users(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_tasks_server_time
    ON llm_tasks (server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_tasks_user_time
    ON llm_tasks (app_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_tasks_status_time
    ON llm_tasks (status, created_at DESC);

-- =====================================================================
-- Tabela: llm_task_results
-- Wyniki poszczególnych kroków/zadań LLM
-- =====================================================================
CREATE TABLE IF NOT EXISTS llm_task_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    llm_task_id INTEGER NOT NULL,
    step_index INTEGER,
    task_type TEXT,
    description TEXT,
    command TEXT,
    status TEXT NOT NULL, -- success/error
    result TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (llm_task_id) REFERENCES llm_tasks(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_llm_task_results_task_id
    ON llm_task_results (llm_task_id);
CREATE INDEX IF NOT EXISTS idx_llm_task_results_status
    ON llm_task_results (status);

-- =====================================================================
-- Tabela: settings
-- Klucz-wartość z zakresem (global/app_user/server)
-- =====================================================================
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL, -- 'global' | 'user' | 'server' | inne
    key TEXT NOT NULL,
    value TEXT NOT NULL, -- JSON string
    app_user_id INTEGER,
    server_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (app_user_id) REFERENCES app_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE ON UPDATE CASCADE
);


CREATE INDEX IF NOT EXISTS idx_settings_scope_key
    ON settings (scope, key);
CREATE INDEX IF NOT EXISTS idx_settings_user
    ON settings (app_user_id);
CREATE INDEX IF NOT EXISTS idx_settings_server
    ON settings (server_id);

-- =====================================================================
-- Tabela: audit_log
-- Log audytowy operacji (RBAC, operacje na zasobach)
-- =====================================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    actor_user_id INTEGER,
    session_id INTEGER,
    source TEXT, -- 'ui' | 'llm' | 'system' | inne
    success INTEGER NOT NULL DEFAULT 1,
    details TEXT, -- JSON string (bez wrażliwych danych)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (actor_user_id) REFERENCES app_users(id) ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
    ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
    ON audit_log (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_type
    ON audit_log (action_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target
    ON audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_source
    ON audit_log (source, created_at DESC);

-- =====================================================================
-- Tabela: schema_migrations
-- Używana przez MigrationManager (tworzona także defensywnie w kodzie)
-- =====================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_name
    ON schema_migrations (name);

-- =====================================================================
-- Tabela: execution_journal
-- Trwały journal wykonania planów (idempotencja + odzyskiwanie po awarii).
-- Tworzona także defensywnie w kodzie (ExecutionJournal.ensureReady).
-- =====================================================================
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
    status TEXT NOT NULL DEFAULT 'pending', -- pending/executing/done/error/skipped/needs_verification/verify_failed/compensated
    attempt INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (plan_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_exec_journal_status
    ON execution_journal (status);