# Contributing to Kiro Relay

A language model provider for VS Code that uses **only** the `kiro-cli` authentication.

**Current stage: preview.** The extension reads kiro-cli credentials safely, offers diagnostics and a
status panel, and registers the `kirorelay` model provider. Kiro models (with thinking effort where
supported) appear in the Chat model picker and answer with streaming text, tool calls and images.

## Security principles

- **Read-only and cooperative.** Kiro refresh tokens may be single-use: renewing from outside could
  invalidate the token kiro-cli keeps and sign it out. That is why the extension **never refreshes**
  the token itself. Close to expiry it re-reads the sources, because kiro-cli may already have
  renewed it; once it has expired, it runs `kiro-cli whoami` (`kirorelay.auth.renewCommand`), which
  makes kiro-cli renew its own token, and re-reads. The command's output is never logged.
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

### Testing CLI installation from the extension

The devcontainer installs kiro-cli by default. To test the extension's missing-CLI installation
flow with **F5**, set `KIRO_RELAY_INSTALL_CLI` to `"0"` in `remoteEnv` in
[devcontainer.json](.devcontainer/devcontainer.json), then rebuild the container. The post-create
script still installs npm dependencies, but skips kiro-cli. In the Extension Development Host,
run **Kiro Relay: Sign In** and confirm the installation when prompted.

Set the variable back to `"1"` to restore automatic installation. When running the post-create
script directly, the variable defaults to `1` if unset; only `0` and `1` are accepted.
Disabling installation does not remove an existing CLI or sign out an existing session, so use
a fresh container without a CLI installation to exercise the missing-CLI flow.
`KIRO_CLI_SKIP_SETUP=1` is separate: it is passed to Kiro's installer to skip its setup step,
not to disable installation.

## Choosing the name

```bash
npm run check-name -- "Name A" "Name B"
```

Queries the VS Code Marketplace and Open VSX (the registry used by the Kiro IDE). No results does
not mean available: the final proof is reserving the `publisher.name` ID when publishing.

## Without the devcontainer

Requirements: VS Code 1.106+, Node 22.18+ and kiro-cli installed and signed in.

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
4. The status bar should show the Kiro logo. Click it to open or close the Kiro Relay panel in the
  secondary side bar; hover it to see token and session expiry.
5. Open the Chat model picker: a **Kiro** group lists the models of your subscription.

To check the pt-BR translation, run **Configure Display Language**, pick `pt-br` (install the
Portuguese language pack if asked) and restart.

### Manual test plan

| # | Scenario | Expected |
|---|---|---|
| 1 | kiro-cli signed in, valid token | logo only; hover shows token/session expiry; diagnostics say "OK: got a valid token" |
| 2 | `kiro-cli logout`, then **Kiro Relay: Reload Credentials** | logo + ⚠; the panel and menu say "Kiro: sign-in required" and offer **Sign in with kiro-cli**; diagnostics list what was searched and where |
| 3 | `kiro-cli login --use-device-flow` (in the devcontainer), then **Reload Credentials** | panel returns to signed in; status bar shows logo only |
| 4 | Token expired without using kiro-cli | logo + ⚠ ("Kiro: token expired" in the panel and menu) |
| 5 | Wait until the token expires, without using kiro-cli | within a minute the panel shows the renewed token; the log shows `renewal: ran "kiro-cli whoami" (exit 0, …)` |
| 5b | `kirorelay.auth.renewCommand = []`, token expired | logo + ⚠ ("Kiro: token expired" in the menu) until you use kiro-cli |
| 6 | Check that the extension does not touch kiro-cli | list the database directory before/after: no new files; `kiro-cli` stays signed in |
| 7 | Settings: `kirorelay.auth.sources = ["sso-cache"]` | only the JSON source is used |
| 8 | Settings: `kirorelay.auth.databasePath` pointing elsewhere | diagnostics show the new candidate |
| 9 | Chat model picker → a Claude or GPT model → Details | a **Thinking Effort** menu with the model's levels |
| 9b | Click the status bar item; then hover it | panel shows plan, credits, progress, reset time and actions; hover shows token and session expiry only |
| 10 | Ask mode, a Kiro model, "hi" | streamed answer; the output panel logs `chat done: END_TURN, … credits` |
| 11 | Agent mode, a Kiro model, "read package.json and tell me the version" | the model calls a tool, VS Code runs it, the model answers |
| 12 | Attach an image to a model with image input | the answer describes the image |

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
  chat/
    eventstream.ts      # AWS event stream decoder (no dependencies)
    request.ts          # GenerateAssistantResponse body + the backend's structural rules
    response.ts         # stream events -> text / reasoning / tool calls / usage
    client.ts           # HTTP call, retries only before the first output
    vscodeMessages.ts   # VS Code messages -> neutral messages (by shape, testable without VS Code)
  kiro/api.ts           # shared HTTP error and host helpers
  kiro/usage.ts         # GetUsageLimits client, parsing, cache
  models/
    catalog.ts          # ListAvailableModels client, cache, conversion to the VS Code format
    effort.ts           # thinking effort per model
l10n/                   # runtime UI translations (bundle.l10n.pt-br.json)
package.nls*.json       # manifest translations
test/                   # node:test, runs without VS Code
```

## Releasing

Releases are automatic (`.github/workflows/release.yml`). On every push to `main`, the version in
`package.json` is built, tested and packaged. The workflow creates the GitHub release and
attaches the VSIX before independently attempting each enabled registry. It can also be
started manually with `workflow_dispatch`.

| Repository Variable | Secret | Registry |
|---|---|---|
| `VSCE_ENABLE=true` | `VSCE_PAT` | VS Code Marketplace (Azure DevOps token, scope *Marketplace > Manage*) |
| `OVSX_ENABLE=true` | `OVSX_PAT` | Open VSX (access token for the publisher namespace) |

- A registry is skipped unless its enable variable is exactly `true` and its token is set.
  Build, packaging and GitHub release creation still run without marketplace tokens.
- One registry failing does not stop the other; the job then fails and can be re-run.
- Each registry skips a version it already has (`--skip-duplicate`), so adding the second token
  and enabling that registry later can publish the current version there too.
- The `v<version>` tag and a GitHub release (with the `.vsix` and the matching `CHANGELOG.md`
  section) are created once, before marketplace publishing. Re-running attaches a missing
  VSIX but does not replace an existing release asset or update its notes.
- `preview: true` in `package.json` marks the GitHub release as a prerelease.

To release a new version:

1. `npm version <x.y.z> --no-git-tag-version` (updates `package.json` and `package-lock.json`).
2. Add a `## <x.y.z> — <date>` section to `CHANGELOG.md`.
3. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build` and `npm run package`.
4. Configure the repository variables and secrets for the desired registries, then merge to `main`.

Global Azure DevOps PATs ("All accessible organizations") stop working on December 1, 2026; the
long-term replacement is Microsoft Entra ID (`vsce publish --azure-credential`).

## Next steps

1. Local output cap, retry without reasoning on `THINKING_SIGNATURE_INVALID`, better token counting.
2. Icon, publishing (Marketplace + Open VSX).
