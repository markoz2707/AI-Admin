const { test } = require('node:test');
const assert = require('node:assert');
const { ExecutionJournal, createMemoryStore } = require('../modules/journal/execution-journal');

function newJournal() {
  return new ExecutionJournal(createMemoryStore());
}

const steps = [
  { id: 's1', command: 'echo a' },
  { id: 's2', command: 'echo b' },
];

test('startRun rejestruje kroki jako pending (idempotentnie)', async () => {
  const j = newJournal();
  await j.startRun({ planId: 'p1', planHash: 'h', serverId: 1, steps });
  await j.startRun({ planId: 'p1', planHash: 'h', serverId: 1, steps }); // ponowne — bez duplikatów
  const run = await j.getRun('p1');
  assert.strictEqual(run.length, 2);
  assert.strictEqual(run[0].status, 'pending');
});

test('beginStep ustawia executing i zlicza próby', async () => {
  const j = newJournal();
  await j.startRun({ planId: 'p1', serverId: 1, steps });
  await j.beginStep('p1', 's1');
  const row = (await j.getRun('p1')).find((r) => r.step_id === 's1');
  assert.strictEqual(row.status, 'executing');
  assert.strictEqual(row.attempt, 1);
});

test('completeStep + isStepDone', async () => {
  const j = newJournal();
  await j.startRun({ planId: 'p1', serverId: 1, steps });
  await j.beginStep('p1', 's1');
  await j.completeStep('p1', 's1', { status: 'done', result: { code: 0 } });
  assert.strictEqual(await j.isStepDone('p1', 's1'), true);
  assert.strictEqual(await j.isStepDone('p1', 's2'), false);
});

test('findInterrupted + recover oznacza przerwane jako needs_verification', async () => {
  const j = newJournal();
  await j.startRun({ planId: 'p1', serverId: 1, steps });
  await j.beginStep('p1', 's1'); // proces "umiera" w trakcie -> zostaje executing
  const interrupted = await j.findInterrupted();
  assert.strictEqual(interrupted.length, 1);

  const recovered = await j.recover();
  assert.strictEqual(recovered.length, 1);
  const row = (await j.getRun('p1')).find((r) => r.step_id === 's1');
  assert.strictEqual(row.status, 'needs_verification');
  // po recover nic już nie jest 'executing'
  assert.strictEqual((await j.findInterrupted()).length, 0);
});
