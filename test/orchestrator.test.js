const { test } = require('node:test');
const assert = require('node:assert');
const Orchestrator = require('../modules/llm/orchestrator');
const { parsePlan, planFromTasks } = require('../modules/llm/plan-schema');

test('buildPlan ocenia ryzyko i flaguje zatwierdzenie', () => {
  const o = new Orchestrator();
  const p = o.buildPlan({
    summary: 'test',
    steps: [
      { id: 's1', type: 'command', command: 'uname -a' },
      { id: 's2', type: 'command', command: 'sudo apt-get install -y nginx' },
    ],
  });
  assert.strictEqual(p.maxRisk, 'high');
  assert.strictEqual(p.requiresApproval, true);
});

test('execute: blokuje krok critical i zatrzymuje plan', async () => {
  const o = new Orchestrator();
  const calls = [];
  const res = await o.execute(
    { steps: [{ id: 's1', type: 'command', command: 'rm -rf /' }, { id: 's2', type: 'command', command: 'uname -a' }] },
    { executor: async (s) => { calls.push(s.id); return { code: 0 }; } }
  );
  assert.strictEqual(res.results[0].status, 'blocked');
  assert.strictEqual(res.results[1].status, 'skipped');
  assert.strictEqual(res.status, 'blocked');
  assert.deepStrictEqual(calls, []); // nic nie wykonano
});

test('execute: krok high wymaga approveHighRisk', async () => {
  const o = new Orchestrator();
  const plan = { steps: [{ id: 's1', type: 'command', command: 'sudo apt-get install -y nginx' }] };

  const blocked = await o.execute(plan, { executor: async () => ({ code: 0 }) });
  assert.strictEqual(blocked.results[0].status, 'needs_approval');

  const calls = [];
  const ok = await o.execute(plan, {
    approveHighRisk: true,
    executor: async (s) => { calls.push(s.id); return { code: 0 }; },
  });
  assert.strictEqual(ok.results[0].status, 'success');
  assert.deepStrictEqual(calls, ['s1']);
});

test('execute: dryRun niczego nie wykonuje', async () => {
  const o = new Orchestrator();
  const calls = [];
  const res = await o.execute(
    { steps: [{ id: 's1', type: 'command', command: 'uname -a' }] },
    { dryRun: true, executor: async (s) => { calls.push(s.id); } }
  );
  assert.strictEqual(res.status, 'dry_run');
  assert.strictEqual(res.results[0].status, 'dry_run');
  assert.deepStrictEqual(calls, []);
});

test('execute: stopOnError przerywa po błędzie', async () => {
  const o = new Orchestrator();
  const res = await o.execute(
    { steps: [
      { id: 's1', type: 'command', command: 'echo a' },
      { id: 's2', type: 'command', command: 'echo b' },
    ] },
    { executor: async (s) => { if (s.id === 's1') throw new Error('boom'); return {}; } }
  );
  assert.strictEqual(res.results[0].status, 'error');
  assert.strictEqual(res.results[1].status, 'skipped');
  assert.strictEqual(res.status, 'partial_error');
});

test('parsePlan wyciąga i normalizuje kroki z JSON (string)', () => {
  const raw = 'tekst przed {"summary":"x","steps":[{"type":"command","command":"ls"},{"type":"service","name":"nginx","action":"start"},{"type":"command"}]} tekst po';
  const plan = parsePlan(raw);
  assert.strictEqual(plan.steps.length, 2); // pusty command odrzucony
  assert.strictEqual(plan.steps[0].command, 'ls');
  assert.strictEqual(plan.steps[1].serviceName, 'nginx');
});

test('planFromTasks mapuje zadania installation', () => {
  const plan = planFromTasks([{ type: 'installation', app: 'nginx', description: 'inst' }], 'plan');
  assert.strictEqual(plan.steps[0].type, 'installation');
  assert.strictEqual(plan.steps[0].packageName, 'nginx');
});
