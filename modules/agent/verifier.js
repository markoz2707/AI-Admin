/**
 * Rozszerzony kontrakt weryfikacji po wykonaniu (`verify`).
 *
 * Pojedyncze uruchomienie `verify` bywa niewystarczające: usługa po starcie
 * potrzebuje chwili (retry), a „zdrowa" przez sekundę może wpaść w crash-loop
 * (flapping). Ten runner opakowuje polecenie weryfikujące o:
 *  - retry z opóźnieniem (attempts, delayMs) do pierwszego sukcesu,
 *  - kontrolę stabilności (stabilizeChecks, stabilizeDelayMs) po sukcesie,
 *  - (opcjonalnie) budżet czasu (timeoutMs).
 *
 * `run(command)->{code}` i `sleep(ms)` są wstrzykiwane — pełna testowalność bez
 * czekania w czasie rzeczywistym.
 */

function ok(res) {
  return !!(res && (res.code === 0 || res.code === undefined));
}

/**
 * @param {Object} params
 *  - command: string (polecenie verify)
 *  - run: async (command) => { code }
 *  - sleep: async (ms) => void
 *  - policy: { attempts?, delayMs?, stabilizeChecks?, stabilizeDelayMs? }
 * @returns {Promise<{ ok:boolean, attempts:number, flapping:boolean, detail?:string }>}
 */
async function verifyWithPolicy({ command, run, sleep, policy = {} }) {
  const attempts = Math.max(1, policy.attempts || 1);
  const delayMs = policy.delayMs || 0;
  const stabilizeChecks = policy.stabilizeChecks || 0;
  const stabilizeDelayMs = policy.stabilizeDelayMs || 0;

  let passed = false;
  let lastCode = null;
  let usedAttempts = 0;

  for (let i = 0; i < attempts; i++) {
    usedAttempts++;
    let res;
    try {
      res = await run(command);
    } catch (e) {
      res = { code: 1, stderr: e.message };
    }
    lastCode = res && res.code;
    if (ok(res)) { passed = true; break; }
    if (i < attempts - 1) await sleep(delayMs);
  }

  if (!passed) {
    return { ok: false, attempts: usedAttempts, flapping: false, detail: `verify zwrócił kod ${lastCode}` };
  }

  // Kontrola stabilności: verify musi pozostać zielony przez kolejne próby.
  for (let j = 0; j < stabilizeChecks; j++) {
    await sleep(stabilizeDelayMs);
    let res;
    try {
      res = await run(command);
    } catch (e) {
      res = { code: 1, stderr: e.message };
    }
    if (!ok(res)) {
      return {
        ok: false,
        attempts: usedAttempts,
        flapping: true,
        detail: 'flapping: stan niestabilny po weryfikacji',
      };
    }
  }

  return { ok: true, attempts: usedAttempts, flapping: false };
}

module.exports = { verifyWithPolicy };
