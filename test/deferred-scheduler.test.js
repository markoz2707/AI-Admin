const { test } = require('node:test');
const assert = require('node:assert');
const DeferredScheduler = require('../modules/agent/deferred-scheduler');

// Zegar wstrzykiwany: przechwytuje callback, by test mógł go wywołać ręcznie.
function fakeClock() {
  const timers = [];
  return {
    setTimeoutFn: (cb) => { const id = timers.length; timers.push({ cb, cleared: false }); return id; },
    clearTimeoutFn: (id) => { if (timers[id]) timers[id].cleared = true; },
    async fire(id = 0) {
      if (!timers[id] || timers[id].cleared) return; // zawetowane nie odpalają
      return timers[id].cb();
    },
  };
}

test('weto przed czasem T zatrzymuje wykonanie', async () => {
  const clock = fakeClock();
  const fired = [];
  const s = new DeferredScheduler({
    execute: async (item) => { fired.push(item.planId); return { status: 'executed' }; },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const { deferredId } = s.schedule({ serverId: 1, planId: 'p1' }, 5000);
  assert.strictEqual(s.veto(deferredId, 'nie teraz'), true);
  await clock.fire(0); // próba odpalenia — zawetowane, nic się nie dzieje
  assert.deepStrictEqual(fired, []);
  assert.strictEqual(s.get(deferredId).status, 'vetoed');
  assert.strictEqual(s.get(deferredId).vetoReason, 'nie teraz');
});

test('bez weta plan wykonuje się po czasie T', async () => {
  const clock = fakeClock();
  const fired = [];
  const s = new DeferredScheduler({
    execute: async (item) => { fired.push(item.planId); return { status: 'executed' }; },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const { deferredId } = s.schedule({ serverId: 1, planId: 'p2' }, 5000);
  await clock.fire(0);
  assert.deepStrictEqual(fired, ['p2']);
  assert.strictEqual(s.get(deferredId).status, 'fired');
});

test('weto po wykonaniu zwraca false', async () => {
  const clock = fakeClock();
  const s = new DeferredScheduler({
    execute: async () => ({ status: 'executed' }),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  const { deferredId } = s.schedule({ serverId: 1, planId: 'p3' }, 1000);
  await clock.fire(0);
  assert.strictEqual(s.veto(deferredId), false);
});

test('list pokazuje odroczenia bez wewnętrznego timera', () => {
  const clock = fakeClock();
  const s = new DeferredScheduler({ execute: async () => ({}), ...clock });
  s.schedule({ serverId: 2, planId: 'pA' }, 1000);
  const list = s.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].item.planId, 'pA');
  assert.strictEqual(list[0].timer, undefined);
});
