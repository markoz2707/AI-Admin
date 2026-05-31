# AI-Admin

Desktopowa aplikacja (Electron + React) do zarządzania serwerami Linux i Windows
przez **SSH / WinRM / RDP**, z integracją **LLM** (OpenAI) do generowania i
wykonywania zadań administracyjnych, wbudowanym **managerem haseł**, kontrolą
dostępu **RBAC** oraz **audytem** operacji.

> Projekt architektoniczny i decyzje technologiczne opisuje [`plan.md`](./plan.md).

## Funkcje

- **Dostęp do serwerów**: SSH (Linux), WinRM (Windows, przez PowerShell),
  RDP (uruchamianie klienta systemowego).
- **Zarządzanie**: usługi (`systemctl`/`sc`), użytkownicy systemowi, udziały
  sieciowe (Samba / `net share`), pakiety, logi.
- **Integracja LLM**: analiza promptu i generowanie planu zadań do wykonania.
- **Manager haseł / poświadczeń**: szyfrowane przechowywanie sekretów (AES-256-GCM).
- **RBAC**: role `admin` / `operator` / `readonly` egzekwowane na warstwie IPC.
- **Audyt**: zapis operacji do `audit_log` z redagowaniem danych wrażliwych.

## Architektura

```
ui/                     Electron + React (proces główny, preload, komponenty)
  electron-main.js      Proces główny: okno, IPC, bootstrap, RBAC
  preload.js            Bezpieczny most contextBridge -> window.api
modules/
  access/               SSH/WinRM/RDP, AccessManager, logger, RBAC, shell-escape
  management/           Server/Service/User/Share/Package/Logs managery
  llm/                  Klient OpenAI, prompt-processor, task-generator
  password-manager/     Generator i szyfrowanie sekretów
  database/             Konfiguracja SQLite, migracje, szyfrowanie, sync
  auth/ session/        Użytkownicy aplikacji, hashowanie haseł, sesje
  settings/ audit/ history/  Repozytoria
```

Backend jest w CommonJS i wołany z procesu głównego Electrona przez kanały IPC.
Każdy kanał przechodzi walidację uprawnień (`modules/access/rbac.js`).

## Wymagania

- Node.js >= 18
- (opcjonalnie) PowerShell 7+ (`pwsh`) na maszynie hosta dla połączeń WinRM
- (opcjonalnie) klient RDP (`mstsc` na Windows, `xfreerdp` na Linux)

## Uruchomienie

```bash
npm install            # zależności backendu
cd ui && npm install   # zależności UI (React/Electron)
cd ..
npm start              # uruchamia aplikację Electron
```

Bazę SQLite (`ai-admin.sqlite`) tworzy automatycznie menedżer migracji przy
pierwszym starcie. Ścieżkę można nadpisać zmienną `AI_ADMIN_DB_PATH`.

Przy pierwszym uruchomieniu, jeśli tabela użytkowników jest pusta, tworzony jest
konto `admin` z losowym hasłem wypisanym w logu — **zmień je po pierwszym
zalogowaniu**.

## Testy

```bash
npm test
```

Testy (Node.js wbudowany test runner) pokrywają newralgiczne moduły
bezpieczeństwa: escapowanie powłoki, hashowanie haseł i szyfrowanie sekretów.

## Bezpieczeństwo

- **Hasła użytkowników aplikacji** są hashowane algorytmem **scrypt** z losową
  solą i porównywane w czasie stałym. Stare hashe SHA-256 są weryfikowane dla
  kompatybilności i transparentnie przehashowywane po udanym logowaniu.
- **Sekrety/poświadczenia** szyfrowane są **AES-256-GCM** (klucz z `ENCRYPTION_KEY`
  lub pliku `.encryption-key`, który nie trafia do repozytorium).
- **Polecenia zdalne** budowane są wyłącznie z escapowaniem powłoki
  (`modules/access/shell-escape.js`): wartości użytkownika są cytowane, a proste
  identyfikatory (nazwy usług, użytkowników, grup, udziałów) walidowane allowlistą —
  co eliminuje wstrzykiwanie poleceń (command injection).
- **Okno Electron**: `contextIsolation`, `sandbox`, brak `nodeIntegration`,
  blokada nawigacji/nowych okien oraz nagłówek **Content-Security-Policy**.

### Konfiguracja klucza szyfrowania

```bash
export ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

Jeśli zmienna nie jest ustawiona, klucz zostanie wygenerowany i zapisany do
`.encryption-key` (uprawnienia `600`). Plik ten jest w `.gitignore` i **nie może**
trafić do repozytorium.

## Licencja

ISC
