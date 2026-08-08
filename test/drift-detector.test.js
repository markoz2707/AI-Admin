const { test } = require('node:test');
const assert = require('node:assert');
const { detectDrift, createDesiredStateGoal } = require('../modules/agent/drift-detector');

test('wykrywa nieuruchomioną usługę i brakujący pakiet', () => {
  const snapshot = {
    services: [{ name: 'nginx.service', status: 'inactive' }, { name: 'cron.service', status: 'active' }],
    packages: [{ name: 'curl' }],
  };
  const desired = { services: { nginx: 'running', cron: 'running' }, packages: ['curl', 'htop'] };
  const d = detectDrift(snapshot, desired);
  assert.strictEqual(d.drifted, true);
  // nginx nieaktywny -> start; htop brak -> install; cron OK i curl OK -> brak
  const kinds = d.tasks.map((t) => `${t.type}:${t.serviceName || t.packageName}`);
  assert.ok(kinds.includes('service:nginx'));
  assert.ok(kinds.includes('installation:htop'));
  assert.strictEqual(d.tasks.length, 2);
});

test('brak dryfu gdy stan zgodny', () => {
  const snapshot = {
    services: [{ name: 'nginx.service', status: 'active' }],
    packages: [{ name: 'curl' }],
  };
  const d = detectDrift(snapshot, { services: { nginx: 'running' }, packages: ['curl'] });
  assert.strictEqual(d.drifted, false);
  assert.strictEqual(d.tasks.length, 0);
});

test('createDesiredStateGoal zwraca cel zadaniowy lub null', () => {
  const goalFn = createDesiredStateGoal({ 1: { services: { nginx: 'running' } } });
  const drift = goalFn({ id: 1 }, { services: [{ name: 'nginx.service', status: 'dead' }] });
  assert.ok(drift && Array.isArray(drift.tasks) && drift.tasks.length === 1);
  assert.match(drift.summary, /Remediacja dryfu/);

  const noDrift = goalFn({ id: 1 }, { services: [{ name: 'nginx.service', status: 'running' }] });
  assert.strictEqual(noDrift, null);
});
