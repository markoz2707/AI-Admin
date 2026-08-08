const { test } = require('node:test');
const assert = require('node:assert');
const LLMManager = require('../modules/llm/llm-manager');
const { computePlanHash } = require('../modules/llm/plan-schema');
const { ExecutionJournal, createMemoryStore } = require('../modules/journal/execution-journal');

// Buduje LLMManager z wstrzykniętym journalem in-memory i fałszywym serverManager.
function setup() {
  const journal = new ExecutionJournal(createMemoryStore());
  const m = new LLMManager({ apiKey: 'x', journal });
  const executed = [];
  m.serverManager = {
    isServerConnected: () => true,
    async connectToServer() {},
    async executeCommand(id, cmd) {
      executed.push(cmd);
      return { stdout: 'ok', stderr: '', code: 0 };
    },
  };
  return { m, journal, executed };
}

function storePlan(m, planId, steps) {
  const planHash = computePlanHash(steps);
  m._planStore.set(planId, {
    planId, serverId: 1, os: 'linux', prompt: 'p', summary: 's',
    steps, planHash, createdAt: new Date().toISOString(),
  });
  return planHash;
}

test('executePlan odrzuca niezgodny planHash (anty-TOCTOU)', async () => {
  const { m } = setup();
  storePlan(m, 'p1', [{ id: 's1', type: 'command', command: 'echo a', os: 'linux' }]);
  await assert.rejects(
    () => m.executePlan(1, 'p1', { planHash: 'zła-wartość' }),
    (e) => e.code === 'PLAN_CHANGED'
  );
});

test('executePlan żurnaluje wykonanie i jest idempotentny przy wznowieniu', async () => {
  const { m, journal, executed } = setup();
  const steps = [{ id: 's1', type: 'command', command: 'echo a', os: 'linux' }];
  const planHash = storePlan(m, 'p1', steps);

  const r1 = await m.executePlan(1, 'p1', { planHash });
  assert.strictEqual(r1.status, 'executed');
  assert.strictEqual(await journal.isStepDone('p1', 's1'), true);
  assert.strictEqual(executed.length, 1);

  // Wznowienie tego samego planu: krok 'done' nie jest wykonywany ponownie.
  storePlan(m, 'p1', steps); // executePlan usuwa plan po wykonaniu — przywróć
  const r2 = await m.executePlan(1, 'p1', { planHash });
  assert.strictEqual(r2.results[0].result.skipped, true);
  assert.strictEqual(executed.length, 1); // bez ponownego wykonania
});

test('executePlan: krok high bez zgody nie wykonuje się (needs_approval)', async () => {
  const { m, executed } = setup();
  const steps = [{ id: 's1', type: 'command', command: 'sudo systemctl restart nginx', os: 'linux' }];
  const planHash = storePlan(m, 'p1', steps);
  const r = await m.executePlan(1, 'p1', { planHash });
  assert.strictEqual(r.results[0].status, 'needs_approval');
  assert.strictEqual(executed.length, 0);
});

test('executePlan: krytyczne polecenie jest zablokowane', async () => {
  const { m, executed } = setup();
  const steps = [{ id: 's1', type: 'command', command: 'rm -rf /', os: 'linux' }];
  const planHash = storePlan(m, 'p1', steps);
  const r = await m.executePlan(1, 'p1', { planHash });
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.strictEqual(executed.length, 0);
});

test('saga: nieudana weryfikacja kroku wycofuje wcześniejszy (kompensacja)', async () => {
  const { m, executed } = setup();
  // verify zwraca kod != 0 (postcondition niespełniony); reszta OK.
  m.serverManager.executeCommand = async (id, cmd) => {
    executed.push(cmd);
    if (cmd.includes('test -f /missing')) return { stdout: '', stderr: 'brak', code: 1 };
    return { stdout: 'ok', stderr: '', code: 0 };
  };
  const steps = [
    { id: 's1', type: 'command', command: 'echo install', os: 'linux', compensation: 'echo rollback1' },
    { id: 's2', type: 'command', command: 'echo configure', os: 'linux', verify: 'test -f /missing' },
  ];
  const planHash = storePlan(m, 'p1', steps);
  // verify s2 ma kod != 0 (plik nie istnieje) -> verify_failed -> saga kompensuje s1
  const r = await m.executePlan(1, 'p1', { planHash, stopOnError: true });
  assert.strictEqual(r.status, 'rolled_back');
  // wykonano: s1, s2, verify s2, kompensacja s1
  assert.ok(executed.includes('echo rollback1'));
  const s1 = r.results.find((x) => x.id === 's1');
  assert.strictEqual(s1.compensated, true);
});

test('read-back: verify OK potwierdza wykonanie przerwanego kroku (-> done)', async () => {
  const { m, journal } = setup(); // fake executeCommand zwraca code 0
  await journal.startRun({
    planId: 'pX', serverId: 1,
    steps: [{ id: 's1', command: 'echo a', verify: 'test -f /ok' }],
  });
  await journal.beginStep('pX', 's1'); // "awaria" w trakcie
  await journal.recover(); // -> needs_verification
  const r = await m.verifyInterruptedSteps();
  assert.strictEqual(r.confirmedDone, 1);
  assert.strictEqual(await journal.isStepDone('pX', 's1'), true);
});

test('read-back: verify != 0 zostawia krok do weryfikacji (bez ponawiania)', async () => {
  const { m, journal, executed } = setup();
  m.serverManager.executeCommand = async (id, cmd) => {
    executed.push(cmd);
    return { stdout: '', stderr: 'nie', code: 1 };
  };
  await journal.startRun({
    planId: 'pY', serverId: 1,
    steps: [{ id: 's1', command: 'echo a', verify: 'test -f /missing' }],
  });
  await journal.beginStep('pY', 's1');
  await journal.recover();
  const r = await m.verifyInterruptedSteps();
  assert.strictEqual(r.confirmedDone, 0);
  assert.strictEqual(r.unresolved, 1);
  assert.strictEqual(await journal.isStepDone('pY', 's1'), false);
  // uruchomiono tylko `verify`, NIE oryginalną operację
  assert.deepStrictEqual(executed, ['test -f /missing']);
});

test('prekondycja: zmiana stanu serwera unieważnia aprobatę (PLAN_STATE_CHANGED)', async () => {
  const { m } = setup();
  const steps = [{ id: 's1', type: 'command', command: 'echo a', os: 'linux' }];
  const planHash = computePlanHash(steps);
  const preconditionHash = await m._computePrecondition(1, { preconditionProvider: async () => 'stateA' });

  const seed = () => m._planStore.set('p1', {
    planId: 'p1', serverId: 1, os: 'linux', prompt: 'p', summary: 's',
    steps, planHash, preconditionHash, createdAt: new Date().toISOString(),
  });

  // Stan niezmieniony -> wykonuje się.
  seed();
  const ok = await m.executePlan(1, 'p1', { planHash, preconditionProvider: async () => 'stateA' });
  assert.strictEqual(ok.status, 'executed');

  // Stan zmieniony -> aprobata wygasa.
  seed();
  await assert.rejects(
    () => m.executePlan(1, 'p1', { planHash, preconditionProvider: async () => 'stateB' }),
    (e) => e.code === 'PLAN_STATE_CHANGED'
  );
});

test('verifyPolicy: retry verify aż przejdzie (bez ślepego ponawiania operacji)', async () => {
  const { m, executed } = setup();
  m._sleep = async () => {}; // brak realnego czekania w teście
  let verifyCalls = 0;
  m.serverManager.executeCommand = async (id, cmd) => {
    executed.push(cmd);
    if (cmd === 'check') { verifyCalls++; return { code: verifyCalls < 3 ? 1 : 0 }; } // OK dopiero za 3. razem
    return { code: 0, stdout: 'ok' };
  };
  const steps = [{ id: 's1', type: 'command', command: 'do-it', os: 'linux', verify: 'check', verifyPolicy: { attempts: 5, delayMs: 1 } }];
  const planHash = computePlanHash(steps);
  m._planStore.set('p1', { planId: 'p1', serverId: 1, os: 'linux', prompt: 'p', summary: 's', steps, planHash, createdAt: new Date().toISOString() });
  const r = await m.executePlan(1, 'p1', { planHash });
  assert.strictEqual(r.status, 'executed');
  assert.strictEqual(r.results[0].status, 'success');
  // operacja 'do-it' wykonana raz; verify 'check' ponawiany do sukcesu
  assert.strictEqual(executed.filter((c) => c === 'do-it').length, 1);
  assert.strictEqual(verifyCalls, 3);
});

test('dryRun nie wykonuje ani nie żurnaluje', async () => {
  const { m, journal, executed } = setup();
  const steps = [{ id: 's1', type: 'command', command: 'echo a', os: 'linux' }];
  const planHash = storePlan(m, 'p1', steps);
  const r = await m.executePlan(1, 'p1', { planHash, dryRun: true });
  assert.strictEqual(r.status, 'dry_run');
  assert.strictEqual(executed.length, 0);
  assert.strictEqual(await journal.isStepDone('p1', 's1'), false);
});
