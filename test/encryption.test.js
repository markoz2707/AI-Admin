const { test } = require('node:test');
const assert = require('node:assert');
const Encryption = require('../modules/password-manager/encryption');

test('encrypt/decrypt round-trip zwraca oryginalny tekst', () => {
  const enc = new Encryption('master-password');
  const secret = 'super tajne hasło 123!@#';
  const cipher = enc.encrypt(secret);
  assert.notStrictEqual(cipher, secret);
  assert.strictEqual(enc.decrypt(cipher), secret);
});

test('encrypt używa losowego IV/soli (różne szyfrogramy)', () => {
  const enc = new Encryption('master-password');
  const a = enc.encrypt('to samo');
  const b = enc.encrypt('to samo');
  assert.notStrictEqual(a, b);
});

test('format zawiera salt:iv:authTag:ciphertext', () => {
  const enc = new Encryption('pw');
  const parts = enc.encrypt('x').split(':');
  assert.strictEqual(parts.length, 4);
});

test('decrypt wykrywa naruszenie integralności (GCM auth tag)', () => {
  const enc = new Encryption('pw');
  const cipher = enc.encrypt('dane');
  // Zepsuj ostatni znak szyfrogramu.
  const tampered = cipher.slice(0, -1) + (cipher.endsWith('0') ? '1' : '0');
  assert.throws(() => enc.decrypt(tampered), /Failed to decrypt/);
});

test('błędny master-password nie odszyfrowuje', () => {
  const cipher = new Encryption('pw-a').encrypt('dane');
  assert.throws(() => new Encryption('pw-b').decrypt(cipher), /Failed to decrypt/);
});

test('konstruktor wymaga master-password', () => {
  assert.throws(() => new Encryption(), /required/);
});
