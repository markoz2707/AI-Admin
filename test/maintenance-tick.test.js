const { test } = require('node:test');
const assert = require('node:assert');
const { createMaintenanceTick } = require('../modules/agent/maintenance-tick');

test('poison-guard: pomija serwer z zatrutą percepcją (nie buduje planu)', async () => {
  const built = [];
  const tick = createMaintenanceTick({
    listServers: async () => [{ id: 1 }, { id: 2 }],
    collect: async (s) =>
      s.id === 2 ? { perceptionWarnings: [{ path: 'osDetails.hostname', reasons: ['x'] }] } : {},
    goalProvider: async (s) => `cel dla ${s.id}`,
    buildPlan: async (goal, id) => { built.push(id); return { planId: 'p', planHash: 'h' }; },
    executeAutonomously: async () => {},
    autoExecute: false,
  });
  const summary = await tick();
  assert.strictEqual(summary.perceived, 2);
  assert.strictEqual(summary.poisoned, 1);
  assert.deepStrictEqual(built, [1]); // tylko czysty serwer
});

test('dryf -> plan -> wykonanie autonomiczne (autoExecute)', async () => {
  const executed = [];
  const tick = createMaintenanceTick({
    listServers: async () => [{ id: 1 }],
    collect: async () => ({}),
    goalProvider: async () => 'zainstaluj nginx',
    buildPlan: async () => ({ planId: 'p1', planHash: 'h1' }),
    executeAutonomously: async (id, planId) => { executed.push(planId); return { status: 'executed' }; },
    autoExecute: true,
  });
  const s = await tick();
  assert.strictEqual(s.proposed, 1);
  assert.strictEqual(s.executed, 1);
  assert.deepStrictEqual(executed, ['p1']);
});

test('bez goalProvider tick tylko percypuje', async () => {
  const tick = createMaintenanceTick({
    listServers: async () => [{ id: 1 }, { id: 2 }],
    collect: async () => ({}),
    buildPlan: async () => { throw new Error('nie powinno być wołane'); },
    executeAutonomously: async () => {},
  });
  const s = await tick();
  assert.strictEqual(s.perceived, 2);
  assert.strictEqual(s.proposed, 0);
});

test('błąd percepcji jednego serwera nie przerywa cyklu', async () => {
  const tick = createMaintenanceTick({
    listServers: async () => [{ id: 1 }, { id: 2 }],
    collect: async (s) => { if (s.id === 1) throw new Error('down'); return {}; },
    buildPlan: async () => ({}),
    executeAutonomously: async () => {},
  });
  const s = await tick();
  assert.strictEqual(s.errors, 1);
  assert.strictEqual(s.perceived, 1);
});
