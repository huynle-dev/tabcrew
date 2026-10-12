# Security Policy

ChromeUse is a local browser automation tool for trusted users and trusted agents. It is not a sandbox for untrusted prompts, untrusted agents, or untrusted MCP clients.

## Supported Versions

The project is pre-1.0. Security fixes target the latest commit on the default branch.

## Reporting a Vulnerability

Please report security issues privately instead of opening a public GitHub issue.

1. Open a private vulnerability report on GitHub if available for this repository.
2. Otherwise, contact the maintainer through the GitHub profile associated with the repository.
3. Include reproduction steps, impact, affected component (`daemon/`, `extension-v2/`, `shared/`), and any suggested mitigation.

## Security Model

ChromeUse assumes:

- The local machine and user account are trusted.
- MCP clients holding the daemon token are trusted.
- The browser profile is controlled by the user.

ChromeUse does not assume web pages, prompts, or tool calls are safe.

Protections:

- The daemon listens on `127.0.0.1` only (MCP on 8770, extension socket on 8771).
- Both endpoints require the bearer token in `~/.chromeuse/token` (mode 0600, directory 0700).
- The MCP endpoint rejects requests with a disallowed `Origin` or a non-local `Host` header.
- Sessions can only reach their own tabs.
- `debug_logs` never records headers, cookies, bodies, or query strings.
- `OPENROUTER_API_KEY` is read from the environment or `~/.chromeuse/env` (must be 0600), never from `config.toml`.

## Important Risks

An agent with the token can, in your signed-in browser:

- Read page content and capture screenshots.
- Click, type, and select on any site.
- Read console messages and request metadata of its tabs.
- Send page content to the configured model provider when it uses `browse`.

Use caution on admin panels, payment flows, private accounts, and pages with sensitive data. Consider a dedicated Chrome profile for automation. Do not expose the daemon ports beyond localhost.
