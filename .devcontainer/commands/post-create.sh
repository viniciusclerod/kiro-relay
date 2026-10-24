#!/bin/bash
set -euo pipefail

install_dependencies() {
	echo "Installing project dependencies..."
	npm install
}

install_kiro_cli() {
	case "${KIRO_RELAY_INSTALL_CLI-1}" in
		0)
			echo "Skipping Kiro CLI installation (KIRO_RELAY_INSTALL_CLI=0)."
			return
			;;
		1) ;;
		*)
			echo "KIRO_RELAY_INSTALL_CLI must be 0 or 1." >&2
			return 1
			;;
	esac

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
