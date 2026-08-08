/**
 * Bezpieczne hashowanie haseł użytkowników aplikacji.
 *
 * Używa scrypt (wbudowany w Node.js `crypto`, memory-hard KDF) z losową solą
 * dla każdego użytkownika oraz porównaniem w czasie stałym (timing-safe).
 *
 * Format zapisu (string w kolumnie password_hash):
 *   scrypt$N$r$p$<salt_hex>$<hash_hex>
 *
 * Zachowana jest wsteczna kompatybilność z poprzednim, niebezpiecznym formatem
 * (gołe SHA-256, 64 znaki hex bez soli): takie hasła nadal można zweryfikować,
 * a funkcja needsRehash() sygnalizuje, że należy je przehashować po udanym
 * logowaniu.
 *
 * CommonJS only.
 */

const crypto = require('crypto');

// Parametry scrypt. N musi być potęgą dwójki; 2^15 = 32768 to rozsądny
// kompromis bezpieczeństwo/wydajność dla aplikacji desktopowej.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/**
 * Tworzy hash hasła w formacie scrypt$N$r$p$salt$hash.
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required for hashing');
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const derived = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // Domyślny limit (32 MB) jest zbyt niski dla 128*N*r przy N=2^15.
    maxmem: 256 * SCRYPT_N * SCRYPT_R,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/**
 * Stałoczasowe porównanie dwóch wartości hex.
 * @param {string} aHex
 * @param {string} bHex
 * @returns {boolean}
 */
function timingSafeEqualHex(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Weryfikuje hasło względem zapisanego hashu.
 * Obsługuje zarówno nowy format scrypt, jak i stary (gołe SHA-256).
 *
 * @param {string} password
 * @param {string} stored – zawartość kolumny password_hash
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  if (!password || typeof password !== 'string' || !stored) {
    return false;
  }

  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 6) {
      return false;
    }
    const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return false;
    }
    const salt = Buffer.from(saltHex, 'hex');
    let derived;
    try {
      derived = crypto.scryptSync(password, salt, hashHex.length / 2, {
        N,
        r,
        p,
        // maxmem musi pomieścić 128*N*r bajtów dla dużych N.
        maxmem: 256 * N * r,
      });
    } catch {
      return false;
    }
    return timingSafeEqualHex(derived.toString('hex'), hashHex);
  }

  // Format legacy: gołe SHA-256 (64 znaki hex, bez soli).
  if (/^[a-f0-9]{64}$/i.test(stored)) {
    const legacy = crypto
      .createHash('sha256')
      .update(password, 'utf8')
      .digest('hex');
    return timingSafeEqualHex(legacy, stored.toLowerCase());
  }

  return false;
}

/**
 * Czy zapisany hash powinien zostać przeliczony nowym algorytmem?
 * (np. zalogował się użytkownik ze starym hashem SHA-256).
 *
 * @param {string} stored
 * @returns {boolean}
 */
function needsRehash(stored) {
  if (!stored) return true;
  return !stored.startsWith('scrypt$');
}

module.exports = {
  hashPassword,
  verifyPassword,
  needsRehash,
};
