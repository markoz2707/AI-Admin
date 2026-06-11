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

test('startRun zachowuje verify/compensation do read-backu', async () => {
  const j = newJournal();
  await j.startRun({
    planId: 'p1', serverId: 9,
    steps: [{ id: 's1', command: 'echo a', verify: 'test -f /x', compensation: 'rm /x' }],
  });
  const [row] = await j.listNeedsVerification().then(() => j.getRun('p1'));
  assert.strictEqual(row.verify, 'test -f /x');
  assert.strictEqual(row.compensation, 'rm /x');
  assert.strictEqual(row.server_id, 9);
});

test('listNeedsVerification + markVerifiedDone', async () => {
  const j = newJournal();
  await j.startRun({ planId: 'p1', serverId: 1, steps: [{ id: 's1', command: 'c', verify: 'v' }] });
  await j.beginStep('p1', 's1');
  await j.recover(); // executing -> needs_verification
  let nv = await j.listNeedsVerification();
  assert.strictEqual(nv.length, 1);
  assert.strictEqual(nv[0].verify, 'v');
  await j.markVerifiedDone('p1', 's1');
  assert.strictEqual(await j.isStepDone('p1', 's1'), true);
  assert.strictEqual((await j.listNeedsVerification()).length, 0);
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
