const { AccessManager } = require('../access');

/**
 * ServiceManager
 * Stabilne API dla operacji na usługach:
 *  - listServices(serverId, os)
 *  - startService(serverId, serviceName, os)
 *  - stopService(serverId, serviceName, os)
 *  - restartService(serverId, serviceName, os)
 *  - installService(serverId, serviceName, servicePath, os)
 *  - uninstallService(serverId, serviceName, os)
 *
 * Implementacja opiera się o AccessManager.executeCommand i używa standardowych narzędzi:
 *  - Linux: systemctl (TODO: rozbudowa o inne init systemy)
 *  - Windows: sc
 */
class ServiceManager {
  constructor(accessManager = null, logger = null) {
    this.accessManager = accessManager || new AccessManager();
    this.logger = logger || this.accessManager.logger;
  }

  /**
   * Lista usług na serwerze
   * @param {string} serverId - ID serwera
   * @param {string} os - System operacyjny: 'windows' lub 'linux'
   * @returns {Promise<Array>} Lista usług
   */
  async listServices(serverId, os) {
    try {
      this.logger.info(`Pobieranie listy usług na serwerze ${serverId} (${os})`);

      let command;
      if (os === 'windows') {
        command = 'sc query state= all';
      } else if (os === 'linux') {
        command = 'systemctl list-units --type=service --all --no-pager';
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd wykonania polecenia: ${result.stderr}`);
      }

      // Parsowanie wyniku
      const services = this._parseServicesOutput(result.stdout, os);
      this.logger.info(`Znaleziono ${services.length} usług na serwerze ${serverId}`);
      return services;
    } catch (error) {
      this.logger.error(`Błąd pobierania listy usług na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Uruchamia usługę
   * @param {string} serverId - ID serwera
   * @param {string} serviceName - Nazwa usługi
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async startService(serverId, serviceName, os) {
    try {
      this.logger.info(`Uruchamianie usługi ${serviceName} na serwerze ${serverId}`);

      let command;
      if (os === 'windows') {
        command = `sc start "${serviceName}"`;
      } else if (os === 'linux') {
        command = `sudo systemctl start ${serviceName}`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd uruchamiania usługi: ${result.stderr}`);
      }

      this.logger.info(`Usługa ${serviceName} została uruchomiona na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd uruchamiania usługi ${serviceName} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Zatrzymuje usługę
   * @param {string} serverId - ID serwera
   * @param {string} serviceName - Nazwa usługi
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async stopService(serverId, serviceName, os) {
    try {
      this.logger.info(`Zatrzymywanie usługi ${serviceName} na serwerze ${serverId}`);

      let command;
      if (os === 'windows') {
        command = `sc stop "${serviceName}"`;
      } else if (os === 'linux') {
        command = `sudo systemctl stop ${serviceName}`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd zatrzymywania usługi: ${result.stderr}`);
      }

      this.logger.info(`Usługa ${serviceName} została zatrzymana na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd zatrzymywania usługi ${serviceName} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Restartuje usługę
   * @param {string} serverId - ID serwera
   * @param {string} serviceName - Nazwa usługi
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async restartService(serverId, serviceName, os) {
    try {
      this.logger.info(`Restartowanie usługi ${serviceName} na serwerze ${serverId}`);

      let command;
      if (os === 'windows') {
        command = `sc stop "${serviceName}" && sc start "${serviceName}"`;
      } else if (os === 'linux') {
        command = `sudo systemctl restart ${serviceName}`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd restartowania usługi: ${result.stderr}`);
      }

      this.logger.info(`Usługa ${serviceName} została zrestartowana na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd restartowania usługi ${serviceName} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Instaluje usługę
   * @param {string} serverId - ID serwera
   * @param {string} serviceName - Nazwa usługi
   * @param {string} servicePath - Ścieżka do pliku wykonywalnego
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async installService(serverId, serviceName, servicePath, os) {
    try {
      this.logger.info(`Instalowanie usługi ${serviceName} na serwerze ${serverId}`);

      let command;
      if (os === 'windows') {
        command = `sc create "${serviceName}" binPath= "${servicePath}" start= auto`;
      } else if (os === 'linux') {
        // Dla Linux zakładamy systemd service file
        command = `sudo cp ${servicePath} /etc/systemd/system/${serviceName}.service && sudo systemctl daemon-reload && sudo systemctl enable ${serviceName}`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd instalacji usługi: ${result.stderr}`);
      }

      this.logger.info(`Usługa ${serviceName} została zainstalowana na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd instalacji usługi ${serviceName} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Odinstalowuje usługę
   * @param {string} serverId - ID serwera
   * @param {string} serviceName - Nazwa usługi
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async uninstallService(serverId, serviceName, os) {
    try {
      this.logger.info(`Odinstalowywanie usługi ${serviceName} na serwerze ${serverId}`);

      let command;
      if (os === 'windows') {
        command = `sc delete "${serviceName}"`;
      } else if (os === 'linux') {
        command = `sudo systemctl stop ${serviceName} && sudo systemctl disable ${serviceName} && sudo rm /etc/systemd/system/${serviceName}.service && sudo systemctl daemon-reload`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd odinstalowywania usługi: ${result.stderr}`);
      }

      this.logger.info(`Usługa ${serviceName} została odinstalowana z serwera ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd odinstalowywania usługi ${serviceName} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parsuje wyjście polecenia listowania usług
   * @private
   * @param {string} output - Wyjście polecenia
   * @param {string} os - System operacyjny
   * @returns {Array} Lista usług w formacie { name, status, extra }
   */
  _parseServicesOutput(output, os) {
    if (os === 'windows') {
      const services = [];
      const serviceBlocks = output.split('\n\n');
      serviceBlocks.forEach(block => {
        const nameMatch = block.match(/SERVICE_NAME:\s*(.+)/);
        const stateMatch = block.match(/STATE\s+:\s*\d+\s+(.+)/);
        if (nameMatch && stateMatch) {
          services.push({
            name: nameMatch[1].trim(),
            status: stateMatch[1].trim(),
            extra: {}, // Można rozbudować o parsowanie PID, etc.
          });
        }
      });
      return services;
    }

    if (os === 'linux') {
      const services = [];
      const lines = output.split('\n');
      lines.forEach(line => {
        // Pomijamy nagłówki i puste linie
        if (line.trim() && !line.startsWith('UNIT') && !line.includes('LOAD') && line.match(/\.service/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4) {
            services.push({
              name: parts[0],
              status: parts[2], // active
              extra: {
                load: parts[1],
                sub: parts[3],
                description: parts.slice(4).join(' '),
              },
            });
          }
        }
      });
      return services;
    }

    return [];
  }
}

module.exports = ServiceManager;