const { test } = require('node:test');
const assert = require('node:assert');
const {
  classifyUname,
  parseOsRelease,
  parseWindowsVer,
  detect,
  detectAndVerify,
} = require('../modules/management/os-detector');

test('classifyUname rozpoznaje rodziny', () => {
  assert.strictEqual(classifyUname('Linux'), 'linux');
  assert.strictEqual(classifyUname('Darwin'), 'darwin');
  assert.strictEqual(classifyUname('FreeBSD'), 'bsd');
  assert.strictEqual(classifyUname(''), null);
});

test('parseOsRelease wyciąga dystrybucję', () => {
  const out = 'NAME="Ubuntu"\nVERSION_ID="22.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 22.04.3 LTS"';
  const r = parseOsRelease(out);
  assert.strictEqual(r.id, 'ubuntu');
  assert.strictEqual(r.versionId, '22.04');
  assert.strictEqual(r.prettyName, 'Ubuntu 22.04.3 LTS');
});

test('parseWindowsVer wyciąga wersję i build', () => {
  const r = parseWindowsVer('Microsoft Windows [Version 10.0.19045.3803]');
  assert.strictEqual(r.version, '10.0.19045.3803');
  assert.strictEqual(r.build, '19045');
});

// Fałszywy executor symulujący różne hosty.
function fakeExec(map) {
  return async (cmd) => {
    for (const [key, val] of Object.entries(map)) {
      if (cmd.includes(key)) return { stdout: val, stderr: '', code: 0 };
    }
    return { stdout: '', stderr: 'not found', code: 1 };
  };
}

test('detect rozpoznaje Linux (uname) i dystrybucję', async () => {
  const exec = fakeExec({
    'uname -s': 'Linux',
    'uname -r': '5.15.0-89-generic',
    'os-release': 'ID=ubuntu\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04 LTS"',
    hostname: 'web01',
  });
  const r = await detect(exec);
  assert.strictEqual(r.os, 'linux');
  assert.strictEqual(r.distro, 'ubuntu');
  assert.strictEqual(r.hostname, 'web01');
  assert.strictEqual(r.verified, true);
});

test('detect rozpoznaje Windows (ver), gdy uname zawodzi', async () => {
  const exec = fakeExec({
    ver: 'Microsoft Windows [Version 10.0.19045.3803]',
    hostname: 'WINSRV',
  });
  const r = await detect(exec);
  assert.strictEqual(r.os, 'windows');
  assert.strictEqual(r.version, '10.0.19045.3803');
  assert.strictEqual(r.hostname, 'WINSRV');
});

test('detectAndVerify flaguje niezgodność z rejestracją', async () => {
  const exec = fakeExec({ ver: 'Microsoft Windows [Version 10.0.19045.1]' });
  const r = await detectAndVerify(exec, 'linux');
  assert.strictEqual(r.os, 'windows');
  assert.strictEqual(r.mismatch, true);
});

test('detect zwraca unknown przy braku sond', async () => {
  const r = await detect(async () => ({ stdout: '', stderr: 'x', code: 1 }));
  assert.strictEqual(r.os, 'unknown');
  assert.strictEqual(r.verified, false);
});
