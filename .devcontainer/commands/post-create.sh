#!/bin/bash
set -euo pipefail

install_dependencies() {
	echo "Installing project dependencies..."
	npm install
}

install_kiro_cli() {
	local kiro_cli="$HOME/.local/bin/kiro-cli"

	if [ -x "$kiro_cli" ]; then
		echo "Kiro CLI is already installed."
		return
	fi

	echo "Installing Kiro CLI..."
	curl -fsSL https://cli.kiro.dev/install | KIRO_CLI_SKIP_SETUP=1 bash

	if [ ! -x "$kiro_cli" ]; then
		echo "Kiro CLI installation did not create $kiro_cli." >&2
		return 1
	fi
}

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Node $(node --version), npm $(npm --version)"

install_dependencies
install_kiro_cli
