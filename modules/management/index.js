const ServerManager = require('./server-manager');
const ServiceManager = require('./service-manager');
const UserManager = require('./user-manager');
const ShareManager = require('./share-manager');

// Opcjonalne rozszerzenia funkcjonalne, jeśli zostaną zaimplementowane:
let PackageManager = null;
let LogsManager = null;

try {
  // modules/management/package-manager.js – zarządzanie pakietami na serwerach
  PackageManager = require('./package-manager');
} catch (e) {
  PackageManager = null;
}

try {
  // modules/management/logs-manager.js – wgląd w logi systemowe na serwerach
  LogsManager = require('./logs-manager');
} catch (e) {
  LogsManager = null;
}

module.exports = {
  ServerManager,
  ServiceManager,
  UserManager,
  ShareManager,
  PackageManager,
  LogsManager,
};