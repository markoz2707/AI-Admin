const { AccessManager } = require('../access');
const {
  shQuote,
  winCmdArg,
  assertIdentifier,
} = require('../access/shell-escape');

/**
 * ShareManager
 * Stabilne API do zarządzania udziałami:
 *  - listShares(serverId, os)
 *  - createShare(serverId, shareName, sharePath, os, options?)
 *  - deleteShare(serverId, shareName, os)
 *  - modifySharePermissions(serverId, shareName, permissions, os)
 *
 * Implementacja oparta na executeCommand:
 *  - Windows: net share
 *  - Linux: smbstatus/net usershare/smb.conf (szkic, z TODO do doprecyzowania)
 * Interfejs przygotowany do wywołań przez ServerManager.
 */
class ShareManager {
  constructor(accessManager = null, logger = null) {
    this.accessManager = accessManager || new AccessManager();
    this.logger = logger || this.accessManager.logger;
  }

  /**
   * Lista udziałów na serwerze
   * @param {string} serverId - ID serwera
   * @param {string} os - System operacyjny: 'windows' lub 'linux'
   * @returns {Promise<Array>} Lista udziałów
   */
  async listShares(serverId, os) {
    try {
      this.logger.info(`Pobieranie listy udziałów na serwerze ${serverId} (${os})`);

      let command;
      if (os === 'windows') {
        command = 'net share';
      } else if (os === 'linux') {
        command = 'smbstatus --shares || net usershare list -l || showmount -e localhost';
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd wykonania polecenia: ${result.stderr}`);
      }

      const shares = this._parseSharesOutput(result.stdout, os);
      this.logger.info(`Znaleziono ${shares.length} udziałów na serwerze ${serverId}`);
      return shares;
    } catch (error) {
      this.logger.error(`Błąd pobierania listy udziałów na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Tworzy nowy udział
   * @param {string} serverId - ID serwera
   * @param {string} shareName - Nazwa udziału
   * @param {string} sharePath - Ścieżka do udostępnianego katalogu
   * @param {string} os - System operacyjny
   * @param {Object} options - Dodatkowe opcje (np. { permissions: 'read', users: ['user1', 'user2'] })
   * @returns {Promise<void>}
   */
  async createShare(serverId, shareName, sharePath, os, options = {}) {
    try {
      this.logger.info(`Tworzenie udziału ${shareName} na serwerze ${serverId}`);

      assertIdentifier(shareName, 'shareName');

      let command;
      if (os === 'windows') {
        command = `net share ${winCmdArg(`${shareName}=${sharePath}`)}`;
        if (options.permissions) {
          command += ` /grant:everyone,${assertIdentifier(options.permissions, 'permissions')}`;
        }
      } else if (os === 'linux') {
        // Dla Samba na Linux
        const permissions = assertIdentifier(
          options.permissions || '0777',
          'permissions'
        );

        // Najpierw upewnij się, że katalog istnieje
        await this.accessManager.executeCommand(
          serverId,
          `sudo mkdir -p ${shQuote(sharePath)}`
        );

        // Dodaj wpis do smb.conf (zakładamy, że Samba jest skonfigurowane).
        // shareName jest zwalidowanym identyfikatorem, sharePath cytujemy.
        const smbConfEntry = `
[${shareName}]
   path = ${sharePath}
   browseable = yes
   writable = yes
   guest ok = yes
   public = yes
   create mask = ${permissions}
   directory mask = ${permissions}
`;

        // Dodaj do konfiguracji Samba
        command = `echo ${shQuote(smbConfEntry)} | sudo tee -a /etc/samba/smb.conf > /dev/null && sudo systemctl reload smbd`;

        // Alternatywnie użyj net usershare jeśli dostępne
        // command = `net usershare add "${shareName}" "${sharePath}" "${options.description || ''}" "${users}" -f`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd tworzenia udziału: ${result.stderr}`);
      }

      this.logger.info(`Udział ${shareName} został utworzony na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd tworzenia udziału ${shareName} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Usuwa udział
   * @param {string} serverId - ID serwera
   * @param {string} shareName - Nazwa udziału
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async deleteShare(serverId, shareName, os) {
    try {
      this.logger.info(`Usuwanie udziału ${shareName} z serwera ${serverId}`);

      assertIdentifier(shareName, 'shareName');

      let command;
      if (os === 'windows') {
        command = `net share ${winCmdArg(shareName)} /delete`;
      } else if (os === 'linux') {
        // Dla Samba (shareName zwalidowany jako identyfikator – bezpieczny w sed)
        command = `sudo net usershare delete ${shQuote(shareName)} || (sudo sed -i "/\\[${shareName}\\]/,/^$/d" /etc/samba/smb.conf && sudo systemctl reload smbd)`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd usuwania udziału: ${result.stderr}`);
      }

      this.logger.info(`Udział ${shareName} został usunięty z serwera ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd usuwania udziału ${shareName} z serwera ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Modyfikuje uprawnienia udziału
   * @param {string} serverId - ID serwera
   * @param {string} shareName - Nazwa udziału
   * @param {Object} permissions - Nowe uprawnienia { user: 'username', permission: 'read|write|full' }
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async modifySharePermissions(serverId, shareName, permissions, os) {
    try {
      this.logger.info(`Modyfikacja uprawnień udziału ${shareName} na serwerze ${serverId}`);

      assertIdentifier(shareName, 'shareName');

      let command;
      if (os === 'windows') {
        const perm = permissions.permission === 'read' ? 'R' :
                    permissions.permission === 'write' ? 'C' : 'F';
        assertIdentifier(permissions.user, 'permissions.user');
        command = `net share ${winCmdArg(shareName)} /grant:${winCmdArg(`${permissions.user},${perm}`)}`;
      } else if (os === 'linux') {
        // Dla Samba - modyfikacja w smb.conf
        const permMap = {
          read: '0755',
          write: '0775',
          full: '0777'
        };
        const mask = permMap[permissions.permission] || '0755';

        command = `sudo sed -i "/\[${shareName}\]/,/^$/ { s/create mask = .*/create mask = ${mask}/; s/directory mask = .*/directory mask = ${mask}/; }" /etc/samba/smb.conf && sudo systemctl reload smbd`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd modyfikacji uprawnień: ${result.stderr}`);
      }

      this.logger.info(`Uprawnienia udziału ${shareName} zostały zmodyfikowane na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd modyfikacji uprawnień udziału ${shareName} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parsuje wyjście polecenia listowania udziałów
   * @private
   * @param {string} output - Wyjście polecenia
   * @param {string} os - System operacyjny
   * @returns {Array} Lista udziałów
   */
  _parseSharesOutput(output, os) {
    const shares = [];

    if (os === 'windows') {
      const lines = output.split('\n');
      let inShareList = false;
      lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('Share name') || line.startsWith('---')) {
          inShareList = true;
          return;
        }
        if (inShareList && line && !line.startsWith('The command completed successfully')) {
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            shares.push({
              name: parts[0],
              path: parts[1],
              remark: parts.slice(2).join(' ')
            });
          }
        }
      });
    } else if (os === 'linux') {
      const lines = output.split('\n');
      lines.forEach(line => {
        if (line.trim() && !line.startsWith('Service') && !line.startsWith('---')) {
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            shares.push({
              name: parts[0],
              path: parts[1],
              pid: parts[2] || '',
              machine: parts[3] || '',
              connected: parts[4] || ''
            });
          }
        }
      });
    }

    return shares;
  }
}

module.exports = ShareManager;