#!/usr/bin/env bash
set -euo pipefail

required_major=22
required_minor=13

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'CodeBurn requires Node.js and npm.\n' >&2
  exit 1
fi

if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number)
  process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)
'; then
  printf 'CodeBurn requires Node.js %s.%s or newer (found %s).\n' \
    "$required_major" "$required_minor" "$(node --version)" >&2
  exit 1
fi

if [[ -n "${NVM_BIN:-}" ]]; then
  install_prefix="$(cd "$(dirname "$NVM_BIN")" && pwd -P)"
else
  install_prefix="$(npm prefix --global)"
fi
install_bin="$install_prefix/bin"
package_dir="$(mktemp -d "${TMPDIR:-/tmp}/codeburn-install.XXXXXX")"
trap 'rm -rf "$package_dir"' EXIT

printf 'Installing dependencies...\n'
npm ci --ignore-scripts

printf 'Building CodeBurn...\n'
npm run build:cli

printf 'Removing any older global link...\n'
npm uninstall --global --prefix "$install_prefix" codeburn >/dev/null 2>&1 || true

printf 'Packaging and installing CodeBurn...\n'
npm pack --pack-destination "$package_dir" >/dev/null
package_file="$(find "$package_dir" -maxdepth 1 -type f -name 'codeburn-*.tgz' -print -quit)"
if [[ -z "$package_file" ]]; then
  printf 'Could not create the CodeBurn package.\n' >&2
  exit 1
fi
npm install --global --prefix "$install_prefix" "$package_file"

if [[ ! -x "$install_bin/codeburn" ]]; then
  printf 'Installation completed, but %s/codeburn was not created.\n' "$install_bin" >&2
  exit 1
fi

export PATH="$install_bin:$PATH"
hash -r 2>/dev/null || true

printf '\nInstalled %s\n' "$install_bin/codeburn"
"$install_bin/codeburn" --version
if [[ ":$PATH:" != *":$install_bin:"* ]]; then
  printf '\nAdd this line to ~/.bashrc or ~/.zshrc:\n  export PATH="%s:$PATH"\n' "$install_bin"
fi
