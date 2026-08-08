const { AccessManager } = require('../access');
const {
  shQuote,
  winCmdArg,
  assertIdentifier,
} = require('../access/shell-escape');

/**
 * UserManager
 * Stabilne API do zarządzania użytkownikami systemowymi:
 *  - listUsers(serverId, os)
 *  - addUser(serverId, username, password, os, options?)
 *  - removeUser(serverId, username, os)
 *  - changePassword(serverId, username, newPassword, os)
 *  - addToGroup(serverId, username, groupName, os)
 *  - removeFromGroup(serverId, username, groupName, os)
 *
 * Wewnętrznie używa AccessManager.executeCommand i mapuje na komendy:
 *  - Linux: useradd/userdel/chpasswd/usermod/gpasswd (TODO: doprecyzować parametry polityk)
 *  - Windows: net user / net localgroup
 * Interfejs jest przygotowany do wywołań z warstwy IPC przez ServerManager.
 */
class UserManager {
  constructor(accessManager = null, logger = null) {
    this.accessManager = accessManager || new AccessManager();
    this.logger = logger || this.accessManager.logger;
  }

  /**
   * Lista użytkowników na serwerze z pełnymi danymi.
   * @param {string} serverId - ID serwera
   * @param {string} os - System operacyjny: 'windows' lub 'linux'
   * @returns {Promise<Array>} Lista użytkowników w formacie { username, uid, gid, home, shell, groups }
   */
  async listUsers(serverId, os) {
    try {
      this.logger.info(`Pobieranie listy użytkowników na serwerze ${serverId} (${os})`);

      if (os === 'windows') {
        const command = 'wmic useraccount get name,sid';
        const result = await this.accessManager.executeCommand(serverId, command);
        if (result.code !== 0) throw new Error(`Błąd wykonania polecenia WMIC: ${result.stderr}`);
        return this._parseUsersOutput(result.stdout, os);
      }
      
      if (os === 'linux') {
        const passwdCommand = "getent passwd | cut -d: -f1,3,4,6,7";
        const passwdResult = await this.accessManager.executeCommand(serverId, passwdCommand);
        if (passwdResult.code !== 0) throw new Error(`Błąd pobierania /etc/passwd: ${passwdResult.stderr}`);
        
        let users = this._parseUsersOutput(passwdResult.stdout, os);

        // wzbogacenie informacją o grupach
        for (let i = 0; i < users.length; i++) {
          const user = users[i];
          const groupsCommand = `id -Gn ${shQuote(user.username)}`;
          const groupsResult = await this.accessManager.executeCommand(serverId, groupsCommand);
          if (groupsResult.code === 0) {
            user.groups = groupsResult.stdout.trim().split(' ');
          } else {
            user.groups = [];
          }
        }
        this.logger.info(`Znaleziono i wzbogacono ${users.length} użytkowników na serwerze ${serverId}`);
        return users;
      }

      throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
    } catch (error) {
      this.logger.error(`Błąd pobierania listy użytkowników na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Dodaje nowego użytkownika
   * @param {string} serverId - ID serwera
   * @param {string} username - Nazwa użytkownika
   * @param {string} password - Hasło
   * @param {string} os - System operacyjny
   * @param {Object} options - Dodatkowe opcje (np. { homeDir: '/home/user', shell: '/bin/bash' } dla Linux)
   * @returns {Promise<void>}
   */
  async addUser(serverId, username, password, os, options = {}) {
    try {
      this.logger.info(`Dodawanie użytkownika ${username} na serwerze ${serverId}`);

      assertIdentifier(username, 'username');

      let command;
      if (os === 'windows') {
        command = `net user ${winCmdArg(username)} ${winCmdArg(password)} /add`;
        if (options.comment) {
          command += ` /comment:${winCmdArg(options.comment)}`;
        }
      } else if (os === 'linux') {
        const homeDir = options.homeDir || `/home/${username}`;
        const shell = options.shell || '/bin/bash';
        command = `sudo useradd -m -d ${shQuote(homeDir)} -s ${shQuote(shell)} ${shQuote(username)} && echo ${shQuote(`${username}:${password}`)} | sudo chpasswd`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd dodawania użytkownika: ${result.stderr}`);
      }

      this.logger.info(`Użytkownik ${username} został dodany na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd dodawania użytkownika ${username} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Usuwa użytkownika
   * @param {string} serverId - ID serwera
   * @param {string} username - Nazwa użytkownika
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async removeUser(serverId, username, os) {
    try {
      this.logger.info(`Usuwanie użytkownika ${username} z serwera ${serverId}`);

      assertIdentifier(username, 'username');

      let command;
      if (os === 'windows') {
        command = `net user ${winCmdArg(username)} /delete`;
      } else if (os === 'linux') {
        command = `sudo userdel -r ${shQuote(username)}`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd usuwania użytkownika: ${result.stderr}`);
      }

      this.logger.info(`Użytkownik ${username} został usunięty z serwera ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd usuwania użytkownika ${username} z serwera ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Zmienia hasło użytkownika
   * @param {string} serverId - ID serwera
   * @param {string} username - Nazwa użytkownika
   * @param {string} newPassword - Nowe hasło
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async changePassword(serverId, username, newPassword, os) {
    try {
      this.logger.info(`Zmiana hasła użytkownika ${username} na serwerze ${serverId}`);

      assertIdentifier(username, 'username');

      let command;
      if (os === 'windows') {
        command = `net user ${winCmdArg(username)} ${winCmdArg(newPassword)}`;
      } else if (os === 'linux') {
        command = `echo ${shQuote(`${username}:${newPassword}`)} | sudo chpasswd`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd zmiany hasła: ${result.stderr}`);
      }

      this.logger.info(`Hasło użytkownika ${username} zostało zmienione na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd zmiany hasła użytkownika ${username} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Dodaje użytkownika do grupy
   * @param {string} serverId - ID serwera
   * @param {string} username - Nazwa użytkownika
   * @param {string} groupName - Nazwa grupy
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async addToGroup(serverId, username, groupName, os) {
    try {
      this.logger.info(`Dodawanie użytkownika ${username} do grupy ${groupName} na serwerze ${serverId}`);

      assertIdentifier(username, 'username');
      assertIdentifier(groupName, 'groupName');

      let command;
      if (os === 'windows') {
        command = `net localgroup ${winCmdArg(groupName)} ${winCmdArg(username)} /add`;
      } else if (os === 'linux') {
        command = `sudo usermod -a -G ${shQuote(groupName)} ${shQuote(username)}`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd dodawania do grupy: ${result.stderr}`);
      }

      this.logger.info(`Użytkownik ${username} został dodany do grupy ${groupName} na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd dodawania użytkownika ${username} do grupy ${groupName} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Usuwa użytkownika z grupy
   * @param {string} serverId - ID serwera
   * @param {string} username - Nazwa użytkownika
   * @param {string} groupName - Nazwa grupy
   * @param {string} os - System operacyjny
   * @returns {Promise<void>}
   */
  async removeFromGroup(serverId, username, groupName, os) {
    try {
      this.logger.info(`Usuwanie użytkownika ${username} z grupy ${groupName} na serwerze ${serverId}`);

      assertIdentifier(username, 'username');
      assertIdentifier(groupName, 'groupName');

      let command;
      if (os === 'windows') {
        command = `net localgroup ${winCmdArg(groupName)} ${winCmdArg(username)} /delete`;
      } else if (os === 'linux') {
        command = `sudo gpasswd -d ${shQuote(username)} ${shQuote(groupName)}`;
      } else {
        throw new Error(`Nieobsługiwany system operacyjny: ${os}`);
      }

      const result = await this.accessManager.executeCommand(serverId, command);

      if (result.code !== 0) {
        throw new Error(`Błąd usuwania z grupy: ${result.stderr}`);
      }

      this.logger.info(`Użytkownik ${username} został usunięty z grupy ${groupName} na serwerze ${serverId}`);
    } catch (error) {
      this.logger.error(`Błąd usuwania użytkownika ${username} z grupy ${groupName} na serwerze ${serverId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parsuje wyjście polecenia listowania użytkowników.
   * @private
   * @param {string} output - Wyjście polecenia
   * @param {string} os - System operacyjny
   * @returns {Array} Lista użytkowników. Format zależy od OS i dalszego przetwarzania.
   */
  _parseUsersOutput(output, os) {
    const users = [];
    const lines = output.split(/[\r\n]+/).filter(line => line.trim());

    if (os === 'windows') {
      // Oczekuje wyjścia z 'wmic useraccount get name,sid'
      // Name  SID
      // user1 S-1-5...
      const headerIndex = lines.findIndex(line => line.includes('Name') && line.includes('SID'));
      if (headerIndex === -1) return [];

      const nameIndex = lines[headerIndex].indexOf('Name');
      const sidIndex = lines[headerIndex].indexOf('SID');

      for (let i = headerIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > sidIndex) {
          const username = line.substring(0, sidIndex).trim();
          const sid = line.substring(sidIndex).trim();
          if (username && sid) {
            users.push({
              username,
              uid: sid,
              gid: null,
              home: null,
              shell: null,
              groups: [] // Wzbogacenie wymagałoby 'net user' dla każdego
            });
          }
        }
      }
    } else if (os === 'linux') {
      // Oczekuje wyjścia z 'getent passwd'
      lines.forEach(line => {
        const parts = line.split(':');
        if (parts.length >= 5) {
          users.push({
            username: parts[0],
            uid: parts[1],
            gid: parts[2],
            home: parts[3],
            shell: parts[4],
            groups: [] // Zostanie wzbogacone w listUsers
          });
        }
      });
    }

    return users;
  }
}

module.exports = UserManager;