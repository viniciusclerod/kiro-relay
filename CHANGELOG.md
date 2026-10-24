# Changelog

## 0.1.0 — 2026-10-24

First preview release.

- Added a Kiro Relay status panel in the secondary side bar. The status bar icon toggles the panel;
  its hover shows token and session expiry. The panel includes plan and credit usage, reset time,
  account details, and the latest interaction's model, context and credits.
- Added an optional, confirmation-gated `kiro-cli` installer to Sign In. macOS and Linux run the
  official installer in the extension host environment; Windows runs it in WSL. Unsupported
  platforms and executable errors provide guidance without attempting installation.
- Added an environment switch to skip `kiro-cli` installation in the devcontainer, making the
  missing-CLI flow testable.
- Raised the minimum supported VS Code version to 1.106 for the secondary side bar.
- Includes Kiro model discovery, streaming chat, Agent-mode tool calls, image input, supported
  thinking effort, credit tracking, and cooperative credential renewal through `kiro-cli`.
- English is the default language; the UI is translated to Brazilian Portuguese. Logs and the
  diagnostics report remain in English.

## 0.0.0 — 2026-10-21

First preview.

- Authentication via `kiro-cli`: read-only credential sources (database snapshot and SSO cache),
  cooperative token provider that never refreshes tokens itself.
- Commands: Diagnose Authentication, Reload Credentials. Status bar indicator.
- Model provider `kirorelay`: lists the models of your Kiro subscription in the Chat model picker
  (context window, max output, image input, credit multiplier).
- Commands: Refresh Models, Manage. Diagnostics now show the current time, the token's remaining time,
  the refresh token fingerprint and the OIDC client secret expiry.
- Thinking effort per model in the Chat model picker (models that support it), with the
  `kirorelay.reasoningEffort` setting as a fallback.
- English is the default language; the UI is translated to Brazilian Portuguese. Logs and the
  diagnostics report are always in English.
- Chat with Kiro models in VS Code Chat: streaming text, tool calling (Agent mode), images, the chosen
  thinking effort, and reasoning display where VS Code supports it.
- Token renewal: when the token has expired, Kiro Relay runs `kiro-cli whoami` so that `kiro-cli`
  renews its own token (`kirorelay.auth.renewCommand`). `kirorelay.cli.path` and the new setting
  can only be set in user settings, not by a workspace.
- The Kiro Relay logo (original artwork) is shown next to each Kiro model in the Chat model picker
  and the chat input, and in the status bar (works in light, dark and high-contrast themes).
- Status bar: the Kiro logo with the token's remaining time; clicking it opens a menu with the
  connection state and every action. New command: Sign In with kiro-cli.
- Credit usage in the status bar hover and menu: plan, credits used with a progress bar, reset date
  and bonuses. New command: Refresh Credit Usage.
- Login settings (`kirorelay.login.*`: license, IAM Identity Center start URL and region, device
  flow) used by Sign In with kiro-cli; a settings button and the current login in the status hover.
- Credits and context used per interaction (Agent mode steps are summed) in the status hover, with
  the session total.
- Status bar: just the Kiro logo; click opens the menu, hover shows the panel, whose Account section
  shows the remaining token time and an estimate of the Kiro (IAM Identity Center) session
  (`kirorelay.auth.sessionHours`).
