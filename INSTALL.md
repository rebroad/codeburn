# Installing CodeBurn

CodeBurn requires Node.js 22.13 or newer.

## Install The Published Package

If you only want to use CodeBurn, install the published package:

```bash
npm install --global codeburn
```

Make sure npm's global `bin` directory is in your `PATH`:

```bash
export PATH="$(npm prefix --global)/bin:$PATH"
hash -r  # Bash; use rehash in zsh
```

To make that permanent, add the `export PATH=...` line to `~/.bashrc` or
`~/.zshrc`, then open a new shell.

## Install From This Repository

Use this when running the current checkout or developing CodeBurn. The CLI
must be built before it is installed.

With NVM, run:

```bash
nvm install 22
nvm use 22

cd /path/to/codeburn
npm ci --ignore-scripts
npm run build:cli

NVM_PREFIX="$(dirname "$NVM_BIN")"
PACKAGE_DIR="$(mktemp -d)"
npm pack --pack-destination "$PACKAGE_DIR"
npm install --global --prefix "$NVM_PREFIX" "$PACKAGE_DIR"/codeburn-*.tgz

export PATH="$NVM_BIN:$PATH"
hash -r  # Bash; use rehash in zsh
```

The package step is intentional. It installs the built `dist/` files instead
of linking an unbuilt source directory.

If npm reports a global prefix different from the active NVM installation,
check it with:

```bash
npm prefix --global
echo "$NVM_PREFIX"
```

Use the explicit `--prefix "$NVM_PREFIX"` shown above so the executable is
installed into the active Node version's `bin` directory.

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
