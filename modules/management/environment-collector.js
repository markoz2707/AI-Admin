/**
 * Kolektor stanu środowiska serwera.
 *
 * Zbiera READ-ONLY inwentarz hosta (OS, interfejsy sieciowe, porty nasłuchu,
 * usługi, użytkownicy, pakiety) i składa go w znormalizowaną migawkę. Migawka
 * zasila zarówno migrację, jak i generowanie dokumentacji; przed wysłaniem do
 * zewnętrznego LLM można ją zanonimizować (anonymizeSnapshot).
 *
 * Warstwa parserów jest czysta (testowalna). Orchestracja przyjmuje wstrzyknięty
 * `execute(command)` oraz opcjonalne managery (services/users/packages).
 */

const osDetector = require('./os-detector');
const { Anonymizer } = require('../llm/anonymizer');
const { sanitizeValue } = require('../llm/perception-guard');

/** Parsuje porty nasłuchujące z `ss -ltnp` (Linux) lub `netstat -ano` (Windows). */
function parseListeningPorts(out, os) {
  const text = String(out || '');
  const ports = [];

  if (os === 'windows') {
    // Proto  Local Address        Foreign Address   State        PID
    text.split(/\r?\n/).forEach((line) => {
      const m = line
        .trim()
        .match(/^(TCP|UDP)\s+(\S+):(\d+)\s+\S+\s+(LISTENING|\*|\S*)\s*(\d+)?$/i);
      if (!m) return;
      const state = m[4];
      if (m[1].toUpperCase() === 'TCP' && !/listening/i.test(state)) return;
      ports.push({
        proto: m[1].toLowerCase(),
        address: m[2],
        port: Number(m[3]),
        pid: m[5] ? Number(m[5]) : null,
        process: null,
      });
    });
    return ports;
  }

  // Linux ss: "LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1234,fd=3))"
  text.split(/\r?\n/).forEach((line) => {
    if (!/^(LISTEN|UNCONN)\b/.test(line.trim())) return;
    const cols = line.trim().split(/\s+/);
    // Adres lokalny to zwykle 4. kolumna.
    const local = cols[3] || '';
    const lm = local.match(/^(.*):(\d+)$/);
    if (!lm) return;
    const procMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    ports.push({
      proto: line.includes('udp') ? 'udp' : 'tcp',
      address: lm[1],
      port: Number(lm[2]),
      pid: procMatch ? Number(procMatch[2]) : null,
      process: procMatch ? procMatch[1] : null,
    });
  });
  return ports;
}

/** Parsuje interfejsy z `ip -o -4 addr` (Linux) lub `ipconfig` (Windows). */
function parseInterfaces(out, os) {
  const text = String(out || '');
  const ifaces = [];

  if (os === 'windows') {
    let current = null;
    text.split(/\r?\n/).forEach((line) => {
      const adapter = line.match(/adapter\s+(.+):\s*$/i);
      if (adapter) {
        current = adapter[1].trim();
        return;
      }
      const ipv4 = line.match(/IPv4 Address[.\s]*:\s*([\d.]+)/i);
      if (ipv4 && current) {
        ifaces.push({ name: current, address: ipv4[1] });
      }
    });
    return ifaces;
  }

  // Linux: "2: eth0    inet 10.0.0.5/24 brd ... scope global eth0"
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+([\d.]+)\/(\d+)/);
    if (m) {
      ifaces.push({ name: m[1], address: m[2], prefix: Number(m[3]) });
    }
  });
  return ifaces;
}

/**
 * Zbiera migawkę środowiska.
 * @param {Object} params
 *  - execute: (command:string)=>Promise<{stdout,stderr,code}>  (wymagane)
 *  - server?: { id, name, host }   (metadane do migawki)
 *  - os?: string                   (jeśli znany; inaczej wykrywany)
 *  - serviceManager?, userManager?, packageManager? (opcjonalne wzbogacenie)
 *  - serverId?                     (dla managerów)
 * @returns {Promise<Object>} znormalizowana migawka
 */
async function collect(params = {}) {
  const {
    execute,
    server = {},
    serviceManager = null,
    userManager = null,
    packageManager = null,
    serverId = server.id,
  } = params;

  if (typeof execute !== 'function') {
    throw new Error('environment-collector.collect wymaga execute()');
  }

  const safe = async (cmd) => {
    try {
      return await execute(cmd);
    } catch (e) {
      return { stdout: '', stderr: e.message, code: 1 };
    }
  };

  // 1. OS (wykryty, nie z rejestracji).
  const detected = await osDetector.detectAndVerify(execute, params.os || server.os);
  const os = detected.os === 'unknown' ? (params.os || 'linux') : detected.os;

  // 2. Sieć (read-only).
  const portsOut =
    os === 'windows'
      ? await safe('netstat -ano -p tcp')
      : await safe('ss -ltnp || netstat -ltnp');
  const ifacesOut =
    os === 'windows' ? await safe('ipconfig') : await safe('ip -o -4 addr show');

  const snapshot = {
    collectedAt: new Date().toISOString(),
    server: { id: server.id || null, name: server.name || null, host: server.host || null },
    os,
    osDetails: {
      family: detected.family,
      distro: detected.distroName || detected.distro,
      version: detected.version,
      kernel: detected.kernel,
      build: detected.build,
      hostname: detected.hostname,
      verified: detected.verified,
      mismatch: detected.mismatch,
      expectedOs: detected.expectedOs,
    },
    interfaces: parseInterfaces(ifacesOut.stdout, os),
    listeningPorts: parseListeningPorts(portsOut.stdout, os),
    services: [],
    users: [],
    packages: [],
  };

  // 3. Wzbogacenie przez istniejące managery (jeśli dostarczone).
  if (serviceManager && serverId != null) {
    try {
      snapshot.services = await serviceManager.listServices(serverId, os);
    } catch (e) {
      snapshot.servicesError = e.message;
    }
  }
  if (userManager && serverId != null) {
    try {
      snapshot.users = await userManager.listUsers(serverId, os);
    } catch (e) {
      snapshot.usersError = e.message;
    }
  }
  if (packageManager && serverId != null) {
    try {
      snapshot.packages = await packageManager.listPackages(serverId, { os });
    } catch (e) {
      snapshot.packagesError = e.message;
    }
  }

  // Obrona przed zatrutą percepcją: oflaguj wartości wyglądające na próbę
  // wstrzyknięcia instrukcji (np. złośliwy hostname/nazwa usługi). Dane
  // zostają surowe, ale z ostrzeżeniem do eskalacji w pętli autonomicznej.
  const { flags } = sanitizeValue(snapshot);
  if (flags.length) {
    snapshot.perceptionWarnings = flags;
  }

  return snapshot;
}

/**
 * Zwraca zanonimizowaną kopię migawki (hosty/IP/e-maile/ścieżki -> placeholdery)
 * oraz mapę odwrotną (do lokalnego odtworzenia odpowiedzi zewnętrznego LLM).
 * Mapy NIE wolno wysyłać na zewnątrz.
 * @param {Object} snapshot
 * @returns {{ anonymized: Object, anonymizer: Anonymizer }}
 */
function anonymizeSnapshot(snapshot) {
  const anonymizer = new Anonymizer();
  const json = JSON.stringify(snapshot);
  const anonymized = JSON.parse(anonymizer.anonymize(json));
  return { anonymized, anonymizer };
}

module.exports = {
  parseListeningPorts,
  parseInterfaces,
  collect,
  anonymizeSnapshot,
};
