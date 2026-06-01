const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const isDev = process.env.NODE_ENV === 'development';

// Backend modules
const {
  ServerManager,
  ServiceManager,
  UserManager,
  ShareManager,
  PackageManager,
  LogsManager,
} = require('../modules/management');
const passwordManager = require('../modules/password-manager/password-manager');
const LLMManager = require('../modules/llm/llm-manager');
const migrationManager = require('../modules/database/migration-manager');
const { encrypt, decrypt } = require('../modules/database/encryption-manager');
const Logger = require('../modules/access/logger');
const { ROLES, checkPermission } = require('../modules/access/rbac');
const AppUserRepository = require('../modules/auth/app-user-repo');
const SessionRepository = require('../modules/session/session-repo');
const SettingsRepository = require('../modules/settings/settings-repo');
const AuditLogRepository = require('../modules/audit/audit-log-repo');
const CommandHistoryRepository = require('../modules/history/command-history-repo');

const logger = new Logger('ui-ipc.log');

let mainWindow;
// globalne instancje
const serverManager = new ServerManager();
const serviceManager = new ServiceManager(serverManager.accessManager, logger);
const userManager = new UserManager(serverManager.accessManager, logger);
const shareManager = new ShareManager(serverManager.accessManager, logger);
const packageManager = PackageManager
  ? new PackageManager(serverManager, logger)
  : null;
const logsManager = LogsManager
  ? new LogsManager(serverManager, logger)
  : null;
let llmManager; // Zmienione na let, inicjalizacja w whenReady
const appUserRepo = AppUserRepository;
const sessionRepo = SessionRepository;
const settingsRepo = SettingsRepository;
const auditLogRepo = AuditLogRepository;
const commandHistoryRepo = CommandHistoryRepository;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
  });

  // Content-Security-Policy. W produkcji restrykcyjna; w dev poluzowana,
  // bo CRA hot-reload wymaga 'unsafe-eval' i połączeń websocket.
  const csp = isDev
    ? "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:3000 ws://localhost:3000; img-src 'self' data:;"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self';";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });

  const startUrl = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../build/index.html')}`;

  // Hardening: blokuj otwieranie nowych okien i nawigację poza aplikację.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Linki zewnętrzne otwieraj w domyślnej przeglądarce systemowej.
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });

  mainWindow.loadURL(startUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Czyta z ustawień konfigurację routingu LLM (wewnętrzny vs zewnętrzny).
 * Klucze (scope 'global'):
 *  - llm.provider           : 'auto' | 'openai' | 'local' | 'anonymize'  (polityka)
 *  - llm.model              : model zewnętrzny (np. 'gpt-4o-mini')
 *  - llm.allowAnonymization : bool (czy wolno anonimizować i wysyłać na zewnątrz)
 *  - llm.local.enabled      : bool
 *  - llm.local.baseUrl      : np. 'http://localhost:11434'
 *  - llm.local.model        : np. 'llama3.1'
 * @returns {Promise<Object>} fragment configu dla LLMManager
 */
async function loadLLMRoutingConfig() {
  const get = async (key, dflt) => {
    try {
      const v = await settingsRepo.get('global', key);
      return v === null || v === undefined ? dflt : v;
    } catch {
      return dflt;
    }
  };

  const provider = await get('llm.provider', 'auto');
  // Zmapuj wartości UI na polityki routera (puste/openai -> auto, by nie blokować).
  const policy =
    provider === 'local' || provider === 'anonymize' || provider === 'openai'
      ? provider
      : 'auto';

  return {
    policy,
    externalModel: (await get('llm.model', '')) || undefined,
    allowAnonymization: (await get('llm.allowAnonymization', true)) !== false,
    local: {
      enabled: (await get('llm.local.enabled', false)) === true,
      baseUrl: (await get('llm.local.baseUrl', '')) || undefined,
      model: (await get('llm.local.model', '')) || undefined,
    },
  };
}

// Start: okno + migracje DB + inicjalizacja managerów
app.whenReady().then(async () => {
  try {
    await migrationManager.runMigrations();
    logger.info('Migrations executed successfully');

    // Wczytaj i zdeszyfruj klucz API dla LLM
    const apiKeySetting = await settingsRepo.get('global', 'llm.apiKey');
    // settingsRepo.get() returns the value directly, not an object
    const apiKey = apiKeySetting ? decrypt(apiKeySetting) : null;
    if (!apiKey) {
      logger.warn('OpenAI API Key is not set in settings.');
    }

    // Konfiguracja routingu LLM (wewnętrzny vs zewnętrzny + anonimizacja).
    const llmRoutingConfig = await loadLLMRoutingConfig();

    // Zainicjalizuj LLMManager z kluczem API i konfiguracją routingu.
    llmManager = new LLMManager({
      logger,
      serverManager,
      apiKey,
      ...llmRoutingConfig,
    });
  } catch (error) {
    logger.error('Failed to run migrations or initialize managers', error);
    // Zainicjalizuj LLMManager bez klucza, jeśli wystąpi błąd
    llmManager = new LLMManager({ logger, serverManager });
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Helper: uniwersalna obsługa błędów dla handlerów
function formatError(error, code = 'INTERNAL_ERROR') {
  return {
    error: {
      message: error && error.message ? error.message : String(error),
      code,
    },
  };
}

// Kontekst sesji na podstawie sessionToken
async function getSessionContextFromToken(sessionToken) {
  if (!sessionToken) {
    const err = new Error('Brak tokenu sesji');
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  const session = await sessionRepo.getSessionByToken(sessionToken);
  if (!session || !session.is_valid) {
    const err = new Error('Sesja nieważna lub nie istnieje');
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  // Sprawdź wygaśnięcie
  if (session.expires_at) {
    const now = new Date();
    const exp = new Date(session.expires_at);
    if (isFinite(exp.getTime()) && exp < now) {
      await sessionRepo.invalidateSession(session.id);
      const err = new Error('Sesja wygasła');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
  }

  const user = await appUserRepo.getById(session.app_user_id);
  if (!user || !user.is_active) {
    const err = new Error('Użytkownik sesji nieaktywny lub nie istnieje');
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  await sessionRepo.touchSession(session.id);

  return {
    session,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
    },
  };
}

// Fallback: single-admin mode jeżeli brak użytkowników w DB.
async function getContextOrBootstrap(payload) {
  const { sessionToken } = payload || {};
  try {
    return await getSessionContextFromToken(sessionToken);
  } catch (err) {
    // Jeśli brak sesji/użytkownika - sprawdź, czy istnieją jakiekolwiek konta.
    try {
      const initial = await appUserRepo.createInitialAdminIfEmpty();
      if (initial) {
        // Zwróć pseudo-kontekst dla świeżo utworzonego admina (bez sesji HTTP, tylko do bootstrapu)
        return {
          session: null,
          user: {
            id: initial.id,
            username: initial.username,
            role: 'admin',
          },
        };
      }
    } catch (bootstrapErr) {
      logger.error('Błąd createInitialAdminIfEmpty', bootstrapErr);
    }
    throw err;
  }
}

function wrapHandler(name, fn, options = {}) {
  const { authRequired = true } = options;

  return async (event, payload) => {
    const safePayload = payload || {};
    try {
      let context = null;
      if (authRequired) {
        context = await getContextOrBootstrap(safePayload);
        checkPermission(context, name);
      }
      const result = await fn(safePayload, event, context);
      return result;
    } catch (error) {
      logger.error(`IPC handler failed: ${name}`, error, { payload: safePayload });
      return formatError(error, error.code || 'IPC_HANDLER_ERROR');
    }
  };
}

// SERVERS: list/get/create/update/delete/connect/disconnect/status
ipcMain.handle(
  'servers:list',
  wrapHandler(
    'servers:list',
    async (payload, _event, context) => {
      const servers = await serverManager.listServers(payload.filter || {});
      // Dodaj status połączenia do każdego serwera
      return servers.map(server => ({
        ...server,
        isConnected: serverManager.isServerConnected(server.id),
        status: serverManager.isServerConnected(server.id) ? 'online' : (server.lastCheckStatus || 'offline'),
      }));
    }
  )
);

ipcMain.handle(
  'servers:get',
  wrapHandler('servers:get', async ({ id }) => {
    const server = await serverManager.getServer(id);
    if (server) {
      server.isConnected = serverManager.isServerConnected(id);
      server.status = server.isConnected ? 'online' : (server.lastCheckStatus || 'offline');
    }
    return server;
  })
);

ipcMain.handle(
  'servers:create',
  wrapHandler('servers:create', async ({ data }, _event, context) => {
    const created = await serverManager.createServer(data);
    await logger.logAuditLike({
      actionType: 'SERVER_CREATE',
      targetType: 'server',
      targetId: created.id,
      actorUserId: context.user.id,
      source: 'ui',
      success: true,
      details: { name: created.name },
    });
    return created;
  })
);

ipcMain.handle(
  'servers:update',
  wrapHandler('servers:update', async ({ id, data }, _event, context) => {
    const updated = await serverManager.updateServer(id, data);
    await logger.logAuditLike({
      actionType: 'SERVER_UPDATE',
      targetType: 'server',
      targetId: id,
      actorUserId: context.user.id,
      source: 'ui',
      success: true,
      details: { fields: Object.keys(data || {}) },
    });
    return updated;
  })
);

ipcMain.handle(
  'servers:delete',
  wrapHandler('servers:delete', async ({ id }, _event, context) => {
    await serverManager.deleteServer(id);
    await logger.logAuditLike({
      actionType: 'SERVER_DELETE',
      targetType: 'server',
      targetId: id,
      actorUserId: context.user.id,
      source: 'ui',
      success: true,
    });
    return { success: true };
  })
);

ipcMain.handle(
  'servers:connect',
  wrapHandler('servers:connect', async ({ id }, _event, context) => {
    const res = await serverManager.connectToServer(id);
    await logger.logAuditLike({
      actionType: 'SERVER_CONNECT',
      targetType: 'server',
      targetId: id,
      actorUserId: context.user.id,
      source: 'ui',
      success: true,
    });
    return res;
  })
);

ipcMain.handle(
  'servers:disconnect',
  wrapHandler('servers:disconnect', async ({ id }, _event, context) => {
    const res = await serverManager.disconnectFromServer(id);
    await logger.logAuditLike({
      actionType: 'SERVER_DISCONNECT',
      targetType: 'server',
      targetId: id,
      actorUserId: context.user.id,
      source: 'ui',
      success: true,
    });
    return res;
  })
);

ipcMain.handle(
  'servers:status',
  wrapHandler('servers:status', async ({ id }) => {
    const server = await serverManager.getServer(id);
    if (server) {
      server.isConnected = serverManager.isServerConnected(id);
      server.status = server.isConnected ? 'online' : (server.lastCheckStatus || 'offline');
    }
    return server;
  })
);

// SERVICES: list/action
ipcMain.handle(
  'services:list',
  wrapHandler('services:list', async ({ serverId }) => {
    return serviceManager.listServices(serverId);
  })
);

ipcMain.handle(
  'services:action',
  wrapHandler(
    'services:action',
    async ({ serverId, serviceName, action }, _event, context) => {
      const result = await serviceManager.performAction(
        serverId,
        serviceName,
        action
      );
      await logger.logAuditLike({
        actionType: 'SERVICE_ACTION',
        targetType: 'service',
        targetId: serviceName,
        actorUserId: context.user.id,
        source: 'ui',
        success: true,
        details: { serverId, action },
      });
      return result;
    }
  )
);

// SYSUSERS: list/add/remove/changePassword/addToGroup/removeFromGroup
ipcMain.handle(
  'sysusers:list',
  wrapHandler('sysusers:list', async ({ serverId }) => {
    return userManager.listUsers(serverId);
  })
);

ipcMain.handle(
  'sysusers:add',
  wrapHandler('sysusers:add', async ({ serverId, user }) => {
    const result = await userManager.addUser(serverId, user);
    logger.logAction('SYSUSER_ADD', { serverId, username: user.username });
    return result;
  })
);

ipcMain.handle(
  'sysusers:remove',
  wrapHandler('sysusers:remove', async ({ serverId, username }) => {
    const result = await userManager.removeUser(serverId, username);
    logger.logAction('SYSUSER_REMOVE', { serverId, username });
    return result;
  })
);

ipcMain.handle(
  'sysusers:changePassword',
  wrapHandler('sysusers:changePassword', async ({ serverId, username, password }) => {
    const result = await userManager.changePassword(serverId, username, password);
    logger.logAction('SYSUSER_CHANGE_PASSWORD', { serverId, username });
    return result;
  })
);

ipcMain.handle(
  'sysusers:addToGroup',
  wrapHandler('sysusers:addToGroup', async ({ serverId, username, group }) => {
    const result = await userManager.addToGroup(serverId, username, group);
    logger.logAction('SYSUSER_ADD_TO_GROUP', { serverId, username, group });
    return result;
  })
);

ipcMain.handle(
  'sysusers:removeFromGroup',
  wrapHandler('sysusers:removeFromGroup', async ({ serverId, username, group }) => {
    const result = await userManager.removeFromGroup(serverId, username, group);
    logger.logAction('SYSUSER_REMOVE_FROM_GROUP', { serverId, username, group });
    return result;
  })
);

// SHARES: list/create/delete/modifyPermissions
ipcMain.handle(
  'shares:list',
  wrapHandler('shares:list', async ({ serverId }) => {
    return shareManager.listShares(serverId);
  })
);

ipcMain.handle(
  'shares:create',
  wrapHandler('shares:create', async ({ serverId, share }) => {
    const result = await shareManager.createShare(serverId, share);
    logger.logAction('SHARE_CREATE', { serverId, name: share.name });
    return result;
  })
);

ipcMain.handle(
  'shares:delete',
  wrapHandler('shares:delete', async ({ serverId, name }) => {
    const result = await shareManager.deleteShare(serverId, name);
    logger.logAction('SHARE_DELETE', { serverId, name });
    return result;
  })
);

ipcMain.handle(
  'shares:modifyPermissions',
  wrapHandler('shares:modifyPermissions', async ({ serverId, name, permissions }) => {
    const result = await shareManager.modifyPermissions(serverId, name, permissions);
    logger.logAction('SHARE_MODIFY_PERMISSIONS', { serverId, name });
    return result;
  })
);

// CONSOLE: execute (wrap executeCommand + CommandHistory + AuditLog w ServerManager)
ipcMain.handle(
  'console:execute',
  wrapHandler(
    'console:execute',
    async ({ serverId, command }, _event, context) => {
      return serverManager.executeCommand(serverId, command, {
        actorUserId: context.user.id,
        source: 'ui',
      });
    }
  )
);

// PACKAGES: list/install/update/remove (wymaga PackageManager)
if (packageManager) {
  ipcMain.handle(
    'packages:list',
    wrapHandler(
      'packages:list',
      async ({ serverId, options }, _event, context) => {
        const res = await packageManager.listPackages(serverId, options || {});
        await logger.logAuditLike({
          actionType: 'PACKAGE_LIST',
          targetType: 'server',
          targetId: serverId,
          actorUserId: context.user.id,
          source: 'ui',
          success: true,
          details: { options: options || {} },
        });
        return res;
      }
    )
  );

  ipcMain.handle(
    'packages:install',
    wrapHandler(
      'packages:install',
      async ({ serverId, name, version, options }, _event, context) => {
        const res = await packageManager.installPackage(
          serverId,
          name,
          version,
          options || {}
        );
        await logger.logAuditLike({
          actionType: 'PACKAGE_INSTALL',
          targetType: 'package',
          targetId: name,
          actorUserId: context.user.id,
          source: 'ui',
          success: true,
          details: { serverId, version },
        });
        return res;
      }
    )
  );

  ipcMain.handle(
    'packages:update',
    wrapHandler(
      'packages:update',
      async ({ serverId, name, options }, _event, context) => {
        const res = await packageManager.updatePackage(
          serverId,
          name,
          options || {}
        );
        await logger.logAuditLike({
          actionType: 'PACKAGE_UPDATE',
          targetType: 'package',
          targetId: name,
          actorUserId: context.user.id,
          source: 'ui',
          success: true,
          details: { serverId },
        });
        return res;
      }
    )
  );

  ipcMain.handle(
    'packages:remove',
    wrapHandler(
      'packages:remove',
      async ({ serverId, name, options }, _event, context) => {
        const res = await packageManager.removePackage(
          serverId,
          name,
          options || {}
        );
        await logger.logAuditLike({
          actionType: 'PACKAGE_REMOVE',
          targetType: 'package',
          targetId: name,
          actorUserId: context.user.id,
          source: 'ui',
          success: true,
          details: { serverId },
        });
        return res;
      }
    )
  );
}

// LOGS: tail/fetch (wymaga LogsManager)
if (logsManager) {
  ipcMain.handle(
    'logs:tail',
    wrapHandler(
      'logs:tail',
      async ({ serverId, options }, _event, context) => {
        const res = await logsManager.tailSystemLogs(serverId, options || {});
        await logger.logAuditLike({
          actionType: 'LOGS_VIEW',
          targetType: 'server',
          targetId: serverId,
          actorUserId: context.user.id,
          source: 'ui',
          success: true,
          details: { mode: 'tail', options: options || {} },
        });
        return res;
      }
    )
  );

  ipcMain.handle(
    'logs:fetch',
    wrapHandler(
      'logs:fetch',
      async ({ serverId, options }, _event, context) => {
        const res = await logsManager.fetchLogs(serverId, options || {});
        await logger.logAuditLike({
          actionType: 'LOGS_VIEW',
          targetType: 'server',
          targetId: serverId,
          actorUserId: context.user.id,
          source: 'ui',
          success: true,
          details: { mode: 'fetch', options: options || {} },
        });
        return res;
      }
    )
  );
}

// CREDENTIALS: list/get/create/update/delete/generatePassword
ipcMain.handle(
  'credentials:list',
  wrapHandler('credentials:list', async () => {
    return passwordManager.listCredentials();
  })
);

ipcMain.handle(
  'credentials:get',
  wrapHandler('credentials:get', async ({ id }) => {
    return passwordManager.getCredential(id);
  })
);

ipcMain.handle(
  'credentials:create',
  wrapHandler('credentials:create', async ({ data }) => {
    const created = await passwordManager.createCredential(data);
    logger.logAction('CREDENTIAL_CREATE', { id: created.id });
    return created;
  })
);

ipcMain.handle(
  'credentials:update',
  wrapHandler('credentials:update', async ({ id, data }) => {
    const updated = await passwordManager.updateCredential(id, data);
    logger.logAction('CREDENTIAL_UPDATE', { id });
    return updated;
  })
);

ipcMain.handle(
  'credentials:delete',
  wrapHandler('credentials:delete', async ({ id }) => {
    await passwordManager.deleteCredential(id);
    logger.logAction('CREDENTIAL_DELETE', { id });
    return { success: true };
  })
);

ipcMain.handle(
  'credentials:generatePassword',
  wrapHandler('credentials:generatePassword', async ({ options }) => {
    const password = await passwordManager.generatePassword(options || {});
    return { password };
  })
);

// LLM: ask/history/report - wykorzystuje sesje i RBAC
ipcMain.handle(
  'llm:ask',
  wrapHandler(
    'llm:ask',
    async (
      { prompt, serverId, autoExecute, approveHighRisk, dryRun, sessionToken },
      _event,
      context
    ) => {
      // RBAC: tylko admin może zatwierdzać kroki wysokiego ryzyka.
      const isAdmin = context.user && context.user.role === ROLES.ADMIN;
      const result = await llmManager.processAndExecutePrompt(
        prompt,
        serverId,
        {
          autoExecute: !!autoExecute,
          approveHighRisk: !!approveHighRisk && isAdmin,
          dryRun: !!dryRun,
          appUserId: context.user ? context.user.id : null,
        }
      );
      logger.logAction('LLM_ASK', {
        serverId,
        autoExecute: !!autoExecute,
        approveHighRisk: !!approveHighRisk && isAdmin,
        dryRun: !!dryRun,
        actorUserId: context.user ? context.user.id : null,
      });
      return result;
    }
  )
);

ipcMain.handle(
  'llm:history',
  wrapHandler('llm:history', async ({ limit }, _event, context) => {
    if (typeof llmManager.getHistory === 'function') {
      return llmManager.getHistory(context.user, limit || 20);
    }
    return [];
  })
);

ipcMain.handle(
  'llm:report',
  wrapHandler('llm:report', async ({ taskId }, _event, context) => {
    if (typeof llmManager.getReport === 'function') {
      return llmManager.getReport(taskId, context.user);
    }
    return formatError(
      new Error('LLM report not implemented'),
      'NOT_IMPLEMENTED'
    );
  })
);

// AppUsers: oparte o DB
ipcMain.handle(
  'appUsers:list',
  wrapHandler('appUsers:list', async () => {
    // Prosty listing użytkowników bez haseł
    const rows = await auditLogRepo.conn.all(
      'SELECT id, username, role, is_active, created_at, updated_at FROM app_users ORDER BY id ASC'
    );
    return rows;
  })
);
// create/update/delete można w kolejnych iteracjach rozwinąć wg architektury

// AUTH: login/logout/getCurrentUser z użyciem DB i Sessions
ipcMain.handle(
  'auth:login',
  wrapHandler(
    'auth:login',
    async ({ username, password }) => {
      const user = await appUserRepo.verifyPassword(username, password);
      const success = !!user;
      if (!success) {
        await logger.logAuditLike({
          actionType: 'LOGIN_FAILURE',
          targetType: 'app_user',
          targetId: username,
          source: 'ui',
          success: false,
          details: { reason: 'INVALID_CREDENTIALS' },
        });
        const err = new Error('Nieprawidłowe dane logowania');
        err.code = 'UNAUTHORIZED';
        throw err;
      }
      const session = await sessionRepo.createSession(user.id);
      await logger.logAuditLike({
        actionType: 'LOGIN_SUCCESS',
        targetType: 'app_user',
        targetId: user.id,
        actorUserId: user.id,
        source: 'ui',
        success: true,
      });
      return {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
        sessionToken: session.token,
      };
    },
    { authRequired: false }
  )
);

ipcMain.handle(
  'auth:logout',
  wrapHandler(
    'auth:logout',
    async ({ sessionToken }, _event, context) => {
      if (sessionToken) {
        await sessionRepo.invalidateByToken(sessionToken);
      } else if (context && context.session) {
        await sessionRepo.invalidateSession(context.session.id);
      }
      await logger.logAuditLike({
        actionType: 'LOGOUT',
        targetType: 'app_user',
        targetId: context && context.user ? context.user.id : null,
        actorUserId: context && context.user ? context.user.id : null,
        source: 'ui',
        success: true,
      });
      return { success: true };
    }
  )
);

ipcMain.handle(
  'auth:getCurrentUser',
  wrapHandler(
    'auth:getCurrentUser',
    async ({ sessionToken }) => {
      const context = await getContextOrBootstrap({ sessionToken });
      return {
        user: context.user,
      };
    }
  )
);

// SETTINGS: DB-backed
// Helper to filter out sensitive keys from settings object
const filterSensitiveSettings = (settingsObj) => {
  const filtered = {};
  for (const [key, value] of Object.entries(settingsObj || {})) {
    if (key !== 'llm.apiKey') {
      filtered[key] = value;
    }
  }
  return filtered;
};

ipcMain.handle(
  'settings:get',
  wrapHandler('settings:get', async ({ prefix }) => {
    // Zakładamy scope 'global' dla obecnego UI
    // getByPrefix returns an object { key: value }, not an array
    if (!prefix) {
      const settings = await settingsRepo.getByPrefix('global', '', null, null);
      return filterSensitiveSettings(settings);
    }
    const settings = await settingsRepo.getByPrefix('global', prefix, null, null);
    return filterSensitiveSettings(settings);
  })
);

ipcMain.handle(
  'settings:update',
  wrapHandler('settings:update', async ({ updates }, _event, context) => {
    const keys = Object.keys(updates || {});
    let newApiKey = null;
    for (const key of keys) {
      let value = updates[key];
      // Szyfruj klucz API LLM przed zapisem
      if (key === 'llm.apiKey') {
        newApiKey = value; // Zachowaj niezaszyfrowany klucz do aktualizacji LLMManager
        value = encrypt(value);
      }
      await settingsRepo.set('global', key, value, null, null);
    }

    // Aktualizuj LLMManager jeśli zmieniono klucz API
    if (newApiKey && llmManager) {
      llmManager.setApiKey(newApiKey);
      logger.info('LLM API key updated dynamically');
    }

    // Jeśli zmieniono konfigurację routingu LLM — przebuduj pipeline na żywo.
    if (
      llmManager &&
      keys.some(
        (k) => k === 'llm.provider' || k === 'llm.model' || k.startsWith('llm.local.') || k === 'llm.allowAnonymization'
      )
    ) {
      try {
        llmManager.setLLMConfig(await loadLLMRoutingConfig());
        logger.info('LLM routing config updated dynamically');
      } catch (e) {
        logger.error('Nie udało się zaktualizować konfiguracji routingu LLM', e);
      }
    }

    await logger.logAuditLike({
      actionType: 'SETTINGS_UPDATE',
      targetType: 'settings',
      targetId: 'global',
      actorUserId: context.user.id,
      source: 'ui',
      success: true,
      details: { keys },
    });
    // Zwróć zaktualizowane ustawienia (bez klucza API)
    const currentSettings = await settingsRepo.getByPrefix('global', '', null, null);
    return filterSensitiveSettings(currentSettings);
  })
);

// AUDIT: z bazy danych
ipcMain.handle(
  'audit:list',
  wrapHandler('audit:list', async ({ filter, pagination }, _event, context) => {
    return auditLogRepo.list(filter || {}, pagination || {});
  })
);

ipcMain.handle(
  'audit:get',
  wrapHandler('audit:get', async ({ id }) => {
    const item = await auditLogRepo.get(id);
    if (!item) {
      const err = new Error('Audit entry not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return item;
  })
);