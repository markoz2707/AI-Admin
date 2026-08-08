const { test } = require('node:test');
const assert = require('node:assert');
const LLMManager = require('../modules/llm/llm-manager');

function setup(tasks, environment = 'dev') {
  const m = new LLMManager({ apiKey: 'x' });
  m.getServerConfig = async () => ({ id: 1, os: 'linux', environment });
  m._buildPlanAndTasks = async () => ({ plan: 'plan', tasks });
  const executed = [];
  m.serverManager = {
    isServerConnected: () => true,
    async connectToServer() {},
    async executeCommand(id, cmd) { executed.push(cmd); return { code: 0, stdout: 'ok' }; },
  };
  return { m, executed };
}

test('executeAutonomously: AUTONOMOUS/NOTIFY wykonane, APPROVAL wstrzymane', async () => {
  const { m, executed } = setup([
    { type: 'installation', app: 'nginx' },                    // NOTIFY (dev, sudo reclass.)
    { type: 'service', serviceName: 'nginx', action: 'stop' }, // APPROVAL (systemctl stop)
  ]);
  const plan = await m.buildPlan('zrób', 1);
  const r = await m.executeAutonomously(1, plan.planId, { planHash: plan.planHash, stopOnError: false });

  assert.ok(r.autonomy.notify.length >= 1, 'instalacja jako NOTIFY');
  assert.ok(r.autonomy.pendingApproval.length >= 1, 'service.stop wymaga zgody');
  // instalacja wykonana autonomicznie...
  assert.ok(executed.some((c) => /apt-get install -y 'nginx'/.test(c)));
  // ...a zatrzymanie usługi NIE (czeka na zgodę)
  assert.ok(!executed.some((c) => /systemctl stop/.test(c)));
});

test('executeAutonomously: krytyczne polecenie zablokowane (FORBIDDEN)', async () => {
  const { m, executed } = setup([{ type: 'command', command: 'rm -rf /' }]);
  const plan = await m.buildPlan('zrób', 1);
  const r = await m.executeAutonomously(1, plan.planId, { planHash: plan.planHash, stopOnError: false });
  assert.ok(r.results.every((x) => x.status !== 'success'));
  assert.deepStrictEqual(executed, []);
});

test('executeAutonomously w prod podnosi próg (instalacja wymaga zgody)', async () => {
  const { m, executed } = setup([{ type: 'installation', app: 'nginx' }], 'prod');
  const plan = await m.buildPlan('zrób', 1);
  // prod: NOTIFY -> APPROVAL (bump), więc instalacja nie wykonuje się sama
  const r = await m.executeAutonomously(1, plan.planId, { planHash: plan.planHash, stopOnError: false });
  assert.ok(r.autonomy.pendingApproval.length >= 1);
  assert.ok(!executed.some((c) => /install/.test(c)));
});
