const { test } = require('node:test');
const assert = require('node:assert');
const { verifyWithPolicy } = require('../modules/agent/verifier');

const noSleep = async () => {};

test('sukces za pierwszym razem', async () => {
  const r = await verifyWithPolicy({ command: 'v', run: async () => ({ code: 0 }), sleep: noSleep });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attempts, 1);
});

test('retry: pada, potem przechodzi w kolejnej próbie', async () => {
  let n = 0;
  const r = await verifyWithPolicy({
    command: 'v',
    run: async () => ({ code: n++ < 2 ? 1 : 0 }), // 2 błędy, potem OK
    sleep: noSleep,
    policy: { attempts: 5, delayMs: 10 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attempts, 3);
});

test('wyczerpanie prób -> ok:false', async () => {
  const r = await verifyWithPolicy({
    command: 'v',
    run: async () => ({ code: 1 }),
    sleep: noSleep,
    policy: { attempts: 3 },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.attempts, 3);
  assert.strictEqual(r.flapping, false);
});

test('flapping: przechodzi, potem niestabilny -> ok:false, flapping:true', async () => {
  const codes = [0, 0, 1]; // pierwsza OK, stabilizacja: OK, potem FAIL
  let i = 0;
  const r = await verifyWithPolicy({
    command: 'v',
    run: async () => ({ code: codes[i++] }),
    sleep: noSleep,
    policy: { attempts: 1, stabilizeChecks: 2, stabilizeDelayMs: 5 },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.flapping, true);
});

test('stabilny przez kontrole -> ok:true', async () => {
  const r = await verifyWithPolicy({
    command: 'v',
    run: async () => ({ code: 0 }),
    sleep: noSleep,
    policy: { stabilizeChecks: 3 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.flapping, false);
});

test('wyjątek run traktowany jak niepowodzenie', async () => {
  const r = await verifyWithPolicy({
    command: 'v',
    run: async () => { throw new Error('down'); },
    sleep: noSleep,
    policy: { attempts: 2 },
  });
  assert.strictEqual(r.ok, false);
});
