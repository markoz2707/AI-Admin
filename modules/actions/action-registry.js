/**
 * Rejestr typed actions — deklaratywnych akcji administracyjnych.
 *
 * Każdy typ akcji wie, jak:
 *  - rozstrzygnąć się do konkretnego polecenia (escapowanego/walidowanego),
 *  - opisać ryzyko (reversibility, blastRadius, dataLossRisk, requiresSnapshot),
 *  - dostarczyć domyślną weryfikację (`verify`) i kompensację (`compensation`).
 *
 * Dzięki temu kroki generowane przez LLM (usługa/pakiet) automatycznie zyskują
 * postcondition i rollback (działa saga + read-back), a tryb autonomiczny może
 * wymusić wyłącznie typed actions (zakaz surowych poleceń).
 *
 * Metadane ryzyka są źródłem prawdy dla przyszłego silnika autorytetu (decyzja
 * AUTONOMOUS/APPROVAL) — nie zgadujemy ryzyka po stringu.
 */

const { shQuote, winCmdArg, assertIdentifier } = require('../access/shell-escape');

const isWin = (os) => String(os).toLowerCase() === 'windows';

// Polecenie instalacji/usuwania pakietu na Linux (wykrywa menedżer).
function linuxPkg(op, pkgQuoted) {
  return (
    `if command -v apt-get >/dev/null 2>&1; then sudo apt-get ${op} -y ${pkgQuoted}; ` +
    `elif command -v dnf >/dev/null 2>&1; then sudo dnf ${op} -y ${pkgQuoted}; ` +
    `elif command -v yum >/dev/null 2>&1; then sudo yum ${op} -y ${pkgQuoted}; ` +
    `else echo "Nieznany menedżer pakietów"; exit 1; fi`
  );
}

const BUILDERS = {
  'package.install': (params, os) => {
    const name = assertIdentifierLoose(params.name, 'packageName');
    if (isWin(os)) {
      return {
        category: 'package',
        command: `choco install ${winCmdArg(name)} -y`,
        verify: `choco list --local-only ${winCmdArg(name)}`,
        compensation: `choco uninstall ${winCmdArg(name)} -y`,
        reversibility: 'reversible', blastRadius: 'single_service', dataLossRisk: 'none', requiresSnapshot: false,
      };
    }
    const q = shQuote(name);
    return {
      category: 'package',
      command: linuxPkg('install', q),
      verify: `dpkg -s ${q} >/dev/null 2>&1 || rpm -q ${q} >/dev/null 2>&1 || command -v ${q} >/dev/null 2>&1`,
      compensation: linuxPkg('remove', q),
      reversibility: 'reversible', blastRadius: 'single_service', dataLossRisk: 'none', requiresSnapshot: false,
    };
  },

  'package.remove': (params, os) => {
    const name = assertIdentifierLoose(params.name, 'packageName');
    if (isWin(os)) {
      return {
        category: 'package',
        command: `choco uninstall ${winCmdArg(name)} -y`,
        verify: null,
        compensation: `choco install ${winCmdArg(name)} -y`,
        reversibility: 'reversible', blastRadius: 'single_service', dataLossRisk: 'low', requiresSnapshot: false,
      };
    }
    const q = shQuote(name);
    return {
      category: 'package',
      command: linuxPkg('remove', q),
      verify: `! (dpkg -s ${q} >/dev/null 2>&1 || rpm -q ${q} >/dev/null 2>&1)`,
      compensation: linuxPkg('install', q),
      reversibility: 'reversible', blastRadius: 'single_service', dataLossRisk: 'low', requiresSnapshot: false,
    };
  },

  'service.start': (params, os) => serviceAction('start', params, os),
  'service.stop': (params, os) => serviceAction('stop', params, os),
  'service.restart': (params, os) => serviceAction('restart', params, os),
};

function serviceAction(action, params, os) {
  const name = assertIdentifier(params.name, 'serviceName');
  if (isWin(os)) {
    const command =
      action === 'restart'
        ? `sc stop ${winCmdArg(name)} && sc start ${winCmdArg(name)}`
        : `sc ${action} ${winCmdArg(name)}`;
    return {
      category: 'service',
      command,
      verify: action === 'stop'
        ? `sc query ${winCmdArg(name)} | findstr /I STOPPED`
        : `sc query ${winCmdArg(name)} | findstr /I RUNNING`,
      compensation: action === 'start' ? `sc stop ${winCmdArg(name)}` : action === 'stop' ? `sc start ${winCmdArg(name)}` : null,
      reversibility: 'reversible', blastRadius: 'single_service', dataLossRisk: 'none', requiresSnapshot: false,
    };
  }
  const q = shQuote(name);
  // Start/restart: usługa potrzebuje chwili i musi pozostać stabilna (anty-flapping).
  const verifyPolicy =
    action === 'stop'
      ? { attempts: 3, delayMs: 1000 }
      : { attempts: 5, delayMs: 2000, stabilizeChecks: 1, stabilizeDelayMs: 3000 };
  return {
    category: 'service',
    command: `sudo systemctl ${action} ${q}`,
    verify: action === 'stop' ? `! systemctl is-active --quiet ${q}` : `systemctl is-active --quiet ${q}`,
    verifyPolicy,
    compensation: action === 'start' ? `sudo systemctl stop ${q}` : action === 'stop' ? `sudo systemctl start ${q}` : null,
    reversibility: 'reversible', blastRadius: 'single_service', dataLossRisk: 'none', requiresSnapshot: false,
  };
}

// Nazwy pakietów bywają z '+'/':' (np. g++, lib:amd64) — łagodniejsza walidacja,
// ale bez metaznaków powłoki (i tak escapujemy).
function assertIdentifierLoose(value, label) {
  if (value == null || value === '') throw new Error(`${label} jest wymagana`);
  const s = String(value);
  if (!/^[A-Za-z0-9._+:@-]+$/.test(s)) {
    throw new Error(`Niedozwolone znaki w polu "${label}": ${s}`);
  }
  return s;
}

// Mapowanie starszych, prostych typów kroków na typed actions.
function mapLegacy(step) {
  const type = (step.type || '').toLowerCase();
  if (type === 'installation' || type === 'package') {
    return { type: 'package.install', params: { name: step.packageName || step.app || step.name } };
  }
  if (type === 'service') {
    const action = (step.action || '').toLowerCase();
    if (['start', 'stop', 'restart'].includes(action)) {
      return { type: `service.${action}`, params: { name: step.serviceName || step.name } };
    }
  }
  return null;
}

/**
 * Rozstrzyga krok/akcję do wzbogaconej postaci (command + verify + compensation
 * + metadane ryzyka). Obsługuje zarówno typy z rejestru (np. 'package.install'),
 * jak i starsze ('installation'/'service').
 *
 * @param {Object} step  – { id?, type, params?, description?, ... }
 * @param {string} os
 * @returns {{ typed:boolean, step:Object }}
 *   typed=false dla surowych poleceń ('command') — nie są typed actions.
 */
function resolve(step, os) {
  const type = (step.type || '').toLowerCase();

  // Surowe polecenie — nie jest typed action.
  if (type === 'command' || type === 'noop') {
    return { typed: false, step };
  }

  let key = step.type;
  let params = step.params || {};
  if (!BUILDERS[key]) {
    const mapped = mapLegacy(step);
    if (!mapped) {
      return { typed: false, step };
    }
    key = mapped.type;
    params = mapped.params;
  }

  const built = BUILDERS[key](params, os);
  return {
    typed: true,
    step: {
      id: step.id,
      type: key,
      description: step.description || '',
      os,
      command: built.command,
      verify: built.verify || undefined,
      verifyPolicy: built.verifyPolicy || undefined,
      compensation: built.compensation || undefined,
      metadata: {
        category: built.category,
        reversibility: built.reversibility,
        blastRadius: built.blastRadius,
        dataLossRisk: built.dataLossRisk,
        requiresSnapshot: built.requiresSnapshot,
      },
    },
  };
}

function isRegistered(type) {
  return !!BUILDERS[String(type)];
}

function listTypes() {
  return Object.keys(BUILDERS);
}

module.exports = { resolve, isRegistered, listTypes };
