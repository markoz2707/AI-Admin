const { test } = require('node:test');
const assert = require('node:assert');
const AgentLoop = require('../modules/agent/agent-loop');

test('runOnce: sukces zwiększa ticks i zeruje błędy', async () => {
  let calls = 0;
  const loop = new AgentLoop({ tick: async () => { calls++; } });
  await loop.runOnce();
  await loop.runOnce();
  assert.strictEqual(calls, 2);
  assert.strictEqual(loop.status().ticks, 2);
  assert.strictEqual(loop.status().failures, 0);
});

test('circuit breaker: po N błędach pętla się trip-uje i zatrzymuje', async () => {
  const loop = new AgentLoop({
    tick: async () => { throw new Error('boom'); },
    maxFailures: 3,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });
  loop.start();
  await loop.runOnce();
  await loop.runOnce();
  assert.strictEqual(loop.status().tripped, false);
  await loop.runOnce(); // trzeci błąd -> trip
  assert.strictEqual(loop.status().tripped, true);
  assert.strictEqual(loop.status().running, false);
  // po trip-ie kolejne runOnce są pomijane
  const r = await loop.runOnce();
  assert.strictEqual(r.reason, 'circuit_open');
});

test('reset czyści circuit breaker', async () => {
  const loop = new AgentLoop({ tick: async () => { throw new Error('x'); }, maxFailures: 1, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  loop.start();
  await loop.runOnce();
  assert.strictEqual(loop.status().tripped, true);
  loop.reset();
  assert.strictEqual(loop.status().tripped, false);
  assert.strictEqual(loop.status().failures, 0);
});

test('brak nakładania cykli (overlap pomijany)', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  let starts = 0;
  const loop = new AgentLoop({ tick: async () => { starts++; await gate; } });
  const p1 = loop.runOnce();          // wchodzi, czeka na gate
  const r2 = await loop.runOnce();    // pomijany — poprzedni w toku
  assert.strictEqual(r2.reason, 'overlap');
  assert.strictEqual(starts, 1);
  release();
  await p1;
  assert.strictEqual(loop.status().ticks, 1);
});

test('start/stop steruje stanem i interwałem (zegar wstrzyknięty)', () => {
  let intervalId = null;
  let cleared = null;
  const loop = new AgentLoop({
    tick: async () => {},
    setIntervalFn: () => { intervalId = 42; return intervalId; },
    clearIntervalFn: (id) => { cleared = id; },
  });
  loop.start(1000);
  assert.strictEqual(loop.status().running, true);
  assert.strictEqual(intervalId, 42);
  loop.stop();
  assert.strictEqual(loop.status().running, false);
  assert.strictEqual(cleared, 42);
});

test('start bez tick rzuca błąd', () => {
  const loop = new AgentLoop({});
  assert.throws(() => loop.start(), /wymaga funkcji tick/);
});
