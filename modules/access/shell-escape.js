/**
 * Narzędzia do bezpiecznego budowania zdalnych poleceń.
 *
 * Wartości pochodzące od użytkownika (nazwy użytkowników, hasła, nazwy usług,
 * ścieżki itp.) NIGDY nie mogą być wstawiane bez escapowania do poleceń
 * powłoki — w przeciwnym razie powstaje podatność na wstrzyknięcie poleceń
 * (command injection), pozwalająca na wykonanie dowolnego kodu na zdalnym
 * serwerze.
 *
 * Ten moduł udostępnia:
 *  - shQuote(value)        – cytowanie dla powłok POSIX (sh/bash) → SSH/Linux
 *  - psSingleQuote(value)  – cytowanie literału single-quoted w PowerShell → WinRM
 *  - winCmdArg(value)      – cytowanie argumentu dla cmd.exe (net/sc) → Windows
 *  - assertIdentifier(v)   – walidacja prostych identyfikatorów (allowlist)
 *
 * CommonJS only.
 */

/**
 * Cytuje wartość dla powłok POSIX (sh/bash).
 * Owija całość w pojedyncze cudzysłowy i bezpiecznie obsługuje wewnętrzne `'`.
 * Wynik można bezpiecznie wkleić jako pojedynczy argument polecenia.
 *
 * @param {string|number} value
 * @returns {string}
 */
function shQuote(value) {
  const str = String(value);
  // Zamień każdy ' na '\'' (zamknij quote, wstaw escaped ', otwórz quote).
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * Cytuje wartość jako literał w pojedynczych cudzysłowach PowerShell.
 * W PowerShell wewnętrzny apostrof escapuje się przez jego podwojenie.
 *
 * @param {string|number} value
 * @returns {string} np. 'O''Brien'
 */
function psSingleQuote(value) {
  const str = String(value);
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Cytuje pojedynczy argument dla cmd.exe / poleceń typu `net`, `sc`.
 * Owija w cudzysłowy i escapuje wewnętrzne `"`.
 * Odrzuca znaki sterujące i metaznaki cmd, których nie da się bezpiecznie
 * przekazać przez cudzysłowy (`%`, `!`, znaki nowej linii).
 *
 * @param {string|number} value
 * @returns {string}
 */
function winCmdArg(value) {
  const str = String(value);
  if (/[\r\n\0%!]/.test(str)) {
    throw new Error('Niedozwolone znaki w argumencie polecenia Windows');
  }
  // Podwój backslashe poprzedzające cudzysłów oraz escapuj cudzysłowy.
  const escaped = str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Waliduje prosty identyfikator (nazwa użytkownika, usługi, grupy).
 * Dopuszcza wyłącznie znaki bezpieczne i typowe dla nazw systemowych.
 * Rzuca błąd, gdy wartość zawiera cokolwiek spoza allowlisty.
 *
 * @param {string} value
 * @param {string} [label='wartość'] – etykieta do komunikatu błędu
 * @returns {string} zwalidowana wartość
 */
function assertIdentifier(value, label = 'wartość') {
  if (value === null || value === undefined || value === '') {
    throw new Error(`${label} jest wymagana`);
  }
  const str = String(value);
  // Litery, cyfry oraz . _ - @ \ (dla DOMAIN\\user). Bez spacji i metaznaków.
  if (!/^[A-Za-z0-9._@\\-]+$/.test(str)) {
    throw new Error(`Niedozwolone znaki w polu "${label}": ${str}`);
  }
  if (str.length > 256) {
    throw new Error(`${label} jest zbyt długa`);
  }
  return str;
}

module.exports = {
  shQuote,
  psSingleQuote,
  winCmdArg,
  assertIdentifier,
};
