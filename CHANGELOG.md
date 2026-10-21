# Changelog

## 0.0.1 (unreleased)

- Authentication via `kiro-cli`: read-only credential sources (database snapshot and SSO cache),
  cooperative token provider that never refreshes tokens.
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
