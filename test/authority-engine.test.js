const { test } = require('node:test');
const assert = require('node:assert');
const { evaluate, evaluatePlan } = require('../modules/policy/authority-engine');

const md = (o) => ({ metadata: o });

test('krytyczne -> FORBIDDEN', () => {
  const d = evaluate({ guard: { risk: 'critical', violations: [] } });
  assert.strictEqual(d.authority, 'FORBIDDEN');
});

test('odwracalna zmiana niskiego ryzyka -> AUTONOMOUS', () => {
  const d = evaluate({ guard: { risk: 'low', violations: [] }, ...md({ reversibility: 'reversible', blastRadius: 'single_service', dataLossRisk: 'none', category: 'package' }) });
  assert.strictEqual(d.authority, 'AUTONOMOUS');
});

test('medium / requiresSnapshot -> NOTIFY', () => {
  const d = evaluate({ guard: { risk: 'medium', violations: [] }, ...md({ category: 'package' }) });
  assert.strictEqual(d.authority, 'NOTIFY');
});

test('utrata danych / nieodwracalność -> APPROVAL', () => {
  const d = evaluate({ guard: { risk: 'medium', violations: [] }, ...md({ dataLossRisk: 'high' }) });
  assert.strictEqual(d.authority, 'APPROVAL');
});

test('blastRadius environment -> APPROVAL', () => {
  const d = evaluate({ guard: { risk: 'low', violations: [] }, ...md({ blastRadius: 'environment' }) });
  assert.strictEqual(d.authority, 'APPROVAL');
});

test('self-lockout -> APPROVAL', () => {
  const d = evaluate({ guard: { risk: 'high', violations: [{ selfLockout: true, reason: 'x' }] } });
  assert.strictEqual(d.authority, 'APPROVAL');
});

test('środowisko prod podnosi poziom (AUTONOMOUS -> NOTIFY)', () => {
  const base = { guard: { risk: 'low', violations: [] }, ...md({ reversibility: 'reversible' }) };
  assert.strictEqual(evaluate(base, { environment: 'dev' }).authority, 'AUTONOMOUS');
  assert.strictEqual(evaluate(base, { environment: 'prod' }).authority, 'NOTIFY');
});

test('polityka: autonomia wyłączona -> min APPROVAL', () => {
  const d = evaluate({ guard: { risk: 'low', violations: [] } }, {}, { autonomyEnabled: false });
  assert.strictEqual(d.authority, 'APPROVAL');
});

test('reklasyfikacja sudo: typed action z samym sudo -> NOTIFY, raw -> APPROVAL', () => {
  const sudoGuard = { risk: 'high', violations: [{ severity: 'high', reason: 'podniesienie uprawnień (sudo)' }] };
  // typed action (np. package.install) — sudo nie wymusza APPROVAL
  const typed = evaluate({ guard: sudoGuard, ...md({ category: 'package', reversibility: 'reversible', blastRadius: 'single_service', dataLossRisk: 'none' }) });
  assert.strictEqual(typed.authority, 'NOTIFY');
  // surowe polecenie z sudo (brak metadanych) — APPROVAL
  assert.strictEqual(evaluate({ guard: sudoGuard }).authority, 'APPROVAL');
  // sudo + inny sygnał high (userdel) — APPROVAL mimo typed
  const mixed = { risk: 'high', violations: [
    { severity: 'high', reason: 'podniesienie uprawnień (sudo)' },
    { severity: 'high', reason: 'usuwanie konta/grupy' },
  ] };
  assert.strictEqual(evaluate({ guard: mixed, ...md({ category: 'service' }) }).authority, 'APPROVAL');
});

test('evaluatePlan agreguje maxAuthority', () => {
  const r = evaluatePlan(
    [
      { guard: { risk: 'low', violations: [] }, metadata: { reversibility: 'reversible' } },
      { guard: { risk: 'high', violations: [] }, metadata: {} },
    ],
    { environment: 'dev' }
  );
  assert.strictEqual(r.maxAuthority, 'APPROVAL');
  assert.strictEqual(r.steps[0].authority, 'AUTONOMOUS');
  assert.strictEqual(r.steps[1].authority, 'APPROVAL');
});
