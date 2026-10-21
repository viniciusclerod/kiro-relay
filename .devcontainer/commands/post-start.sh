#!/bin/bash
set -e

configure_ssh() {
  echo "🔑 Configuring SSH for GitHub..."
  mkdir -p ~/.ssh
  chmod 700 ~/.ssh

  # Add config to use port 443 if it doesn't exist
  if ! grep -q "Host github.com" ~/.ssh/config 2>/dev/null; then
    echo "Host github.com" >> ~/.ssh/config
    echo "  Hostname ssh.github.com" >> ~/.ssh/config
    echo "  Port 443" >> ~/.ssh/config
    echo "  User git" >> ~/.ssh/config
    echo "  ForwardAgent yes" >> ~/.ssh/config
    chmod 600 ~/.ssh/config
    echo "✅ SSH configured for github.com on port 443."
  else
    echo "ℹ️  SSH config for github.com already exists."
  fi
}

print_instructions() {
  echo ""
  echo "╔════════════════════════════════════════════════════════╗ "
  echo "║  🔑 SSH for GitHub configured!                         ║ "
  echo "╠════════════════════════════════════════════════════════╣ "
  echo "║  If you still have SSH issues, check:                  ║ "
  echo "║    - SSH agent forwarding is active                    ║ "
  echo "║    - Your keys are loaded on the host                  ║ "
  echo "║    - The ~/.ssh/config file is correct                 ║ "
  echo "╚════════════════════════════════════════════════════════╝ "
  echo ""
}

configure_ssh
print_instructions
