const { test } = require('node:test');
const assert = require('node:assert');
const { classifySensitivity } = require('../modules/llm/sensitivity');

test('wykrywa hasła/sekrety', () => {
  assert.strictEqual(classifySensitivity('ustaw hasło root na X').sensitive, true);
  assert.strictEqual(classifySensitivity('here is the api_key abc').sensitive, true);
});

test('wykrywa prywatne adresy IP', () => {
  assert.strictEqual(classifySensitivity('połącz z 192.168.1.10').sensitive, true);
  assert.strictEqual(classifySensitivity('host 10.0.0.5').sensitive, true);
});

test('wykrywa e-mail i środowisko produkcyjne', () => {
  assert.strictEqual(classifySensitivity('konto admin@firma.pl').sensitive, true);
  assert.strictEqual(classifySensitivity('to jest serwer prod').sensitive, true);
});

test('kontekst produkcyjny czyni treść poufną', () => {
  const r = classifySensitivity('zainstaluj nginx', { environment: 'production' });
  assert.strictEqual(r.sensitive, true);
});

test('zwykła prośba nie jest poufna', () => {
  const r = classifySensitivity('jak zainstalować nginx na ubuntu');
  assert.strictEqual(r.sensitive, false);
  assert.deepStrictEqual(r.reasons, []);
});
