# Kiro Relay

> **Unofficial.** Not affiliated with, endorsed by, or sponsored by Amazon Web Services or Kiro.
> "Kiro" is a trademark of its respective owner.

Use the models from your **Kiro** subscription inside **VS Code Chat**, authenticated through the
**`kiro-cli`** you already have installed. Kiro Relay has no login of its own.

> **Preview.** Chat works with the models of your Kiro subscription: streaming text, tool calling
> (Agent mode), images and thinking effort. Expect rough edges.

Available in English and Brazilian Portuguese (follows the VS Code display language).

## Requirements

- VS Code 1.104 or newer
- [`kiro-cli`](https://kiro.dev/docs/cli/) installed and signed in (`kiro-cli login`)

## How it works

- Reads the credentials `kiro-cli` stored on your machine, **read-only**.
- **Never refreshes your token itself.** Kiro refresh tokens may be single-use, so refreshing from
  outside could sign `kiro-cli` out. When the token has expired, Kiro Relay runs `kiro-cli whoami`,
  which makes `kiro-cli` renew its own token, and reads it again. If your IAM Identity Center session
  has ended (it lasts 8 hours by default), run `kiro-cli login` again.
- Works on a **snapshot** of the `kiro-cli` database, deleted right after reading. Nothing is
  written next to the original files.
- No telemetry. Tokens are never logged or shown; diagnostics only show field names, dates and a
  short fingerprint.

## Commands

| Command | What it does |
|---|---|
| `Kiro Relay: Diagnose Authentication` | Prints a report without secrets (where credentials were looked for, token validity) |
| `Kiro Relay: Reload Credentials` | Forces a fresh read of the `kiro-cli` credentials |
| `Kiro Relay: Refresh Models` | Fetches the model list from Kiro again (it is cached for one hour) |
| `Kiro Relay: Manage` | Menu with the connection state and the commands above; opened by clicking the status bar item or the model picker's "Manage" action |
| `Kiro Relay: Sign In with kiro-cli` | Opens a terminal running `kiro-cli login` (`--use-device-flow` in remote windows) |

The status bar shows the Kiro logo and how long the token is still valid (or a warning). Click it for a menu with the connection state and all actions, including signing in again with `kiro-cli`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `kirorelay.cli.path` | `kiro-cli` | Path to the `kiro-cli` executable (diagnostics) |
| `kirorelay.auth.sources` | `["kiro-cli-db", "sso-cache"]` | Credential sources, in priority order |
| `kirorelay.auth.databasePath` | auto | Path to `kiro-cli`'s `data.sqlite3` |
| `kirorelay.auth.ssoCachePath` | `~/.aws/sso/cache` | Directory of the SSO cache |
| `kirorelay.auth.refreshLeewaySeconds` | `300` | Margin before expiry at which the credentials are read again |
| `kirorelay.auth.renewCommand` | `["whoami"]` | `kiro-cli` arguments run to renew an expired token; `[]` = never run `kiro-cli` |
| `kirorelay.reasoningEffort` | `{}` | Thinking effort per model, e.g. `{ "claude-opus-5": "xhigh" }`. A choice in the Chat model picker takes precedence |

## Remote development (Dev Containers, WSL, SSH)

In a remote window the extension runs **on the remote side** and reads the remote filesystem. Sign
in with `kiro-cli` **inside** the remote environment (`kiro-cli login --use-device-flow`), or mount
your local `kiro-cli` data directory read-only and set `kirorelay.auth.databasePath`.

## Troubleshooting

Run **Kiro Relay: Diagnose Authentication** and check the **Kiro Relay** output panel. The report
contains no tokens and is safe to paste into an issue.

## License

MIT. See [LICENSE](LICENSE). The Kiro logo (`media/kiro.svg`, and the icon font built from it) is
not covered by the MIT license: it is taken from the Kiro app (`@kiro/kiricons`, licensed AWS-IPL)
and remains the property of its owner. Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).
