# Contributing

Thanks for helping improve ChromeUse. It is a local developer tool, so reliability, clear behavior, and security awareness matter more than feature count.

## Before You Start

- Search existing issues and pull requests before opening a new one.
- For bugs, include reproduction steps and environment details.
- For feature requests, describe the workflow you want to enable and which agent harness you use.
- For security issues, do not open a public issue. Follow `SECURITY.md`.

## Development Setup

```sh
just install    # npm install && npm run build
just verify     # typecheck, offline tests, build, audit
```

After changing `extension-v2/`, rebuild and reload the unpacked extension (`extension-v2/dist`) in `chrome://extensions`. After changing `daemon/`, rebuild and restart the daemon.

## Pull Request Checklist

- Keep changes focused and minimal.
- Update `README.md` when behavior, setup, configuration, or tool inputs change.
- Add or update tests for behavior changes. Unit tests must not open a browser or call a paid API.
- Run `just verify` before opening the PR.
- Mention which live checks you ran (`just smoke`, `just isolation`, `just guards`, `just concurrency`, `just live`).

## Code Layout

- `shared/`: protocol types used by both the daemon and the extension.
- `daemon/`: MCP endpoint, sessions, scheduling, and the Jev `browse` loop.
- `extension-v2/`: browser-specific behavior (tabs, windows, CDP, popup).

## Reporting Bugs

Please include your OS, Chrome version, Node.js version, agent harness, steps to reproduce, expected and actual behavior, and relevant daemon log output or MCP error text.
