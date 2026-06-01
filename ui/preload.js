const { contextBridge, ipcRenderer } = require('electron');

// Minimalny, spójny bridge dla całej aplikacji.
// Wszystko idzie przez window.api.invoke(channel, payload), plus pomocnicze namespace'y.

// Session token storage
let currentSessionToken = null;

const api = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),

  // Session token management
  setSessionToken: (token) => {
    currentSessionToken = token;
  },
  getSessionToken: () => currentSessionToken,
  clearSessionToken: () => {
    currentSessionToken = null;
  },

  servers: {
    list: (payload = {}) => ipcRenderer.invoke('servers:list', { ...payload, sessionToken: currentSessionToken }),
    get: (id) => ipcRenderer.invoke('servers:get', { id, sessionToken: currentSessionToken }),
    create: (data) => ipcRenderer.invoke('servers:create', { data, sessionToken: currentSessionToken }),
    update: (id, data) => ipcRenderer.invoke('servers:update', { id, data, sessionToken: currentSessionToken }),
    delete: (id) => ipcRenderer.invoke('servers:delete', { id, sessionToken: currentSessionToken }),
    connect: (id) => ipcRenderer.invoke('servers:connect', { id, sessionToken: currentSessionToken }),
    disconnect: (id) => ipcRenderer.invoke('servers:disconnect', { id, sessionToken: currentSessionToken }),
    status: (id) => ipcRenderer.invoke('servers:status', { id, sessionToken: currentSessionToken }),
  },

  services: {
    list: (serverId) => ipcRenderer.invoke('services:list', { serverId, sessionToken: currentSessionToken }),
    action: (serverId, serviceName, action) =>
      ipcRenderer.invoke('services:action', { serverId, serviceName, action, sessionToken: currentSessionToken }),
  },

  sysusers: {
    list: (serverId) => ipcRenderer.invoke('sysusers:list', { serverId, sessionToken: currentSessionToken }),
    add: (serverId, user) => ipcRenderer.invoke('sysusers:add', { serverId, user, sessionToken: currentSessionToken }),
    remove: (serverId, username) =>
      ipcRenderer.invoke('sysusers:remove', { serverId, username, sessionToken: currentSessionToken }),
    changePassword: (serverId, username, password) =>
      ipcRenderer.invoke('sysusers:changePassword', { serverId, username, password, sessionToken: currentSessionToken }),
    addToGroup: (serverId, username, group) =>
      ipcRenderer.invoke('sysusers:addToGroup', { serverId, username, group, sessionToken: currentSessionToken }),
    removeFromGroup: (serverId, username, group) =>
      ipcRenderer.invoke('sysusers:removeFromGroup', { serverId, username, group, sessionToken: currentSessionToken }),
  },

  shares: {
    list: (serverId) =>
      ipcRenderer.invoke('shares:list', { sessionToken: currentSessionToken, serverId }),
    create: (serverId, share) =>
      ipcRenderer.invoke('shares:create', { sessionToken: currentSessionToken, serverId, share }),
    delete: (serverId, name) =>
      ipcRenderer.invoke('shares:delete', { sessionToken: currentSessionToken, serverId, name }),
    modifyPermissions: (serverId, name, permissions) =>
      ipcRenderer.invoke('shares:modifyPermissions', {
        sessionToken: currentSessionToken,
        serverId,
        name,
        permissions,
      }),
  },

  console: {
    execute: (serverId, command) =>
      ipcRenderer.invoke('console:execute', {
        sessionToken: currentSessionToken,
        serverId,
        command,
      }),
  },

  credentials: {
    list: () => ipcRenderer.invoke('credentials:list', { sessionToken: currentSessionToken }),
    get: (id) => ipcRenderer.invoke('credentials:get', { id, sessionToken: currentSessionToken }),
    create: (data) => ipcRenderer.invoke('credentials:create', { data, sessionToken: currentSessionToken }),
    update: (id, data) => ipcRenderer.invoke('credentials:update', { id, data, sessionToken: currentSessionToken }),
    delete: (id) => ipcRenderer.invoke('credentials:delete', { id, sessionToken: currentSessionToken }),
    generatePassword: (options) =>
      ipcRenderer.invoke('credentials:generatePassword', { options, sessionToken: currentSessionToken }),
  },

  llm: {
    ask: ({ prompt, serverId, includeContext, autoExecute, approveHighRisk, dryRun }) =>
      ipcRenderer.invoke('llm:ask', {
        prompt,
        serverId,
        includeContext,
        autoExecute,
        approveHighRisk,
        dryRun,
        sessionToken: currentSessionToken,
      }),
    history: (limit) =>
      ipcRenderer.invoke('llm:history', { sessionToken: currentSessionToken, limit }),
    report: (taskId) =>
      ipcRenderer.invoke('llm:report', { sessionToken: currentSessionToken, taskId }),
  },

  appUsers: {
    list: () =>
      ipcRenderer.invoke('appUsers:list', { sessionToken: currentSessionToken }),
    create: (user) =>
      ipcRenderer.invoke('appUsers:create', { sessionToken: currentSessionToken, user }),
    update: (id, data) =>
      ipcRenderer.invoke('appUsers:update', { sessionToken: currentSessionToken, id, data }),
    delete: (id) =>
      ipcRenderer.invoke('appUsers:delete', { sessionToken: currentSessionToken, id }),
  },

  auth: {
    login: (username, password) =>
      ipcRenderer.invoke('auth:login', { username, password }),
    logout: () =>
      ipcRenderer.invoke('auth:logout', { sessionToken: currentSessionToken }),
    getCurrentUser: () =>
      ipcRenderer.invoke('auth:getCurrentUser', { sessionToken: currentSessionToken }),
    setSessionToken: (token) => {
      currentSessionToken = token;
    },
  },

  settings: {
    get: (prefix) =>
      ipcRenderer.invoke('settings:get', { sessionToken: currentSessionToken, prefix }),
    update: (updates) =>
      ipcRenderer.invoke('settings:update', { sessionToken: currentSessionToken, updates }),
  },

  audit: {
    list: (filter, pagination) =>
      ipcRenderer.invoke('audit:list', {
        sessionToken: currentSessionToken,
        filter,
        pagination,
      }),
    get: (id) =>
      ipcRenderer.invoke('audit:get', { sessionToken: currentSessionToken, id }),
  },

  // Packages & Logs (nowe funkcje cockpitowe ServerConsole)
  packages: {
    list: (serverId, options) =>
      ipcRenderer.invoke('packages:list', {
        sessionToken: currentSessionToken,
        serverId,
        options,
      }),
    install: (serverId, name, version, options) =>
      ipcRenderer.invoke('packages:install', {
        sessionToken: currentSessionToken,
        serverId,
        name,
        version,
        options,
      }),
    update: (serverId, name, options) =>
      ipcRenderer.invoke('packages:update', {
        sessionToken: currentSessionToken,
        serverId,
        name,
        options,
      }),
    remove: (serverId, name, options) =>
      ipcRenderer.invoke('packages:remove', {
        sessionToken: currentSessionToken,
        serverId,
        name,
        options,
      }),
  },

  logs: {
    tail: (serverId, options) =>
      ipcRenderer.invoke('logs:tail', {
        sessionToken: currentSessionToken,
        serverId,
        options,
      }),
    fetch: (serverId, options) =>
      ipcRenderer.invoke('logs:fetch', {
        sessionToken: currentSessionToken,
        serverId,
        options,
      }),
  },
};

contextBridge.exposeInMainWorld('api', api);