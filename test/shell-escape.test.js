const { test } = require('node:test');
const assert = require('node:assert');
const {
  shQuote,
  psSingleQuote,
  winCmdArg,
  assertIdentifier,
} = require('../modules/access/shell-escape');

test('shQuote owija wartość w pojedyncze cudzysłowy', () => {
  assert.strictEqual(shQuote('hello'), `'hello'`);
});

test('shQuote neutralizuje próbę wstrzyknięcia polecenia', () => {
  // Klasyczny payload: "; rm -rf /" nie może wyjść poza literał.
  const malicious = `x'; rm -rf / #`;
  const quoted = shQuote(malicious);
  // Cały payload pozostaje wewnątrz jednego cytowanego argumentu.
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
  // Apostrof został rozbity sekwencją '\'' – brak nieosłoniętego ' w środku.
  assert.ok(quoted.includes(`'\\''`));
});

test('shQuote obsługuje wartości liczbowe', () => {
  assert.strictEqual(shQuote(22), `'22'`);
});

test('psSingleQuote podwaja apostrofy', () => {
  assert.strictEqual(psSingleQuote("O'Brien"), `'O''Brien'`);
});

test('winCmdArg cytuje i escapuje cudzysłowy', () => {
  assert.strictEqual(winCmdArg('svc name'), `"svc name"`);
  assert.strictEqual(winCmdArg('a"b'), `"a\\"b"`);
});

test('winCmdArg odrzuca niebezpieczne metaznaki cmd', () => {
  assert.throws(() => winCmdArg('a%PATH%'), /Niedozwolone/);
  assert.throws(() => winCmdArg('a\nb'), /Niedozwolone/);
});

test('assertIdentifier przepuszcza poprawne nazwy', () => {
  assert.strictEqual(assertIdentifier('nginx.service', 'svc'), 'nginx.service');
  assert.strictEqual(assertIdentifier('DOMAIN\\user', 'user'), 'DOMAIN\\user');
  assert.strictEqual(assertIdentifier('user@host', 'user'), 'user@host');
});

test('assertIdentifier odrzuca wstrzyknięcia i puste wartości', () => {
  assert.throws(() => assertIdentifier('a; rm -rf /', 'x'), /Niedozwolone/);
  assert.throws(() => assertIdentifier('a b', 'x'), /Niedozwolone/);
  assert.throws(() => assertIdentifier('$(whoami)', 'x'), /Niedozwolone/);
  assert.throws(() => assertIdentifier('', 'x'), /wymagana/);
  assert.throws(() => assertIdentifier(null, 'x'), /wymagana/);
});
