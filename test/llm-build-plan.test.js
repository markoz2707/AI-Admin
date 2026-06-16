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

test('buildPlan przypisuje autorytet per krok i maxAuthority', async () => {
  const m = setup([{ type: 'installation', app: 'nginx' }]);
  // dev -> instalacja pakietu (reversible) powinna być AUTONOMOUS
  m.getServerConfig = async () => ({ id: 1, os: 'linux', environment: 'dev' });
  const plan = await m.buildPlan('zainstaluj', 1);
  assert.ok(['AUTONOMOUS', 'NOTIFY'].includes(plan.steps[0].authority));
  assert.ok(plan.maxAuthority);

  // prod podnosi poziom
  const m2 = setup([{ type: 'installation', app: 'nginx' }]);
  m2.getServerConfig = async () => ({ id: 1, os: 'linux', environment: 'prod' });
  const plan2 = await m2.buildPlan('zainstaluj', 1);
  const order = ['AUTONOMOUS', 'NOTIFY', 'APPROVAL', 'FORBIDDEN'];
  assert.ok(order.indexOf(plan2.steps[0].authority) >= order.indexOf(plan.steps[0].authority));
});

test('polityka autorytetu z konfiguracji: autonomyEnabled=false -> wszystko APPROVAL', async () => {
  const m = setup([{ type: 'installation', app: 'nginx' }]);
  m.setAuthorityPolicy({ autonomyEnabled: false });
  const plan = await m.buildPlan('zainstaluj', 1);
  assert.strictEqual(plan.steps[0].authority, 'APPROVAL');
  assert.strictEqual(plan.maxAuthority, 'APPROVAL');
});

test('opcja policy w buildPlan ma pierwszeństwo nad domyślną', async () => {
  const m = setup([{ type: 'installation', app: 'nginx' }]);
  m.setAuthorityPolicy({ autonomyEnabled: false }); // domyślna restrykcyjna
  const plan = await m.buildPlan('zainstaluj', 1, { policy: {} }); // nadpisz luźniejszą
  assert.ok(['AUTONOMOUS', 'NOTIFY'].includes(plan.steps[0].authority));
});

test('bez typedOnly surowe polecenie pozostaje w planie', async () => {
  const m = setup([{ type: 'command', command: 'uname -a' }]);
  const plan = await m.buildPlan('zrób', 1);
  assert.strictEqual(plan.rejectedRaw, 0);
  assert.strictEqual(plan.steps.length, 1);
  assert.strictEqual(plan.steps[0].command, 'uname -a');
});
