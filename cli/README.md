# tabcrew

TabCrew gives your AI agents (OpenCode, Claude Code, any MCP client) their own isolated tabs in your real, signed-in browser. One local daemon serves many agents at once; each agent gets its own window and tab group and cannot see anyone else's tabs.

This package installs and manages the local side on macOS.

```sh
npx tabcrew setup     # daemon service, pairing host, OpenRouter key, OpenCode / Claude Code entries
npx tabcrew doctor    # check everything, with a one-line fix per problem
```

Then install the TabCrew browser extension. It pairs with the daemon automatically; there is no token to copy.

| Command | Does |
| --- | --- |
| `setup [--yes] [--no-harness]` | Install or repair everything (idempotent). |
| `doctor [--online]` | Check the installation; exits non-zero on failure. |
| `token` | Print the daemon token. |
| `update` | Reinstall the runtime from this package version and restart the service. |
| `uninstall [--purge] [--yes]` | Remove the service, pairing host and runtime (`--purge`: also token, key, sessions, logs). |

Everything lives in `~/.tabcrew` (override with `TABCREW_HOME`). The daemon listens on `127.0.0.1` only and requires the token. `browse` needs an OpenRouter API key; `setup` asks for it and stores it in `~/.tabcrew/env` (mode 600).

TabCrew is not affiliated with or endorsed by Google. Documentation and source: https://github.com/huynle-dev/tabcrew. License: MIT.
