const { test } = require('node:test');
const assert = require('node:assert');
const LLMRouter = require('../modules/llm/llm-router');

// Pomocniczy fake provider podmieniany w routerze (bez sieci).
function fakeProvider(name, configured, handler) {
  return {
    name,
    isConfigured: () => configured,
    async queryWithContext(messages) {
      return handler ? handler(messages) : 'ok';
    },
    async checkAvailability() {
      return configured;
    },
  };
}

test('auto + poufne + lokalny dostępny -> lokalny (raw)', () => {
  const r = new LLMRouter({ policy: 'auto' });
  r.local = fakeProvider('local', true);
  r.external = fakeProvider('openai', true);
  const d = r.decide('hasło roota to tajne');
  assert.strictEqual(d.provider, 'local');
  assert.strictEqual(d.mode, 'raw');
});

test('auto + poufne + brak lokalnego + zgoda na anonimizację -> openai (anonymize)', () => {
  const r = new LLMRouter({ policy: 'auto', allowAnonymization: true });
  r.local = fakeProvider('local', false);
  r.external = fakeProvider('openai', true);
  const d = r.decide('serwer 10.0.0.5 ma hasło X');
  assert.strictEqual(d.provider, 'openai');
  assert.strictEqual(d.mode, 'anonymize');
});

test('auto + poufne + brak lokalnego + brak zgody -> blocked', () => {
  const r = new LLMRouter({ policy: 'auto', allowAnonymization: false });
  r.local = fakeProvider('local', false);
  r.external = fakeProvider('openai', true);
  const d = r.decide('hasło: tajne');
  assert.strictEqual(d.mode, 'blocked');
});

test('auto + niepoufne -> openai (raw)', () => {
  const r = new LLMRouter({ policy: 'auto' });
  r.local = fakeProvider('local', true);
  r.external = fakeProvider('openai', true);
  const d = r.decide('jak zainstalowac nginx');
  assert.strictEqual(d.provider, 'openai');
  assert.strictEqual(d.mode, 'raw');
});

test('polityka local zawsze lokalna, openai zawsze zewnętrzna', () => {
  const rl = new LLMRouter({ policy: 'local' });
  assert.strictEqual(rl.decide('cokolwiek').provider, 'local');
  const ro = new LLMRouter({ policy: 'openai' });
  assert.strictEqual(ro.decide('hasło tajne').provider, 'openai');
});

test('queryWithContext: tryb blocked rzuca błąd z kodem', async () => {
  const r = new LLMRouter({ policy: 'auto', allowAnonymization: false });
  r.local = fakeProvider('local', false);
  r.external = fakeProvider('openai', true);
  await assert.rejects(
    () => r.queryWithContext([{ role: 'user', content: 'hasło: x' }]),
    (e) => e.code === 'LLM_SENSITIVE_BLOCKED'
  );
});

test('queryWithContext: anonymize wysyła zamaskowane dane i odtwarza odpowiedź', async () => {
  const r = new LLMRouter({ policy: 'anonymize' });
  let received = null;
  r.external = fakeProvider('openai', true, (messages) => {
    received = messages;
    // Zewnętrzny LLM widzi tylko placeholdery i tak odpowiada.
    return 'Na hoście [[HOST_1]] skonfiguruj nginx';
  });
  const out = await r.queryWithContext(
    [{ role: 'user', content: 'skonfiguruj nginx na web.prod.example.com' }]
  );
  // Do zewnętrznego providera nie trafił surowy host.
  assert.ok(!received[0].content.includes('web.prod.example.com'));
  assert.match(received[0].content, /\[\[HOST_\d+\]\]/);
  // Odpowiedź została zde-anonimizowana lokalnie.
  assert.ok(out.includes('web.prod.example.com'));
});

test('getStatus zwraca konfigurację providerów', () => {
  const r = new LLMRouter({
    policy: 'auto',
    local: { enabled: true, baseUrl: 'http://localhost:11434', model: 'llama3.1' },
  });
  const s = r.getStatus();
  assert.strictEqual(s.policy, 'auto');
  assert.strictEqual(s.local.configured, true);
});
