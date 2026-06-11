/**
 * Minimalna warstwa RBAC zgodna z modelem:
 * - admin: pełen dostęp
 * - operator: operacje na serwerach/LLM, bez globalnej administracji AppUser/ustawień
 * - readonly: wyłącznie odczyt, brak mutacji, autoExecute zablokowane
 *
 * Używana przez ui/electron-main.js (checkPermission / getSessionContext).
 */

const ROLES = {
  ADMIN: 'admin',
  OPERATOR: 'operator',
  READONLY: 'readonly',
};

/**
 * Mapowanie kanałów/akcji na wymagane uprawnienia.
 * Kluczowe zasady:
 * - wszystko co zmienia stan wymaga >= operator (część z nich tylko admin)
 * - odczyty dostępne dla readonly, chyba że dotyczą wrażliwych danych (np. credentials pełne)
 */

const PERMISSIONS = {
  // Serwery
  'servers:list': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'servers:get': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'servers:status': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'servers:create': [ROLES.ADMIN, ROLES.OPERATOR],
  'servers:update': [ROLES.ADMIN, ROLES.OPERATOR],
  'servers:delete': [ROLES.ADMIN],
  'servers:connect': [ROLES.ADMIN, ROLES.OPERATOR],
  'servers:disconnect': [ROLES.ADMIN, ROLES.OPERATOR],

  // Usługi
  'services:list': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'services:action': [ROLES.ADMIN, ROLES.OPERATOR],

  // Użytkownicy systemowi
  'sysusers:list': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'sysusers:add': [ROLES.ADMIN, ROLES.OPERATOR],
  'sysusers:remove': [ROLES.ADMIN, ROLES.OPERATOR],
  'sysusers:changePassword': [ROLES.ADMIN, ROLES.OPERATOR],
  'sysusers:addToGroup': [ROLES.ADMIN, ROLES.OPERATOR],
  'sysusers:removeFromGroup': [ROLES.ADMIN, ROLES.OPERATOR],

  // Udziały
  'shares:list': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'shares:create': [ROLES.ADMIN, ROLES.OPERATOR],
  'shares:delete': [ROLES.ADMIN, ROLES.OPERATOR],
  'shares:modifyPermissions': [ROLES.ADMIN, ROLES.OPERATOR],

  // Console / command history
  'console:execute': [ROLES.ADMIN, ROLES.OPERATOR], // readonly nie może wykonywać
  'history:commands:list': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],

  // Środowisko: wykrywanie OS i inwentaryzacja (read-only)
  'env:detectOS': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'env:collect': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],

  // Credentials
  'credentials:list': [ROLES.ADMIN, ROLES.OPERATOR],
  'credentials:get': [ROLES.ADMIN, ROLES.OPERATOR],
  'credentials:create': [ROLES.ADMIN],
  'credentials:update': [ROLES.ADMIN],
  'credentials:delete': [ROLES.ADMIN],
  'credentials:generatePassword': [ROLES.ADMIN, ROLES.OPERATOR],

  // LLM
  'llm:ask': [ROLES.ADMIN, ROLES.OPERATOR], // autoExecute ograniczymy dodatkowo w logice
  'llm:executePlan': [ROLES.ADMIN, ROLES.OPERATOR], // zatwierdzanie kroków high tylko admin (w logice)
  'llm:scheduleDeferred': [ROLES.ADMIN, ROLES.OPERATOR],
  'llm:vetoDeferred': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY], // weto (zatrzymanie) bezpieczne dla każdego
  'llm:listDeferred': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'llm:history': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'llm:report': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],

  // AppUsers zarządzanie
  'appUsers:list': [ROLES.ADMIN],
  'appUsers:create': [ROLES.ADMIN],
  'appUsers:update': [ROLES.ADMIN],
  'appUsers:delete': [ROLES.ADMIN],

  // Auth (spec-case: login/public)
  'auth:login': [], // publiczny; walidacja po stronie IPC
  'auth:logout': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'auth:getCurrentUser': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],

  // Settings
  'settings:get': [ROLES.ADMIN, ROLES.OPERATOR, ROLES.READONLY],
  'settings:update': [ROLES.ADMIN], // globalne zmiany tylko admin

  // Audit
  'audit:list': [ROLES.ADMIN],
  'audit:get': [ROLES.ADMIN],
};

function isAllowed(role, channel) {
  if (!role) return false;
  const allowed = PERMISSIONS[channel];
  if (!allowed) {
    // Domyślnie: kanały nieopisane dostępne tylko dla admina
    return role === ROLES.ADMIN;
  }
  if (allowed.length === 0) {
    // Pusta lista oznacza brak wymagań (np. login)
    return true;
  }
  return allowed.includes(role);
}

/**
 * Sprawdza uprawnienie; rzuca błąd jeśli brak dostępu.
 */
function checkPermission(context, channel) {
  if (!context || !context.user) {
    const err = new Error('Brak kontekstu sesji lub użytkownika');
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  const role = context.user.role;
  if (!isAllowed(role, channel)) {
    const err = new Error('Brak uprawnień do wykonania operacji');
    err.code = 'FORBIDDEN';
    throw err;
  }
}

module.exports = {
  ROLES,
  PERMISSIONS,
  isAllowed,
  checkPermission,
};