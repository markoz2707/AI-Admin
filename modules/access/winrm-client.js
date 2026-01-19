const { spawn } = require('child_process');
const Logger = require('./logger');

/**
 * WinRMClient
 * A client for executing commands on a remote Windows server using PowerShell and WinRM.
 * It uses the local PowerShell `Invoke-Command` cmdlet.
 * Note: This requires PowerShell 7+ (pwsh) to be installed on the machine running this app.
 * The target Windows server must have WinRM enabled and configured.
 */
class WinRMClient {
  constructor(logger = null) {
    this.config = null;
    this.connected = false;
    this.logger = logger || new Logger('winrm-client.log');
  }

  /**
   * Stores connection configuration. Unlike SSH, WinRM is largely stateless,
   * so this method just prepares the config for subsequent 'execute' calls.
   * @param {string} host - The IP address or hostname of the target server.
   * @param {string} username - The username for authentication.
   * @param {string} password - The password for the user.
   * @param {number} port - The WinRM port (usually 5985/5986). Not directly used by Invoke-Command but stored for completeness.
   * @returns {Promise<void>}
   */
  async connect(host, username, password, port = 5985) {
    this.logger.log(`Preparing WinRM connection for ${username}@${host}`);
    if (!host || !username || !password) {
      throw new Error('Host, username, and password are required for WinRM connection.');
    }
    this.config = { host, username, password, port };
    this.connected = true; // Represents that config is ready.
    return Promise.resolve();
  }

  /**
   * Executes a command on the remote Windows server via WinRM.
   * @param {string} command - The command to execute on the remote server.
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async execute(command) {
    if (!this.isConnected()) {
      throw new Error('WinRM client is not connected. Call connect() first.');
    }

    const { host, username, password } = this.config;

    // Sanitize the command to prevent script injection issues.
    const sanitizedCommand = command.replace(/'/g, "''");

    // PowerShell script to create credentials and invoke the remote command.
    // The output is converted to JSON for easier parsing.
    const psScript = `
      $pwd = ConvertTo-SecureString '${password}' -AsPlainText -Force;
      $cred = New-Object System.Management.Automation.PSCredential('${username}', $pwd);
      $sessionOption = New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck;
      $ErrorActionPreference = "Stop";
      try {
        $result = Invoke-Command -ComputerName '${host}' -Credential $cred -Authentication Negotiate -SessionOption $sessionOption -ScriptBlock { ${sanitizedCommand} };
        $output = @{
          stdout = $result | Out-String;
          stderr = '';
          code = 0;
        }
      } catch {
        $output = @{
          stdout = '';
          stderr = $_.Exception.Message;
          code = 1;
        }
      }
      $output | ConvertTo-Json -Depth 5;
    `;

    return new Promise((resolve, reject) => {
      this.logger.log(`Executing WinRM command on ${host}: ${command}`);
      const ps = spawn('pwsh', ['-Command', psScript]);

      let stdout = '';
      let stderr = '';

      ps.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ps.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ps.on('close', (code) => {
        this.logger.log(`WinRM command finished with exit code: ${code}`);
        if (stderr && code !== 0) {
          return resolve({ stdout: '', stderr: stderr, code: 1 });
        }
        try {
          // The actual result (stdout/stderr/code) is embedded in the JSON output.
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (e) {
          // If JSON parsing fails, it indicates a more fundamental script error.
          this.logger.error(`Failed to parse WinRM JSON output. Error: ${e.message}. Raw stdout: ${stdout}`);
          resolve({ stdout: stdout, stderr: `Failed to parse JSON output. ${e.message}`, code: 1 });
        }
      });

      ps.on('error', (err) => {
        this.logger.error(`Failed to spawn PowerShell process: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * Disconnect is a no-op for the stateless Invoke-Command model.
   * Clears the configuration.
   */
  async disconnect() {
    this.logger.log(`Disconnecting from WinRM host ${this.config?.host}`);
    this.config = null;
    this.connected = false;
    return Promise.resolve();
  }

  /**
   * Checks if the client has connection configuration.
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }
}

module.exports = WinRMClient;
