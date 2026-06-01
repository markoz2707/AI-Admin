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

## Routing LLM: wewnętrzny vs zewnętrzny (z anonimizacją)

Aplikacja kieruje każde zapytanie LLM do właściwego modelu w zależności od
poufności danych — tak, aby dane wrażliwe nie wyciekały do chmury.

Komponenty (`modules/llm/`):

- `sensitivity.js` — w pełni lokalny, deterministyczny klasyfikator poufności
  (hasła/sekrety, klucze, e-maile, prywatne IP, środowisko `prod`, kontekst
  z poświadczeniami). Sama klasyfikacja nigdy nic nie wysyła na zewnątrz.
- `providers/` — wspólny interfejs providerów:
  - `openai-provider.js` — model **zewnętrzny** (OpenAI),
  - `local-provider.js` — model **wewnętrzny/lokalny** (domyślnie zgodny z
    Ollama: `http://localhost:11434`, konfigurowalny endpoint/model).
- `anonymizer.js` — **odwracalna** anonimizacja: lokalnie zamienia hosty/IP/
  e-maile/ścieżki/sekrety na placeholdery (`[[HOST_1]]`…), wysyła do
  zewnętrznego modelu tylko zanonimizowaną treść, a jego odpowiedź odtwarza
  lokalnie.
- `llm-router.js` — wybiera provider i tryb dla każdego zapytania. Jest
  „drop-in” w miejsce dawnego klienta LLM.

### Polityki (`llm.provider` w ustawieniach)

| Polityka | Zachowanie |
|---|---|
| `auto` (domyślnie) | Poufne → lokalny. Brak lokalnego, a zgoda na anonimizację → anonimizacja + zewnętrzny. W innym wypadku → odmowa wysyłki. Niepoufne → zewnętrzny. |
| `local` | Zawsze model lokalny. |
| `openai` | Zawsze model zewnętrzny (surowo). |
| `anonymize` | Zawsze zewnętrzny, ale dane poufne anonimizowane. |

Gdy danych poufnych nie da się obsłużyć bezpiecznie (brak lokalnego LLM i brak
zgody na anonimizację), router **odmawia** wysłania (`LLM_SENSITIVE_BLOCKED`)
zamiast wysyłać surowe dane na zewnątrz.

### Klucze ustawień (scope `global`)

```
llm.provider            auto | local | openai | anonymize
llm.apiKey              klucz OpenAI (przechowywany zaszyfrowany)
llm.model               model zewnętrzny, np. gpt-4o-mini
llm.allowAnonymization  bool (domyślnie true)
llm.local.enabled       bool
llm.local.baseUrl       np. http://localhost:11434
llm.local.model         np. llama3.1
```

> Anonimizacja jest dziś heurystyczna (deterministyczna, offline) i stanowi
> punkt rozszerzenia pod anonimizację wspomaganą lokalnym modelem (NER).
> Bardziej złożona orkiestracja (np. klonowanie/migracja aplikacji między
> serwerami, generowanie dokumentacji środowiska) budowana jest jako kolejna
> warstwa na tym fundamencie routingu.

## Licencja

ISC
