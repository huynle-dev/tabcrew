# Security Policy

TabCrew is a local browser automation tool for trusted users and trusted agents. It is not a sandbox for untrusted prompts, untrusted agents, or untrusted MCP clients.

## Supported Versions

The project is pre-1.0. Security fixes target the latest commit on the default branch.

## Reporting a Vulnerability

Please report security issues privately instead of opening a public GitHub issue.

1. Open a private vulnerability report on GitHub if available for this repository.
2. Otherwise, contact the maintainer through the GitHub profile associated with the repository.
3. Include reproduction steps, impact, affected component (`daemon/`, `extension/`, `cli/`, `shared/`), and any suggested mitigation.

## Security Model

TabCrew assumes:

- The local machine and user account are trusted.
- MCP clients holding the daemon token are trusted.
- The browser profile is controlled by the user.

TabCrew does not assume web pages, prompts, or tool calls are safe.

Protections:

- The daemon listens on `127.0.0.1` only (MCP on 8770, extension socket on 8771).
- Both endpoints require the bearer token in `~/.tabcrew/token` (mode 0600, directory 0700).
- The MCP endpoint rejects requests with a disallowed `Origin` or a non-local `Host` header.
- Sessions can only reach their own tabs.
- `debug_logs` never records headers, cookies, bodies, or query strings.
- `OPENROUTER_API_KEY` is read from the environment or `~/.tabcrew/env` (must be 0600), never from `config.toml`.
- Pairing: the extension gets the token from the `com.tabcrew.pair` native messaging host. Chrome only lets extensions listed in the host manifest's `allowed_origins` start it, and the host re-checks the caller origin Chrome passes against the known TabCrew extension IDs. It answers one `get_token` request and never logs the token. Any local process running as you could already read `~/.tabcrew/token`; pairing does not widen that.

## Important Risks

An agent with the token can, in your signed-in browser:

- Read page content and capture screenshots.
- Click, type, and select on any site.
- Read console messages and request metadata of its tabs.
- Send page content to the configured model provider when it uses `browse`.

Use caution on admin panels, payment flows, private accounts, and pages with sensitive data. Consider a dedicated browser profile for automation. Do not expose the daemon ports beyond localhost.
