const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  hashPassword,
  verifyPassword,
  needsRehash,
} = require('../modules/auth/password-hash');

test('hashPassword tworzy format scrypt z losową solą', () => {
  const h1 = hashPassword('s3cret');
  const h2 = hashPassword('s3cret');
  assert.ok(h1.startsWith('scrypt$'));
  // Sól losowa → te same hasło daje różne hashe.
  assert.notStrictEqual(h1, h2);
});

test('verifyPassword akceptuje poprawne hasło', () => {
  const h = hashPassword('correct horse battery staple');
  assert.strictEqual(verifyPassword('correct horse battery staple', h), true);
});

test('verifyPassword odrzuca błędne hasło', () => {
  const h = hashPassword('correct');
  assert.strictEqual(verifyPassword('wrong', h), false);
});

test('verifyPassword wspiera stary format SHA-256 (wsteczna kompatybilność)', () => {
  const legacy = crypto.createHash('sha256').update('legacy-pass', 'utf8').digest('hex');
  assert.strictEqual(verifyPassword('legacy-pass', legacy), true);
  assert.strictEqual(verifyPassword('inne', legacy), false);
});

test('needsRehash sygnalizuje stare hashe, nie nowe', () => {
  const legacy = crypto.createHash('sha256').update('x', 'utf8').digest('hex');
  assert.strictEqual(needsRehash(legacy), true);
  assert.strictEqual(needsRehash(hashPassword('x')), false);
  assert.strictEqual(needsRehash(''), true);
});

test('verifyPassword bezpiecznie obsługuje błędne dane wejściowe', () => {
  assert.strictEqual(verifyPassword('', 'scrypt$1$2$3$aa$bb'), false);
  assert.strictEqual(verifyPassword('x', ''), false);
  assert.strictEqual(verifyPassword('x', 'niepoprawny-format'), false);
});
