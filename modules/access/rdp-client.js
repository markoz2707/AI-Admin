const { spawn } = require('child_process');
const path = require('path');
const Logger = require('./logger');

class RDPClient {
  constructor(logger = null) {
    this.process = null;
    this.connected = false;
    this.logger = logger || new Logger();
  }

  /**
   * Łączy się z serwerem RDP używając xfreerdp (dla Linux/Mac) lub mstsc (dla Windows)
   * @param {string} host - Adres IP lub nazwa hosta
   * @param {string} username - Nazwa użytkownika
   * @param {string} password - Hasło
   * @param {number} port - Port RDP (domyślnie 3389)
   * @param {Object} options - Dodatkowe opcje (np. { width: 1920, height: 1080 })
   * @returns {Promise<void>}
   */
  async connect(host, username, password, port = 3389, options = {}) {
    try {
      this.logger.log(`Próba połączenia RDP z ${username}@${host}:${port}`);

      // Sprawdź system operacyjny
      const isWindows = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      const isLinux = process.platform === 'linux';

      let command, args;

      if (isWindows) {
        // Użyj mstsc dla Windows
        command = 'mstsc';
        args = [`/v:${host}:${port}`, `/user:${username}`, `/pass:${password}`];
        if (options.width && options.height) {
          args.push(`/w:${options.width}`, `/h:${options.height}`);
        }
      } else if (isLinux || isMac) {
        // Użyj xfreerdp dla Linux/Mac
        command = 'xfreerdp';
        args = [
          `/v:${host}:${port}`,
          `/u:${username}`,
          `/p:${password}`,
          '/cert-ignore', // Ignoruj certyfikaty
          '/dynamic-resolution', // Dynamiczna rozdzielczość
        ];
        if (options.width && options.height) {
          args.push(`/w:${options.width}`, `/h:${options.height}`);
        }
      } else {
        throw new Error('Nieobsługiwany system operacyjny dla RDP');
      }

      this.logger.log(`Wykonywanie: ${command} ${args.join(' ')}`);

      // Uruchom proces w tle
      this.process = spawn(command, args, {
        detached: true,
        stdio: 'ignore'
      });

      // Odłącz proces od rodzica, aby działał niezależnie
      this.process.unref();

      // Symuluj połączenie - w rzeczywistości RDP otwiera własne okno
      this.connected = true;
      this.logger.log(`Połączono z ${host} przez RDP`);

      // Nasłuchuj na zakończenie procesu
      this.process.on('close', (code) => {
        this.logger.log(`Proces RDP zakończony z kodem: ${code}`);
        this.connected = false;
      });

      this.process.on('error', (error) => {
        this.logger.error(`Błąd procesu RDP: ${error.message}`);
        this.connected = false;
      });

    } catch (error) {
      this.logger.error(`Błąd połączenia RDP: ${error.message}`);
      throw new Error(`Nie udało się połączyć z serwerem RDP: ${error.message}`);
    }
  }

  /**
   * Rozłącza połączenie RDP
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this.process && !this.process.killed) {
      this.logger.log('Rozłączanie RDP');
      this.process.kill();
      this.connected = false;
      this.logger.log('Rozłączono');
    }
  }

  /**
   * Sprawdza status połączenia
   * @returns {boolean}
   */
  isConnected() {
    return this.connected && this.process && !this.process.killed;
  }

  /**
   * Sprawdza dostępność narzędzi RDP w systemie
   * @returns {Promise<boolean>}
   */
  static async checkAvailability() {
    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      const isLinux = process.platform === 'linux';

      let command;
      if (isWindows) {
        command = 'where';
      } else {
        command = 'which';
      }

      let tool;
      if (isWindows) {
        tool = 'mstsc';
      } else {
        tool = 'xfreerdp';
      }

      const checkProcess = spawn(command, [tool], { stdio: 'ignore' });
      checkProcess.on('close', (code) => {
        resolve(code === 0);
      });
      checkProcess.on('error', () => {
        resolve(false);
      });
    });
  }
}

module.exports = RDPClient;