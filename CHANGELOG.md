# Changelog

## 0.0.1 (unreleased)

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
- The Kiro logo is shown next to each Kiro model in the Chat model picker and the chat input (works
  in light, dark and high-contrast themes).
- Status bar: the Kiro logo with the token's remaining time; clicking it opens a menu with the
  connection state and every action. New command: Sign In with kiro-cli.
- Credit usage in the status bar hover and menu: plan, credits used with a progress bar, reset date
  and bonuses. New command: Refresh Credit Usage.
- Login settings (`kirorelay.login.*`: license, IAM Identity Center start URL and region, device
  flow) used by Sign In with kiro-cli; a settings button and the current login in the status hover.
