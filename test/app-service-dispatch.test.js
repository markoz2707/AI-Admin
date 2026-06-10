const { test } = require('node:test');
const assert = require('node:assert');
const AppService = require('../modules/service/app-service');

// Buduje AppService z podmienionymi repo/managerami (bez DB/sieci).
function setup() {
  const svc = new AppService();
  svc.sessionRepo = {
    async getSessionByToken(t) {
      return t === 'good' ? { id: 1, is_valid: 1, app_user_id: 7, expires_at: null } : null;
    },
    async touchSession() {},
    async createSession() { return { token: 'newtoken' }; },
    async invalidateByToken() {},
    async invalidateSession() {},
  };
  svc.appUserRepo = {
    async getById() { return { id: 7, username: 'ro', role: 'readonly', is_active: 1 }; },
    async verifyPassword(u, p) {
      return p === 'right' ? { id: 7, username: 'ro', role: 'readonly' } : null;
    },
  };
  svc.serverManager = {
    async getServer(id) { return { id, name: 'srv', os: 'linux' }; },
    isServerConnected: () => false,
    async listServers() { return [{ id: 1 }]; },
  };
  return svc;
}

test('kanał publiczny auth:login działa bez tokenu', async () => {
  const svc = setup();
  const r = await svc.dispatch('auth:login', { username: 'ro', password: 'right' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.sessionToken, 'newtoken');
});

test('auth:login odrzuca błędne hasło', async () => {
  const svc = setup();
  const r = await svc.dispatch('auth:login', { username: 'ro', password: 'złe' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'UNAUTHORIZED');
});

test('kanał chroniony bez tokenu -> UNAUTHORIZED', async () => {
  const svc = setup();
  const r = await svc.dispatch('servers:get', { id: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'UNAUTHORIZED');
});

test('RBAC: readonly nie może llm:executePlan -> FORBIDDEN', async () => {
  const svc = setup();
  const r = await svc.dispatch('llm:executePlan', { sessionToken: 'good', serverId: 1, planId: 'p' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'FORBIDDEN');
});

test('autoryzowany, ale brak handlera -> UNKNOWN_CHANNEL', async () => {
  const svc = setup();
  // services:list dozwolone dla readonly, ale nie ma handlera w rdzeniu.
  const r = await svc.dispatch('services:list', { sessionToken: 'good', serverId: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'UNKNOWN_CHANNEL');
});

test('servers:get dla zalogowanego zwraca dane', async () => {
  const svc = setup();
  const r = await svc.dispatch('servers:get', { sessionToken: 'good', id: 5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.id, 5);
});
