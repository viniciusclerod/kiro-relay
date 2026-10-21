# Kiro Relay

> **Unofficial.** Not affiliated with, endorsed by, or sponsored by Amazon Web Services or Kiro.
> "Kiro" is a trademark of its respective owner.

Use the models from your **Kiro** subscription inside **VS Code Chat**, authenticated through the
**`kiro-cli`** you already have installed. Kiro Relay has no login of its own.

> **Preview.** This version lists your Kiro models in the Chat model picker, but **chat responses are
> not implemented yet**: picking a Kiro model and sending a message fails with an explicit error.

## Requirements

- VS Code 1.104 or newer
- [`kiro-cli`](https://kiro.dev/docs/cli/) installed and signed in (`kiro-cli login`)

## How it works

- Reads the credentials `kiro-cli` stored on your machine, **read-only**.
- **Never refreshes your token.** Kiro refresh tokens are single-use, so refreshing from outside
  could sign `kiro-cli` out. When the token is close to expiring, Kiro Relay re-reads the store,
  because `kiro-cli` may have renewed it. If nobody has, it asks you to use `kiro-cli`.
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
| `Kiro Relay: Manage` | Quick menu with the commands above; also opened from the model picker's "Manage" action |

The status bar shows the token state (`✓ Kiro 55 min`, expired, or sign-in required).

## Settings

| Setting | Default | Description |
|---|---|---|
| `kirorelay.cli.path` | `kiro-cli` | Path to the `kiro-cli` executable (diagnostics) |
| `kirorelay.auth.sources` | `["kiro-cli-db", "sso-cache"]` | Credential sources, in priority order |
| `kirorelay.auth.databasePath` | auto | Path to `kiro-cli`'s `data.sqlite3` |
| `kirorelay.auth.ssoCachePath` | `~/.aws/sso/cache` | Directory of the SSO cache |
| `kirorelay.auth.refreshLeewaySeconds` | `300` | Margin before expiry at which a token is treated as expired |
| `kirorelay.reasoningEffort` | `{}` | Thinking effort per model, e.g. `{ "claude-opus-5": "xhigh" }`. A choice in the Chat model picker takes precedence |

## Remote development (Dev Containers, WSL, SSH)

In a remote window the extension runs **on the remote side** and reads the remote filesystem. Sign
in with `kiro-cli` **inside** the remote environment (`kiro-cli login --use-device-flow`), or mount
your local `kiro-cli` data directory read-only and set `kirorelay.auth.databasePath`.

## Troubleshooting

Run **Kiro Relay: Diagnose Authentication** and check the **Kiro Relay** output panel. The report
contains no tokens and is safe to paste into an issue.

## License

MIT. See [LICENSE](LICENSE). Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).
