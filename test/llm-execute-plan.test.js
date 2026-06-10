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

test('dryRun nie wykonuje ani nie żurnaluje', async () => {
  const { m, journal, executed } = setup();
  const steps = [{ id: 's1', type: 'command', command: 'echo a', os: 'linux' }];
  const planHash = storePlan(m, 'p1', steps);
  const r = await m.executePlan(1, 'p1', { planHash, dryRun: true });
  assert.strictEqual(r.status, 'dry_run');
  assert.strictEqual(executed.length, 0);
  assert.strictEqual(await journal.isStepDone('p1', 's1'), false);
});
