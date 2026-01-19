const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const Encryption = require('./encryption');

class Database {
    constructor(masterPassword, dbPath = path.join(__dirname, 'passwords.db')) {
        this.encryption = new Encryption(masterPassword);
        this.dbPath = dbPath;
        this.db = null;
        this.initDatabase();
    }

    initDatabase() {
        try {
            this.db = new sqlite3.Database(this.dbPath);
            this.db.run(`
                CREATE TABLE IF NOT EXISTS passwords (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    service TEXT NOT NULL,
                    username TEXT NOT NULL,
                    password TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(service, username)
                )
            `);
        } catch (error) {
            console.error('Database initialization error:', error);
            throw new Error('Failed to initialize database');
        }
    }

    storePassword(service, username, password) {
        return new Promise((resolve, reject) => {
            const encryptedPassword = this.encryption.encrypt(password);
            const query = `
                INSERT OR REPLACE INTO passwords (service, username, password, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `;
            this.db.run(query, [service, username, encryptedPassword], function(err) {
                if (err) {
                    console.error('Store password error:', err);
                    reject(new Error('Failed to store password'));
                } else {
                    resolve({ id: this.lastID });
                }
            });
        });
    }

    retrievePassword(service, username) {
        return new Promise((resolve, reject) => {
            const query = 'SELECT password FROM passwords WHERE service = ? AND username = ?';
            this.db.get(query, [service, username], (err, row) => {
                if (err) {
                    console.error('Retrieve password error:', err);
                    reject(new Error('Failed to retrieve password'));
                } else if (!row) {
                    reject(new Error('Password not found'));
                } else {
                    try {
                        const decryptedPassword = this.encryption.decrypt(row.password);
                        resolve(decryptedPassword);
                    } catch (error) {
                        reject(new Error('Failed to decrypt password'));
                    }
                }
            });
        });
    }

    changePassword(service, username, newPassword) {
        return this.storePassword(service, username, newPassword);
    }

    deletePassword(service, username) {
        return new Promise((resolve, reject) => {
            const query = 'DELETE FROM passwords WHERE service = ? AND username = ?';
            this.db.run(query, [service, username], function(err) {
                if (err) {
                    console.error('Delete password error:', err);
                    reject(new Error('Failed to delete password'));
                } else {
                    resolve({ changes: this.changes });
                }
            });
        });
    }

    close() {
        if (this.db) {
            this.db.close();
        }
    }
}

module.exports = Database;