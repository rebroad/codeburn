# Installing CodeBurn

CodeBurn requires Node.js 22.13 or newer.

## Install From This Repository (Recommended)

This is the complete installation for the current checkout. Run the installer
from the CodeBurn repository directory:

With NVM, run:

```bash
nvm install 22
nvm use 22

cd /path/to/codeburn
bash ./install.sh
```

The script installs dependencies, builds the CLI, packages the built `dist/`
files, installs the package into the active NVM version, removes stale linked
installs, refreshes the shell command hash, and verifies the executable.
If it prints a `PATH` line, add that line to `~/.bashrc` or `~/.zshrc` and
open a new shell.

## Optional: Install The Published Release

This installs the release currently available from the npm registry, not the
checkout above. It may not contain unreleased commands or fixes. Run it from
any directory after selecting the Node version you want to use:

```bash
nvm install 22
nvm use 22
npm install --global codeburn
```

This installs the release currently available from the registry, not the
checkout. If the command is not found afterward, add npm's global bin to your
`PATH` with `export PATH="$(npm prefix --global)/bin:$PATH"`, then run
`hash -r` in Bash or `rehash` in zsh.

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

Log new Codex completions as JSON to stdout. The watcher reads the exact
`token_usage_record` rollout item, including input, cached input, cache writes,
output, reasoning, and provider-reported total tokens:

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
codex-status watch
codeburn watch --format '%t %m input=%i cached=%c output=%o cost=$%d credits=%C'
```

The format tokens are `%t` timestamp, `%l` logged time, `%m` model, `%s`
session, `%p` project, `%i` input, `%c` cached input, `%w` cache writes, `%o` output, `%r`
reasoning, `%d` USD cost, `%C` credits, and `%f` source.

The watcher also writes the default accounting ledger at
`~/.cache/codeburn/codex-usage.jsonl`, which `codex-status watch` imports.
It reads only the per-response `usage` field, never the cumulative turn/thread
totals, and preserves `usage_metadata.amount` as `reported_amount` when present.
Responses without a `token_usage_record` do not produce a token-usage row.
Rollout token counts cannot establish the backend account's credit balance, so
exact rows report credits as unknown.
Published cache-write rates are charged. If OpenAI publishes `-` for a
model's cache-write rate, CodeBurn does not assume that writes are free; a
record with nonzero writes remains unpriced until you configure a rate.
Use `codeburn pricing update` to refresh Codex pricing manually. Unknown
Codex catalog models are not priced as zero; configure one with
`codeburn price-override <model> --input <usd-per-1M> --output <usd-per-1M>`.
