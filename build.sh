#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -L)"
BUILD_DIR=""
for candidate in "${SOURCE_DIR}.build" "${SOURCE_DIR}.make"; do
  if [[ -d "${candidate}" ]]; then
    BUILD_DIR="$(cd -- "${candidate}" && pwd -P)"
    break
  fi
done

if [[ -z "${BUILD_DIR}" ]]; then
  echo "No sibling build tree found; expected ${SOURCE_DIR}.build or ${SOURCE_DIR}.make" >&2
  exit 1
fi
command -v cpto >/dev/null 2>&1 || { echo 'build.sh: missing required command: cpto' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo 'build.sh: missing required command: npm' >&2; exit 1; }

SOURCE_COMMIT="$(git -C "${SOURCE_DIR}" rev-parse HEAD)"
cpto --nogit "${SOURCE_DIR}" "${BUILD_DIR}"
CODEBURN_COMMIT="${SOURCE_COMMIT}" npm --prefix "${BUILD_DIR}" run build:cli
node "${BUILD_DIR}/dist/cli.js" --version
