const { test } = require('node:test');
const assert = require('node:assert');
const { resolve, isRegistered, listTypes } = require('../modules/actions/action-registry');

test('package.install (linux) ma command, verify, compensation i metadane', () => {
  const { typed, step } = resolve({ id: 's1', type: 'package.install', params: { name: 'nginx' } }, 'linux');
  assert.strictEqual(typed, true);
  assert.match(step.command, /apt-get install -y 'nginx'/);
  assert.match(step.verify, /dpkg -s 'nginx'/);
  assert.match(step.compensation, /remove -y 'nginx'/);
  assert.strictEqual(step.metadata.category, 'package');
  assert.strictEqual(step.metadata.reversibility, 'reversible');
});

test('package.install (windows) używa choco', () => {
  const { step } = resolve({ id: 's1', type: 'package.install', params: { name: 'git' } }, 'windows');
  assert.match(step.command, /choco install "git" -y/);
  assert.match(step.compensation, /choco uninstall "git" -y/);
});

test('service.stop ma odwrotną kompensację (start) i odpowiedni verify', () => {
  const { step } = resolve({ id: 's1', type: 'service.stop', params: { name: 'nginx' } }, 'linux');
  assert.match(step.command, /systemctl stop 'nginx'/);
  assert.match(step.verify, /! systemctl is-active --quiet 'nginx'/);
  assert.match(step.compensation, /systemctl start 'nginx'/);
});

test('mapuje starsze typy: installation -> package.install', () => {
  const { typed, step } = resolve({ id: 's1', type: 'installation', app: 'curl' }, 'linux');
  assert.strictEqual(typed, true);
  assert.strictEqual(step.type, 'package.install');
  assert.match(step.command, /install -y 'curl'/);
});

test('mapuje starsze typy: service+action -> service.restart', () => {
  const { step } = resolve({ id: 's1', type: 'service', serviceName: 'sshd', action: 'restart' }, 'linux');
  assert.strictEqual(step.type, 'service.restart');
  assert.match(step.command, /systemctl restart 'sshd'/);
});

test('surowe polecenie nie jest typed action', () => {
  const r = resolve({ id: 's1', type: 'command', command: 'ls -la' }, 'linux');
  assert.strictEqual(r.typed, false);
});

test('walidacja nazwy usługi odrzuca wstrzyknięcie', () => {
  assert.throws(() => resolve({ id: 's1', type: 'service.start', params: { name: 'a; rm -rf /' } }, 'linux'), /Niedozwolone/);
});

test('isRegistered / listTypes', () => {
  assert.strictEqual(isRegistered('service.start'), true);
  assert.strictEqual(isRegistered('nope'), false);
  assert.ok(listTypes().includes('package.install'));
});
