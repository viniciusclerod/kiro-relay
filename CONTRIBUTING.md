# Contributing to Kiro Relay

A language model provider for VS Code that uses **only** the `kiro-cli` authentication.

**Current stage: authentication + model catalog.** The extension reads the kiro-cli credentials
safely, has a diagnostics command and a status bar indicator, and registers the `kirorelay` model
provider, which lists the Kiro models (with thinking effort where supported) in the Chat model
picker. Chat itself does not exist yet.

## Security principles

- **Read-only and cooperative.** Kiro refresh tokens may be single-use: renewing from outside could
  invalidate the token kiro-cli keeps and sign it out. That is why the extension **never renews**
  the token. Close to expiry it re-reads the sources, because kiro-cli may already have renewed it.
- **Database snapshot.** kiro-cli's `data.sqlite3` is copied (together with the `-wal`) to a private
  temporary directory and the copy is opened. The original is never opened, so nothing is created
  or locked next to it. The copy is deleted right afterwards.
- **No secrets in logs, reports or on disk.** Diagnostics only show field names, dates and a short
  fingerprint (8 hex characters of the SHA-256).

## Language

English is the official language of the product and the code: UI source strings, logs, the
diagnostics report, comments, test names and documentation. The UI is translated to Brazilian
Portuguese:

- runtime strings: wrap them in `vscode.l10n.t('English text')` (only in `src/extension.ts`) and add
  the translation to `l10n/bundle.l10n.pt-br.json`;
- manifest strings: use `%key%` in `package.json` and add the key to `package.nls.json` and
  `package.nls.pt-br.json`.

Logs and the diagnostics report are **not** translated, so issues stay searchable. `npm test`
fails if a UI string or manifest key has no pt-BR translation.

## Development with the devcontainer (recommended)

You only need **VS Code + the Dev Containers extension + Docker**. Node is not needed on your machine.

1. Open the folder in VS Code and choose **Dev Containers: Reopen in Container**.
2. Wait for `postCreateCommand`: it runs `npm install` and installs kiro-cli in `~/.local/bin`.
3. In the container terminal, sign in (device code flow, no browser in the container):
   ```bash
   kiro-cli login --use-device-flow
   ```
   Open the URL it prints in your computer's browser and enter the code. The login lives in the
   container, so a container rebuild requires signing in again.
4. Run `npm test` and `npm run typecheck` in the terminal.
5. Follow "Testing in VS Code" below.

> **Why sign in inside the container?** In remote VS Code (devcontainer, WSL, SSH) the extension
> under development runs **inside the container** and reads files **from there**, not from your host.

## Choosing the name

```bash
npm run check-name -- "Name A" "Name B"
```

Queries the VS Code Marketplace and Open VSX (the registry used by the Kiro IDE). No results does
not mean available: the final proof is reserving the `publisher.name` ID when publishing.

## Without the devcontainer

Requirements: VS Code 1.104+, Node 22.18+ and kiro-cli installed and signed in.

## Commands

```bash
npm install
npm test            # unit tests (no network, no VS Code)
npm run typecheck   # tsc --noEmit
npm run build       # builds dist/extension.js with esbuild
```

## Testing in VS Code

1. With the folder open (in the devcontainer, if that is your setup), press **F5** ("Run
   Extension"). An **[Extension Development Host]** window opens (in the devcontainer it also runs
   inside the container).
2. In that window: `Ctrl/Cmd+Shift+P` → **Kiro Relay: Diagnose Authentication**.
3. Read the **Output → "Kiro Relay"** panel. Use "Copy report" in the notification.
4. The status bar (right side) should show something like `✓ Kiro 55 min`.
5. Open the Chat model picker: a **Kiro** group lists the models of your subscription.

To check the pt-BR translation, run **Configure Display Language**, pick `pt-br` (install the
Portuguese language pack if asked) and restart.

### Manual test plan

| # | Scenario | Expected |
|---|---|---|
| 1 | kiro-cli signed in, valid token | `✓ Kiro N min`; diagnostics say "OK: got a valid token" |
| 2 | `kiro-cli logout`, then **Kiro Relay: Reload Credentials** | `⚠ Kiro: sign-in required`; diagnostics list what was searched and where |
| 3 | `kiro-cli login --use-device-flow` (in the devcontainer), then **Reload Credentials** | back to `✓` |
| 4 | Token expired without using kiro-cli | `⚠ Kiro: token expired` |
| 5 | `kiro-cli whoami` after expiry, then **Reload Credentials** | back to `✓` (kiro-cli renews the token once it has expired) |
| 6 | Check that the extension does not touch kiro-cli | list the database directory before/after: no new files; `kiro-cli` stays signed in |
| 7 | Settings: `kirorelay.auth.sources = ["sso-cache"]` | only the JSON source is used |
| 8 | Settings: `kirorelay.auth.databasePath` pointing elsewhere | diagnostics show the new candidate |
| 9 | Chat model picker → a Claude or GPT model → Details | a **Thinking Effort** menu with the model's levels |

### If something fails

- **`node:sqlite: UNAVAILABLE`** in the diagnostics: the Node bundled with your VS Code version does
  not have the module. Open an issue with the report; the plan is a `sql.js` fallback.
- **Database not found**: set `kirorelay.auth.databasePath` and run the diagnostics again.
- More details: `Developer: Toggle Developer Tools` (Console tab) and `Developer: Show Running Extensions`.

## Layout

```
src/
  extension.ts          # commands, status bar, model provider (the only file that imports 'vscode')
  auth/
    credentials.ts      # tolerant parsing (snake_case/camelCase, timestamps with nanoseconds)
    sqliteSnapshot.ts   # snapshot + node:sqlite
    kiroCliDb.ts        # source: kiro-cli database (+ inspection for diagnostics)
    ssoCache.ts         # source: ~/.aws/sso/cache/kiro-auth-token.json
    tokenProvider.ts    # cooperative provider (cache, re-read, single-flight)
    diagnose.ts         # report without secrets
    factory.ts, paths.ts, errors.ts, redact.ts, source.ts
  models/
    catalog.ts          # ListAvailableModels client, cache, conversion to the VS Code format
    effort.ts           # thinking effort per model
l10n/                   # runtime UI translations (bundle.l10n.pt-br.json)
package.nls*.json       # manifest translations
test/                   # node:test, runs without VS Code
```

## Next steps

1. Chat with text only (streaming), sending the chosen thinking effort.
2. Tool calling and images.
3. Token renewal through kiro-cli (deferred), icon, publishing (Marketplace + Open VSX).
