/**
 * Zdalne wykrywanie systemu operacyjnego i podstawowych faktów o hoście.
 *
 * Zamiast ufać polu `os` wpisanemu przy rejestracji serwera, sondujemy hosta
 * poleceniami i parsujemy wynik. Detektor jest niezależny od kanału (SSH/WinRM):
 * próbuje sondy uniksowej (`uname`), a gdy zawiedzie — sondy Windows (`ver`).
 *
 * Warstwa parserów jest czysta (łatwa do testów); orchestracja przyjmuje
 * wstrzyknięty `execute(command) => { stdout, stderr, code }`.
 */

/** Klasyfikuje wynik `uname -s` na rodzinę systemu. */
function classifyUname(unameOut) {
  const s = String(unameOut || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('linux')) return 'linux';
  if (s.includes('darwin')) return 'darwin';
  if (s.includes('bsd')) return 'bsd';
  if (s.includes('sunos')) return 'solaris';
  return null;
}

/** Parsuje /etc/os-release (KEY=VALUE) do { id, name, versionId, prettyName }. */
function parseOsRelease(osReleaseOut) {
  const out = {};
  String(osReleaseOut || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) return;
      const key = m[1];
      const value = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      out[key] = value;
    });
  return {
    id: out.ID || null,
    name: out.NAME || null,
    versionId: out.VERSION_ID || null,
    prettyName: out.PRETTY_NAME || null,
  };
}

/** Parsuje wynik `ver` (Windows) -> { version, build }. */
function parseWindowsVer(verOut) {
  const m = String(verOut || '').match(/\[Version\s+([\d.]+)\]/i);
  if (!m) return { version: null, build: null };
  const full = m[1];
  const parts = full.split('.');
  return { version: full, build: parts.length >= 3 ? parts[2] : null };
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/)[0].trim();
}

/**
 * Wykrywa OS przez wstrzyknięty executor.
 * @param {(command:string)=>Promise<{stdout:string,stderr:string,code:number}>} execute
 * @returns {Promise<Object>} { os, family, kernel, distro, version, hostname, verified, raw }
 */
async function detect(execute) {
  const safe = async (cmd) => {
    try {
      return await execute(cmd);
    } catch (e) {
      return { stdout: '', stderr: e.message, code: 1 };
    }
  };

  // 1. Sonda uniksowa.
  const uname = await safe('uname -s');
  const family = uname.code === 0 ? classifyUname(uname.stdout) : null;

  if (family) {
    const kernel = await safe('uname -r');
    const osRelease = family === 'linux' ? await safe('cat /etc/os-release') : { stdout: '' };
    const hostname = await safe('hostname');
    const distro = parseOsRelease(osRelease.stdout);
    return {
      os: family === 'darwin' || family === 'bsd' || family === 'solaris' ? family : 'linux',
      family,
      kernel: firstLine(kernel.stdout) || null,
      distro: distro.id,
      distroName: distro.prettyName || distro.name,
      version: distro.versionId,
      hostname: firstLine(hostname.stdout) || null,
      verified: true,
      raw: { uname: firstLine(uname.stdout) },
    };
  }

  // 2. Sonda Windows.
  const ver = await safe('ver');
  const win = parseWindowsVer(ver.stdout);
  if (win.version) {
    const hostname = await safe('hostname');
    return {
      os: 'windows',
      family: 'windows',
      kernel: null,
      distro: 'windows',
      distroName: firstLine(ver.stdout) || 'Windows',
      version: win.version,
      build: win.build,
      hostname: firstLine(hostname.stdout) || null,
      verified: true,
      raw: { ver: firstLine(ver.stdout) },
    };
  }

  // 3. Nieznany.
  return {
    os: 'unknown',
    family: null,
    verified: false,
    raw: { uname: firstLine(uname.stdout), ver: firstLine(ver.stdout) },
  };
}

/**
 * Wykrywa i porównuje z oczekiwanym OS (z rejestracji).
 * @returns {Promise<Object>} wynik detect() + { expectedOs, mismatch }
 */
async function detectAndVerify(execute, expectedOs) {
  const result = await detect(execute);
  const expected = expectedOs ? String(expectedOs).toLowerCase() : null;
  return {
    ...result,
    expectedOs: expected,
    mismatch: !!(expected && result.os !== 'unknown' && result.os !== expected),
  };
}

module.exports = {
  classifyUname,
  parseOsRelease,
  parseWindowsVer,
  detect,
  detectAndVerify,
};
