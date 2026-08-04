# Installing CodeBurn

CodeBurn requires Node.js 22.13 or newer.

## Install From This Repository (Recommended)

This is the complete installation for the current checkout. Run the commands
from the CodeBurn repository directory. The CLI must be built before it is
installed. Install the packed `.tgz` file below;
do not run `npm install --global .` because npm can link the source directory,
which does not reliably expose the built CLI through `PATH`.

With NVM, run:

```bash
nvm install 22
nvm use 22

cd /path/to/codeburn
npm ci --ignore-scripts
npm run build:cli

NVM_PREFIX="$(dirname "$NVM_BIN")"
PACKAGE_DIR="$(mktemp -d)"

# Remove an older linked/global install in this Node environment.
npm uninstall --global --prefix "$NVM_PREFIX" codeburn 2>/dev/null || true

npm pack --pack-destination "$PACKAGE_DIR"
npm install --global --prefix "$NVM_PREFIX" "$PACKAGE_DIR"/codeburn-*.tgz

export PATH="$NVM_BIN:$PATH"
hash -r  # Bash; use rehash in zsh
test -x "$NVM_BIN/codeburn"
command -v codeburn
```

The package step is intentional: it installs the built `dist/` files instead
of linking the source directory. The `test` command fails immediately if npm
did not create the executable in the active Node installation.

If npm reports a global prefix different from the active NVM installation,
check it with:

```bash
npm prefix --global
echo "$NVM_PREFIX"
```

Use the explicit `--prefix "$NVM_PREFIX"` shown above so the executable is
installed into the active Node version's `bin` directory.

## Optional: Install The Published Release

This installs the release currently available from the npm registry, not the
checkout above. It may not contain unreleased commands or fixes. Run it from
any directory after selecting the Node version you want to use:

```bash
nvm install 22
nvm use 22
NVM_PREFIX="$(dirname "$NVM_BIN")"
npm install --global --prefix "$NVM_PREFIX" codeburn
export PATH="$NVM_BIN:$PATH"
hash -r  # Bash; use rehash in zsh
test -x "$NVM_BIN/codeburn"
```

Do not use the shorter `npm install --global codeburn` command unless
`npm prefix --global` is already the active Node installation and its `bin`
directory is already in `PATH`.

## Verify

```bash
command -v codeburn
node --version
codeburn --version
codeburn --help
```

`command -v codeburn` should show the executable from the Node installation
you selected. The help output should include the `watch` command.

## Watch Codex Usage

Log new Codex requests as JSON to stdout:

```bash
codeburn watch
```

Write records to a file instead:

```bash
codeburn watch --output "$HOME/.cache/codeburn/codex-usage.jsonl"
```

Use human-readable output with selectable date-style fields:

```bash
codeburn watch --format human
codeburn watch --format '%t %m input=%i cached=%c output=%o cost=$%d credits=%C'
```

The format tokens are `%t` timestamp, `%l` logged time, `%m` model, `%s`
session, `%p` project, `%i` input, `%c` cached input, `%o` output, `%r`
reasoning, `%d` USD cost, `%C` credits, and `%f` source.
