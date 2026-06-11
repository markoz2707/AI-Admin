const { test } = require('node:test');
const assert = require('node:assert');
const LLMManager = require('../modules/llm/llm-manager');

// Buduje LLMManager z zastubowanym źródłem planu (bez LLM/DB/sieci).
function setup(tasks) {
  const m = new LLMManager({ apiKey: 'x' });
  m.getServerConfig = async () => ({ id: 1, os: 'linux' });
  m._buildPlanAndTasks = async () => ({ plan: 'plan testowy', tasks });
  return m;
}

test('buildPlan wzbogaca typed actions o verify i compensation', async () => {
  const m = setup([
    { type: 'installation', app: 'nginx', description: 'instalacja' },
    { type: 'service', serviceName: 'nginx', action: 'stop' },
  ]);
  const plan = await m.buildPlan('zainstaluj nginx', 1);
  const pkg = plan.steps.find((s) => s.type === 'package.install');
  const svc = plan.steps.find((s) => s.type === 'service.stop');
  assert.ok(pkg && pkg.verify && pkg.compensation, 'pakiet ma verify+compensation');
  assert.ok(svc && svc.verify && svc.compensation, 'usługa ma verify+compensation');
  assert.strictEqual(pkg.metadata.category, 'package');
});

test('typedOnly odrzuca surowe polecenia (zostają tylko typed actions)', async () => {
  const m = setup([
    { type: 'service', serviceName: 'nginx', action: 'restart' },
    { type: 'command', command: 'echo dowolne' },
  ]);
  const plan = await m.buildPlan('zrób', 1, { typedOnly: true });
  assert.strictEqual(plan.rejectedRaw, 1);
  assert.ok(plan.steps.every((s) => s.type.startsWith('service.') || s.type.startsWith('package.')));
});

test('bez typedOnly surowe polecenie pozostaje w planie', async () => {
  const m = setup([{ type: 'command', command: 'uname -a' }]);
  const plan = await m.buildPlan('zrób', 1);
  assert.strictEqual(plan.rejectedRaw, 0);
  assert.strictEqual(plan.steps.length, 1);
  assert.strictEqual(plan.steps[0].command, 'uname -a');
});
