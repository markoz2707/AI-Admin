/**
 * Guardrail poleceń — warstwa bezpieczeństwa między planem LLM a wykonaniem.
 *
 * Ocenia pojedyncze polecenie powłoki i przypisuje:
 *  - risk: 'low' | 'medium' | 'high' | 'critical'
 *  - allowed: boolean (false dla 'critical' — polecenie zablokowane)
 *  - violations: lista dopasowanych reguł (powód + waga)
 *
 * Zasada: polecenia 'critical' są BLOKOWANE (nie wykonujemy nigdy automatycznie),
 * 'high' wymagają jawnego zatwierdzenia, 'medium'/'low' mogą iść w trybie auto.
 *
 * Reguły obejmują Linux/Unix oraz Windows/PowerShell (oceniane łącznie — brak
 * fałszywych negatywów, gdy OS nie jest pewny). Implementacja deterministyczna
 * i offline.
 */

const SEVERITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

// Wzorce blokujące (krytyczne) — nieodwracalna destrukcja / utrata danych.
const CRITICAL_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*\s+)?(\/|\/\*|~\/?|\$HOME)(\s|$)/, reason: 'rm na katalogu głównym/HOME' },
  { re: /\brm\s+-[a-zA-Z]*\s+(\/etc|\/var|\/usr|\/bin|\/sbin|\/boot|\/lib)\b/, reason: 'rm na katalogu systemowym' },
  { re: /\bfind\s+\/(etc|var|usr|bin|sbin|boot|lib)?\b[^\n]*-delete\b/, reason: 'find -delete na katalogu systemowym' },
  { re: /\bmkfs(\.\w+)?\b/, reason: 'formatowanie systemu plików' },
  { re: /\bmke2fs\b/, reason: 'formatowanie systemu plików' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(disk|sd|nvme|vd|hd|mapper)/, reason: 'dd zapisujący na urządzenie blokowe' },
  { re: /\bwipefs\b/, reason: 'kasowanie sygnatur FS' },
  { re: />\s*\/dev\/(sd|nvme|vd|hd)/, reason: 'nadpisanie urządzenia blokowego' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: 'fork bomb' },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|d)?sh\b/, reason: 'pobieranie i wykonanie przez potok do powłoki' },
  { re: /\b(ba|z)?sh\s+-c\s+["']?\$\(\s*(curl|wget)/, reason: 'wykonanie pobranego skryptu w pętli powłoki' },
  { re: /\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(ba|z|d)?sh\b/, reason: 'dekodowanie base64 do powłoki' },
  { re: /\bchmod\s+-R\s+0?777\s+\//, reason: 'rekurencyjne chmod 777 od katalogu głównego' },
  { re: />\s*\/etc\/passwd\b/, reason: 'nadpisanie /etc/passwd' },
  // Windows / PowerShell
  { re: /\bformat\s+[a-zA-Z]:/i, reason: 'format dysku (Windows)' },
  { re: /\bFormat-Volume\b/i, reason: 'formatowanie wolumenu (Windows)' },
  { re: /\bClear-Disk\b/i, reason: 'czyszczenie dysku (Windows)' },
  { re: /\bdiskpart\b/i, reason: 'diskpart (Windows)' },
  { re: /\bRemove-Item\b[^\n]*-Recurse\b[^\n]*-Force\b[^\n]*[A-Za-z]:\\\\?(\s|$|\*)/i, reason: 'rekurencyjne usuwanie od katalogu głównego (Windows)' },
  { re: /\bdel\s+\/[sf]\s+\/q\s+[a-zA-Z]:\\/i, reason: 'masowe usuwanie (Windows)' },
  // Anonimizacja: nieodtworzony placeholder nie może trafić do wykonania.
  { re: /\[\[[A-Z]+_\d+\]\]/, reason: 'nieodtworzony placeholder anonimizacji' },
];

// Wzorce wysokiego ryzyka — wymagają zatwierdzenia (ale są wykonywalne).
const HIGH_PATTERNS = [
  { re: /\brm\s+-[a-zA-Z]*r/, reason: 'rekurencyjne usuwanie plików' },
  { re: /\bshred\b/, reason: 'bezpieczne kasowanie pliku (shred)' },
  { re: /\b(userdel|deluser|groupdel)\b/, reason: 'usuwanie konta/grupy' },
  { re: /\biptables\s+-F\b/, reason: 'wyczyszczenie reguł firewalla' },
  { re: /\bufw\s+disable\b/, reason: 'wyłączenie firewalla (ufw)' },
  { re: /\bnetsh\s+advfirewall\s+set\b[^\n]*\bstate\s+off/i, reason: 'wyłączenie firewalla (Windows)' },
  { re: /\bSet-NetFirewallProfile\b[^\n]*-Enabled\s+False/i, reason: 'wyłączenie firewalla (Windows)' },
  { re: /\bDisable-NetAdapter\b/i, reason: 'wyłączenie karty sieciowej (Windows)' },
  { re: /\bsystemctl\s+(stop|disable|mask)\b/, reason: 'zatrzymanie/wyłączenie usługi' },
  // Restart/wyłączenie hosta — wysokie ryzyko, ale dopuszczalne po zatwierdzeniu
  // (spójne z polityką APPROVAL, nie FORBIDDEN).
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'wyłączenie/restart hosta' },
  { re: /\binit\s+0\b/, reason: 'init 0 (zatrzymanie)' },
  { re: /\b(Stop-Computer|Restart-Computer)\b/i, reason: 'wyłączenie/restart hosta (Windows)' },
  { re: /\bRemove-Item\b[^\n]*-Recurse\b/i, reason: 'rekurencyjne usuwanie (Windows)' },
  { re: /\b(drop\s+database|truncate\s+table)\b/i, reason: 'destrukcyjna operacja SQL' },
  { re: /\bsudo\b/, reason: 'podniesienie uprawnień (sudo)' },
  { re: />\s*\/etc\//, reason: 'zapis do katalogu /etc' },
  { re: /\bpasswd\b/, reason: 'zmiana hasła systemowego' },
];

// Wzorce średniego ryzyka — zmiany stanu, ale typowe i odwracalne.
const MEDIUM_PATTERNS = [
  { re: /\b(apt-get|apt|yum|dnf|zypper|choco|winget)\s+(install|remove|update|upgrade)\b/i, reason: 'operacja na pakietach' },
  { re: /\bsystemctl\s+(start|restart|reload|enable)\b/, reason: 'zarządzanie usługą' },
  { re: /\bsc\s+(start|stop|create|delete|config)\b/i, reason: 'zarządzanie usługą (Windows)' },
  { re: /\b(cp|mv|tee|sed\s+-i|mkdir|usermod|useradd|gpasswd)\b/, reason: 'modyfikacja plików/użytkowników' },
];

function maxSeverity(a, b) {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/**
 * Ocena pojedynczego polecenia.
 * @param {string} command
 * @param {Object} [opts] – { os } (informacyjnie; reguły OS oceniane łącznie)
 * @returns {{ command:string, risk:string, allowed:boolean, os:string|null, violations:Array<{reason:string,severity:string}> }}
 */
function evaluateCommand(command, opts = {}) {
  const cmd = String(command || '');
  const violations = [];
  let risk = 'low';

  if (!cmd.trim()) {
    return {
      command: cmd,
      risk: 'high',
      allowed: false,
      os: opts.os || null,
      violations: [{ reason: 'puste polecenie', severity: 'high' }],
    };
  }

  for (const { re, reason } of CRITICAL_PATTERNS) {
    if (re.test(cmd)) {
      violations.push({ reason, severity: 'critical' });
      risk = maxSeverity(risk, 'critical');
    }
  }
  for (const { re, reason } of HIGH_PATTERNS) {
    if (re.test(cmd)) {
      violations.push({ reason, severity: 'high' });
      risk = maxSeverity(risk, 'high');
    }
  }
  for (const { re, reason } of MEDIUM_PATTERNS) {
    if (re.test(cmd)) {
      violations.push({ reason, severity: 'medium' });
      risk = maxSeverity(risk, 'medium');
    }
  }

  return {
    command: cmd,
    risk,
    allowed: risk !== 'critical',
    os: opts.os || null,
    violations,
  };
}

/**
 * Ocena listy kroków planu. Każdy krok z polem `command` jest oceniany.
 * @param {Array<{command?:string, os?:string}>} steps
 * @param {Object} [opts] – { os }
 * @returns {{ steps:Array, maxRisk:string, hasBlocked:boolean, requiresApproval:boolean }}
 */
function evaluatePlan(steps = [], opts = {}) {
  let maxRisk = 'low';
  let hasBlocked = false;
  let requiresApproval = false;

  const evaluated = steps.map((step) => {
    if (!step || !step.command) {
      return { ...step, guard: { risk: 'low', allowed: true, violations: [] } };
    }
    const guard = evaluateCommand(step.command, { os: step.os || opts.os });
    maxRisk = maxSeverity(maxRisk, guard.risk);
    if (!guard.allowed) hasBlocked = true;
    if (guard.risk === 'high') requiresApproval = true;
    return { ...step, guard };
  });

  return { steps: evaluated, maxRisk, hasBlocked, requiresApproval };
}

module.exports = {
  evaluateCommand,
  evaluatePlan,
  SEVERITY_ORDER,
};
