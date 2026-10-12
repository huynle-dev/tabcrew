set shell := ["sh", "-uc"]

# Show available recipes.
default:
    @just --list

# Install dependencies and build every package.
install:
    npm install
    npm run build

# Build shared, daemon and extension-v2 (in that order).
build:
    npm run build

# Typecheck every package.
typecheck:
    npm run typecheck

# Run the offline unit tests of every package (no browser, no paid API).
test:
    npm test

# Remove build outputs.
clean:
    npm run clean

# Full local check: typecheck, test, build, then a dependency audit.
verify: typecheck test build
    npm audit --audit-level=moderate

# Print the steps to run the daemon under launchd (runs nothing).
daemon-install:
    @echo "1. node daemon/dist/index.js install-launchd"
    @echo "2. Run the 'launchctl bootstrap gui/\$(id -u) ...' command it prints."

# Print the daemon's auth token (paste it into the extension popup).
token:
    node daemon/dist/index.js token

# Live check against the running daemon and extension: basic tools.
smoke:
    node daemon/scripts/smoke.mjs

# Live check: three sessions in parallel stay isolated.
isolation:
    node daemon/scripts/isolation.mjs

# Live check: freshness and occlusion guards on local fixture pages.
guards:
    node daemon/scripts/guards.mjs

# Live check: concurrent calls across sessions and tabs.
concurrency:
    node daemon/scripts/concurrency.mjs

# Paid live check: Jev browse on real sites (uses OpenRouter credits).
live:
    node daemon/scripts/live-browse.mjs
