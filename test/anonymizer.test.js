const { test } = require('node:test');
const assert = require('node:assert');
const { Anonymizer } = require('../modules/llm/anonymizer');

test('anonimizuje host, IP i e-mail, ukrywając oryginały', () => {
  const a = new Anonymizer();
  const out = a.anonymize('Serwer web.prod.example.com (10.0.0.5), admin@firma.pl');
  assert.ok(!out.includes('web.prod.example.com'));
  assert.ok(!out.includes('10.0.0.5'));
  assert.ok(!out.includes('admin@firma.pl'));
  assert.match(out, /\[\[HOST_\d+\]\]/);
  assert.match(out, /\[\[IP_\d+\]\]/);
  assert.match(out, /\[\[EMAIL_\d+\]\]/);
});

test('roundtrip: deanonymize odtwarza oryginał', () => {
  const a = new Anonymizer();
  const original = 'Połącz z 192.168.1.10 jako root@host.local';
  const anon = a.anonymize(original);
  assert.strictEqual(a.deanonymize(anon), original);
});

test('ten sam token dla powtórzonej wartości (spójność)', () => {
  const a = new Anonymizer();
  const out = a.anonymize('10.0.0.5 oraz znowu 10.0.0.5');
  const tokens = out.match(/\[\[IP_\d+\]\]/g);
  assert.strictEqual(tokens.length, 2);
  assert.strictEqual(tokens[0], tokens[1]);
});

test('deanonymize odpowiedzi zewnętrznego LLM przywraca dane', () => {
  const a = new Anonymizer();
  a.anonymize('host web.example.com'); // tworzy [[HOST_1]] -> web.example.com
  const reply = 'Na hoście [[HOST_1]] uruchom nginx';
  assert.strictEqual(a.deanonymize(reply), 'Na hoście web.example.com uruchom nginx');
});

test('klucz prywatny jest maskowany jako SECRET', () => {
  const a = new Anonymizer();
  const key = '-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----';
  const out = a.anonymize(`klucz: ${key}`);
  assert.ok(!out.includes('ABCDEF'));
  assert.match(out, /\[\[SECRET_\d+\]\]/);
});
