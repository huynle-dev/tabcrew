# TabCrew: rename, `tabcrew` CLI and automatic pairing

Date: 2026-10-12. Status: implemented on `feature/tabcrew`.

## Why

ChromeUse v2 worked, but installing it meant cloning the repo, building, writing a launchd plist by hand, creating an env file and pasting a token into the popup. To make it publicly installable it needs a product name that does not suggest a Google product, a one-command installer, and no manual token handling.

## Decisions

- **Name.** TabCrew. Extension description says "in your browser", never implies Google endorsement. Directories: `extension-v2/` → `extension/`; packages `@tabcrew/{shared,daemon,extension}` (private) and `tabcrew` (public, `cli/`).
- **Home.** `~/.tabcrew` (`TABCREW_HOME`; `CHROMEUSE_HOME` still read). `TABCREW_*` env vars with `CHROMEUSE_*` fallbacks. On daemon start and on `setup`, a real `~/.chromeuse` directory is moved (rename, modes preserved) into `~/.tabcrew` via a `~/.tabcrew.migrating` staging directory, then replaced by a symlink to `~/.tabcrew`. Runs only when `~/.tabcrew` does not exist; never overwrites; leftovers that conflict are kept in `~/.chromeuse.bak-<time>` instead of being deleted.
- **Runtime.** `cli/build.mjs` bundles three self-contained ESM files with esbuild (all JS deps inlined; `createRequire` banner for bundled CommonJS; `mainFields: module,main` because jsonc-parser's UMD `main` cannot be bundled). `setup` copies `daemon.mjs` and `pair-host.mjs` to `~/.tabcrew/app/`, so launchd and Chrome never depend on the npx cache. `--from-source <repo>` points at `daemon/dist/index.js` and `cli/dist/pair-host.mjs` instead.
- **Service.** launchd label `com.tabcrew.daemon`, ports unchanged (8770/8771). `setup` boots out `com.chromeuse.daemon` (and deletes its plist), boots out a loaded TabCrew job, waits for the port to free, bootstraps (3 tries), waits up to 15 s for `/health`.
- **CLI code location.** The CLI lives in `daemon/src/cli/` so it shares config/home/token/launchd code with the daemon and is tested by the daemon's vitest; `daemon/dist/index.js <command>` runs the same CLI for development. Every side effect goes through an injectable `System` (runner, fetch, clock, prompts, PATH lookup).
- **Pairing.** Chrome native messaging host `com.tabcrew.pair` (`stdio`, path = `~/.tabcrew/app/pair-host`, a `/bin/sh` wrapper that exports `TABCREW_HOME` and execs the absolute node path). `allowed_origins` = `TABCREW_EXTENSION_IDS` in `shared/src/product.ts`: the dev ID (from the public key committed as `extension/dev-key.pub`; the private key was discarded) and a `null` placeholder for the Chrome Web Store ID. The host verifies the caller origin argument again, answers one `get_token` and exits. The extension pairs when it has no token (retrying from the 1-minute keepalive alarm) and once per rejected token after a 4401. Manual entry stays under Advanced.
- **Harnesses.** OpenCode: JSONC edited in place with jsonc-parser (`modify` without its formatter, which reflows neighbouring lines; inserted properties are laid out to match siblings). V2 files (`mcp.servers`) get `timeout: {catalog, execution}`; V1 files (`mcp.<name>`) or files without `mcp` get the V1 shape. An existing `chromeuse` entry is renamed in place (keeping its other settings) or, if the user declines, only its token path is rewritten. Claude Code: `claude mcp add --transport http --scope user tabcrew <url> --header "Authorization: Bearer <token>"` unless `claude mcp get tabcrew` succeeds.

## Consequences

- Dev builds have a fixed ID; store builds (`build:store`, no `key`) get their ID from the store, which must then be added to `TABCREW_EXTENSION_IDS.store` before the store build can pair.
- Claude Code receives the token value as a command-line argument (visible to local `ps` for the duration of that call); OpenCode reads it from the file.
- Only macOS has a service installer. Linux native-host paths are known (`nativeHostDirs`) but unused by `setup`.
