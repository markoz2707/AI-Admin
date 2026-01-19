const { getConnection } = require('../database/database-config');
const Logger = require('../access/logger');
const ServerManager = require('./server-manager');

/**
 * PackageManager
 * Unified, defensywny wrapper do zarządzania pakietami na serwerach zdalnych.
 *
 * Założenia:
 * - Wykorzystuje istniejący ServerManager i jego AccessManager (executeCommand na aktywnym połączeniu SSH).
 * - Obsługuje typowe menedżery pakietów:
 *   - Linux: apt, yum, dnf, zypper (auto-detekcja).
 *   - Windows: choco, winget (jeśli dostępne).
 * - Wszystkie operacje:
 *   - są async/await,
 *   - zwracają plain objects,
 *   - logują sensowne informacje przez Logger i AuditLog (COMMAND_EXECUTE/PACKAGE_* po stronie wyższego poziomu).
 *
 * Kontrakt IPC (do użycia w ui/electron-main.js):
 * - packages:list { sessionToken, serverId, filter?, onlyInstalled?, page?, pageSize? }
 * - packages:install { sessionToken, serverId, name, version?, options? }
 * - packages:update { sessionToken, serverId, name, options? }
 * - packages:remove { sessionToken, serverId, name, options? }
 */

class PackageManager {
  /**
   * @param {ServerManager} serverManager
   * @param {Logger} logger
   */
  constructor(serverManager = null, logger = null) {
    this.serverManager = serverManager || new ServerManager();
    this.logger = logger || new Logger('packages.log');
  }

  async _getDb() {
    return getConnection();
  }

  async _getServer(serverId) {
    const server = await this.serverManager.getServer(serverId);
    if (!server) {
      throw new Error(`Serwer ${serverId} nie istnieje`);
    }
    if (!server.os) {
      throw new Error(
        `Serwer ${serverId} nie ma zdefiniowanego pola OS (wymagane do zarządzania pakietami)`
      );
    }
    return server;
  }

  _detectLinuxTool(os, hintOutput) {
    const lower = (hintOutput || '').toLowerCase();
    if (lower.includes('apt') || /debian|ubuntu|mint/.test(os)) return 'apt';
    if (lower.includes('dnf') || /fedora/.test(os)) return 'dnf';
    if (lower.includes('yum') || /centos|red hat|rhel/.test(os)) return 'yum';
    if (lower.includes('zypper') || /suse|opensuse/.test(os)) return 'zypper';
    return null;
  }

  _detectWindowsTool(hintOutput) {
    const lower = (hintOutput || '').toLowerCase();
    if (lower.includes('choco')) return 'choco';
    if (lower.includes('winget')) return 'winget';
    return null;
  }

  async _detectPackageTool(server) {
    const os = (server.os || '').toLowerCase();

    // Szybka heurystyka po OS:
    if (os.includes('win')) {
      // Spróbuj wykryć choco/winget jednym poleceniem
      const cmd =
        'where choco && echo HAS_CHOCO || echo NO_CHOCO & where winget && echo HAS_WINGET || echo NO_WINGET';
      try {
        const res = await this.serverManager.accessManager.executeCommand(
          server.id,
          cmd
        );
        const out = `${res.stdout || ''} ${res.stderr || ''}`.toLowerCase();
        if (out.includes('has_choco')) return 'choco';
        if (out.includes('has_winget')) return 'winget';
      } catch (e) {
        this.logger.warn(
          `Nie udało się automatycznie wykryć narzędzia pakietów dla Windows na serwerze ${server.id}: ${e.message}`
        );
      }
      // Domyślnie preferuj winget, jeśli nic nie wiadomo
      return 'winget';
    }

    // Linux
    const detectCmd =
      'command -v apt-get && echo APT || command -v dnf && echo DNF || command -v yum && echo YUM || command -v zypper && echo ZYPPER || echo NONE';
    try {
      const res = await this.serverManager.accessManager.executeCommand(
        server.id,
        detectCmd
      );
      const out = (res.stdout || '').toLowerCase();
      if (out.includes('apt')) return 'apt';
      if (out.includes('dnf')) return 'dnf';
      if (out.includes('yum')) return 'yum';
      if (out.includes('zypper')) return 'zypper';
    } catch (e) {
      this.logger.warn(
        `Nie udało się automatycznie wykryć menedżera pakietów na serwerze ${server.id}: ${e.message}`
      );
    }

    throw new Error(
      `Nieobsługiwany lub nierozpoznany menedżer pakietów na serwerze ${server.id} (${server.os})`
    );
  }

  _parseListOutput(tool, stdout, filter) {
    const lines = (stdout || '').split('\n').map((l) => l.trim());
    const items = [];

    const push = (name, version, source, description) => {
      if (!name) return;
      if (filter && !name.toLowerCase().includes(filter.toLowerCase())) {
        return;
      }
      items.push({
        name,
        version: version || null,
        source: source || tool,
        installed: true,
        description: description || null,
      });
    };

    if (tool === 'apt') {
      // dpkg -l format
      for (const line of lines) {
        if (!line || !/^[a-z]/i.test(line)) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;
        const name = parts[1];
        const version = parts[2];
        push(name, version, 'dpkg');
      }
    } else if (tool === 'yum' || tool === 'dnf') {
      // "yum list installed" / "dnf list installed"
      for (const line of lines) {
        if (!line || line.startsWith('Installed') || line.startsWith('Available'))
          continue;
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const name = parts[0].split('.')[0];
        const version = parts[1];
        push(name, version, tool);
      }
    } else if (tool === 'zypper') {
      // uproszczony parser
      for (const line of lines) {
        if (!line || line.startsWith('S |') || line.startsWith('--')) continue;
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 3) continue;
        const name = parts[1];
        const version = parts[2];
        push(name, version, 'zypper');
      }
    } else if (tool === 'choco') {
      // "choco list --local-only"
      for (const line of lines) {
        if (!line || line.startsWith('Chocolatey')) continue;
        const parts = line.split(' ');
        const name = parts[0];
        const version = parts[1];
        push(name, version, 'choco');
      }
    } else if (tool === 'winget') {
      // "winget list"
      for (const line of lines) {
        if (!line || line.toLowerCase().includes('name') && line.toLowerCase().includes('id'))
          continue;
        const parts = line.split(/\s{2,}/);
        if (parts.length < 2) continue;
        const name = parts[0].trim();
        const version = parts[1].trim();
        push(name, version, 'winget');
      }
    }

    return items;
  }

  async listPackages(serverId, options = {}) {
    const {
      filter = '',
      onlyInstalled = true, // obecnie ignorowane, bo i tak zwracamy zainstalowane
      page = 1,
      pageSize = 100,
    } = options;

    const server = await this._getServer(serverId);

    if (!this.serverManager.isServerConnected(serverId)) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }

    const tool = await this._detectPackageTool(server);

    let cmd;
    switch (tool) {
      case 'apt':
        cmd = 'dpkg -l';
        break;
      case 'yum':
        cmd = 'yum list installed';
        break;
      case 'dnf':
        cmd = 'dnf list installed';
        break;
      case 'zypper':
        cmd = 'zypper se -i';
        break;
      case 'choco':
        cmd = 'choco list --local-only';
        break;
      case 'winget':
        cmd = 'winget list';
        break;
      default:
        throw new Error(
          `Nieobsługiwany menedżer pakietów na serwerze ${serverId}: ${tool}`
        );
    }

    const res = await this.serverManager.accessManager.executeCommand(
      serverId,
      cmd
    );
    const allItems = this._parseListOutput(tool, res.stdout || '', filter || '');
    const safePageSize = Math.min(Math.max(pageSize, 1), 1000);
    const offset = (Math.max(page, 1) - 1) * safePageSize;
    const pageItems = allItems.slice(offset, offset + safePageSize);

    return {
      items: pageItems,
      total: allItems.length,
      page: Math.max(page, 1),
      pageSize: safePageSize,
    };
  }

  async installPackage(serverId, name, version = null, options = {}) {
    if (!name) throw new Error('Nazwa pakietu jest wymagana');
    const server = await this._getServer(serverId);
    if (!this.serverManager.isServerConnected(serverId)) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }
    const tool = await this._detectPackageTool(server);
    const assumeYes = options.assumeYes !== false;
    const extraArgs = Array.isArray(options.extraArgs)
      ? options.extraArgs.filter((a) => typeof a === 'string')
      : [];

    let cmd;
    switch (tool) {
      case 'apt':
        cmd = `${assumeYes ? 'sudo apt-get update && ' : ''}sudo apt-get install ${
          assumeYes ? '-y ' : ''
        }${name}${version ? '=' + version : ''}`;
        break;
      case 'yum':
      case 'dnf':
        cmd = `sudo ${tool} install ${assumeYes ? '-y ' : ''}${name}${
          version ? '-' + version : ''
        }`;
        break;
      case 'zypper':
        cmd = `sudo zypper --non-interactive install ${name}`;
        break;
      case 'choco':
        cmd = `choco install ${name} ${version ? `--version ${version}` : ''} ${
          assumeYes ? '--yes' : ''
        }`.trim();
        break;
      case 'winget':
        cmd = `winget install --id ${name} ${
          version ? `-v ${version}` : ''
        } --silent`.trim();
        break;
      default:
        throw new Error(
          `Nieobsługiwany menedżer pakietów na serwerze ${serverId}: ${tool}`
        );
    }

    if (extraArgs.length) {
      cmd += ' ' + extraArgs.join(' ');
    }

    this.logger.info(
      `Instalacja pakietu ${name} na serwerze ${serverId} przez ${tool}`
    );
    const res = await this.serverManager.accessManager.executeCommand(
      serverId,
      cmd
    );
    return res;
  }

  async updatePackage(serverId, name, options = {}) {
    if (!name) throw new Error('Nazwa pakietu jest wymagana');
    const server = await this._getServer(serverId);
    if (!this.serverManager.isServerConnected(serverId)) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }
    const tool = await this._detectPackageTool(server);
    const assumeYes = options.assumeYes !== false;

    let cmd;
    switch (tool) {
      case 'apt':
        cmd = `sudo apt-get install ${
          assumeYes ? '-y ' : ''
        }--only-upgrade ${name}`;
        break;
      case 'yum':
      case 'dnf':
        cmd = `sudo ${tool} update ${assumeYes ? '-y ' : ''}${name}`;
        break;
      case 'zypper':
        cmd = `sudo zypper --non-interactive update ${name}`;
        break;
      case 'choco':
        cmd = `choco upgrade ${name} ${assumeYes ? '--yes' : ''}`.trim();
        break;
      case 'winget':
        cmd = `winget upgrade --id ${name} --silent`.trim();
        break;
      default:
        throw new Error(
          `Nieobsługiwany menedżer pakietów na serwerze ${serverId}: ${tool}`
        );
    }

    this.logger.info(
      `Aktualizacja pakietu ${name} na serwerze ${serverId} przez ${tool}`
    );
    const res = await this.serverManager.accessManager.executeCommand(
      serverId,
      cmd
    );
    return res;
  }

  async removePackage(serverId, name, options = {}) {
    if (!name) throw new Error('Nazwa pakietu jest wymagana');
    const server = await this._getServer(serverId);
    if (!this.serverManager.isServerConnected(serverId)) {
      throw new Error(`Brak połączenia z serwerem ${serverId}`);
    }
    const tool = await this._detectPackageTool(server);
    const assumeYes = options.assumeYes !== false;
    const purge = !!options.purge;

    let cmd;
    switch (tool) {
      case 'apt':
        cmd = `sudo apt-get ${purge ? 'purge' : 'remove'} ${
          assumeYes ? '-y ' : ''
        }${name}`;
        break;
      case 'yum':
      case 'dnf':
        cmd = `sudo ${tool} remove ${assumeYes ? '-y ' : ''}${name}`;
        break;
      case 'zypper':
        cmd = `sudo zypper --non-interactive remove ${name}`;
        break;
      case 'choco':
        cmd = `choco uninstall ${name} ${assumeYes ? '--yes' : ''}`.trim();
        break;
      case 'winget':
        cmd = `winget uninstall --id ${name} --silent`.trim();
        break;
      default:
        throw new Error(
          `Nieobsługiwany menedżer pakietów na serwerze ${serverId}: ${tool}`
        );
    }

    this.logger.info(
      `Usuwanie pakietu ${name} na serwerze ${serverId} przez ${tool}`
    );
    const res = await this.serverManager.accessManager.executeCommand(
      serverId,
      cmd
    );
    return res;
  }
}

module.exports = PackageManager;