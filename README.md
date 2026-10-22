<p align="center">
  <img src="media/icon.png" width="96" alt="Kiro Relay">
</p>

# Kiro Relay

**Use the models of your Kiro subscription in VS Code Chat**, signed in through the `kiro-cli` you
already use. Claude, GPT, Qwen, DeepSeek and every other model of your plan show up in the Chat
model picker, with streaming answers, Agent mode tools, images and thinking effort.

> **Unofficial.** Kiro Relay is a community project. It is not affiliated with, endorsed by, or
> sponsored by Amazon Web Services or Kiro. "Kiro" is a trademark of its respective owner.

> **Preview.** Kiro Relay talks to Kiro's backend the way the Kiro tools do. That interface is not
> a public API and may change without notice.

## Features

- **Kiro models in the Chat model picker**, under a **Kiro** group, with their context window,
  maximum output and credit multiplier.
- **Chat with streaming**, in Ask and **Agent mode**: tool calls (read files, run terminal commands,
  edit code…) and **images** for the models that accept them.
- **Thinking effort per model** (Low … Max) from the model picker, for the models that support it.
- **Status bar panel** with your plan, **credits used** (with a progress bar and the reset date),
  the last interaction (credits, context used), and how long the token and the Kiro session last.
- **No extra login.** Kiro Relay uses the credentials of `kiro-cli` and, when the token expires,
  asks `kiro-cli` to renew it. When the Kiro session ends, one click opens `kiro-cli login`.
- **English and Brazilian Portuguese**, following the VS Code display language.

## Getting started

1. Install [`kiro-cli`](https://kiro.dev/docs/cli/) and sign in:
   ```bash
   kiro-cli login
   ```
   In a Dev Container, over SSH or in WSL, sign in **inside** that environment with
   `kiro-cli login --use-device-flow`.
2. Install **Kiro Relay**.
3. Open **Chat**, open the model picker and pick a model from the **Kiro** group. If the group is
   not visible, choose **Manage Models…** and enable the Kiro models.
4. Hover the Kiro Relay icon in the status bar to see your credits; click it to refresh.

## Requirements

- **VS Code 1.104 or newer.** VS Code 1.142 or newer is recommended: the thinking effort menu, the
  model icons and the reasoning display use features that older versions ignore.
- **`kiro-cli`** installed and signed in, with a Kiro subscription (Kiro Pro through IAM Identity
  Center, or Builder ID / Google / GitHub).

## How it works

- **Read-only credentials.** Kiro Relay reads the token that `kiro-cli` stores on your machine. It
  works on a **snapshot** of the `kiro-cli` database, deleted right after reading, and never writes
  to `kiro-cli`'s files.
- **Never refreshes the token itself.** Kiro refresh tokens may be single-use, so refreshing from
  outside could sign `kiro-cli` out. When the token has expired, Kiro Relay runs `kiro-cli whoami`,
  which makes `kiro-cli` renew its own token, and reads it again (`kirorelay.auth.renewCommand`).
- **Kiro session.** An IAM Identity Center session lasts 8 hours by default. When it ends, the
  status bar shows a warning and **Sign In** opens `kiro-cli login` in a terminal.

## Privacy and network

- Kiro Relay connects **only to Kiro**: `management.<region>.kiro.dev` (model list, credit usage)
  and `runtime.<region>.kiro.dev` (chat).
- It runs **only `kiro-cli`**: `kiro-cli whoami` to renew an expired token, and `kiro-cli login`
  when you ask it to sign in.
- **No telemetry.** Tokens are never logged or shown. The log and the diagnostics report contain
  field names, dates and short fingerprints only, and no conversation content.

## Commands

| Command | What it does |
|---|---|
| `Kiro Relay: Manage` | Menu with the connection state and every action below; also the model picker's "Manage" action |
| `Kiro Relay: Sign In with kiro-cli` | Opens a terminal running `kiro-cli login` with the `kirorelay.login.*` settings |
| `Kiro Relay: Refresh Credit Usage` | Fetches your credit usage again (it also refreshes every 5 minutes and after answers) |
| `Kiro Relay: Refresh Models` | Fetches the model list again (it is cached for one hour) |
| `Kiro Relay: Reload Credentials` | Reads the `kiro-cli` credentials again |
| `Kiro Relay: Diagnose Authentication` | Writes a report without secrets to the **Kiro Relay** output panel |

## Settings

**Sign-in** (used by *Sign In with kiro-cli*)

| Setting | Default | Description |
|---|---|---|
| `kirorelay.login.license` | `""` | `pro` (IAM Identity Center), `free` (Builder ID, Google, GitHub), or empty to let `kiro-cli` ask |
| `kirorelay.login.startUrl` | `""` | IAM Identity Center start URL, e.g. `https://example.awsapps.com/start` |
| `kirorelay.login.region` | `""` | IAM Identity Center region, e.g. `us-east-1` |
| `kirorelay.login.deviceFlow` | `auto` | Device code flow: `auto` (remote windows only), `always` or `never` |

**Authentication**

| Setting | Default | Description |
|---|---|---|
| `kirorelay.auth.sources` | `["kiro-cli-db", "sso-cache"]` | Credential sources, in priority order |
| `kirorelay.auth.renewCommand` | `["whoami"]` | `kiro-cli` arguments run to renew an expired token; `[]` = never run `kiro-cli` |
| `kirorelay.auth.refreshLeewaySeconds` | `300` | Margin before expiry at which the credentials are read again |
| `kirorelay.auth.databasePath` | auto | Path to `kiro-cli`'s `data.sqlite3` |
| `kirorelay.auth.ssoCachePath` | `~/.aws/sso/cache` | Directory of the SSO cache |
| `kirorelay.auth.sessionHours` | `8` | Your IAM Identity Center session duration, to estimate when you must sign in again |

**kiro-cli** and **Chat**

| Setting | Default | Description |
|---|---|---|
| `kirorelay.cli.path` | `kiro-cli` | Path to the `kiro-cli` executable |
| `kirorelay.reasoningEffort` | `{}` | Thinking effort per model, e.g. `{ "claude-opus-5": "xhigh" }`; a choice in the model picker takes precedence |

The sign-in settings, `cli.path` and `renewCommand` can only be set in your user (or remote)
settings, never by a workspace.

## Remote development (Dev Containers, WSL, SSH)

In a remote window the extension runs **on the remote side** and reads the remote filesystem. Sign
in with `kiro-cli` **inside** the remote environment (`kiro-cli login --use-device-flow`), or mount
your local `kiro-cli` data directory read-only and set `kirorelay.auth.databasePath`. In a remote
window, `kirorelay.cli.path` appears in the **Remote** tab of the settings.

## Known limitations

- The provider tab in the model picker shows a generic ✨ icon: VS Code only shows brand icons for
  a fixed list of vendors.
- The status bar panel opens on mouse-over. VS Code does not let extensions open it on click.
- When Kiro hides a model's reasoning, nothing is shown for it.
- Kiro reports the context used as a percentage; token counts are estimates.
- Credit usage takes 30 to 60 seconds to reflect an answer.
- The Kiro session end is estimated from the sign-in time, or learned when it is near.
- Tested with IAM Identity Center (Kiro Pro) sign-in. Builder ID, Google and GitHub sign-ins use a
  credential that Kiro Relay reads too, but they have not been tested yet.

## Troubleshooting

Run **Kiro Relay: Diagnose Authentication** and check the **Kiro Relay** output panel. The report
contains no tokens and is safe to paste into an [issue](https://github.com/viniciusclerod/kiro-relay/issues).

| Symptom | What to do |
|---|---|
| Warning in the status bar, "sign-in required" | Click **Sign in** in the panel, or run `kiro-cli login` |
| No **Kiro** group in the model picker | Check the status bar panel; then **Kiro Relay: Refresh Models** |
| `node:sqlite: UNAVAILABLE` in the report | Your VS Code is too old; update VS Code |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). The Kiro Relay icon (a ghost with relay-arrow eyes) is original artwork under the same
license; it is not the Kiro logo.
