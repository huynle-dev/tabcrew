set shell := ["sh", "-uc"]

# Show available recipes.
default:
    @just --list

# Install dependencies and build every package.
install:
    npm install
    npm run build

# Build shared, daemon, cli (bundles) and the extension dev build (in that order).
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

# Build the Chrome Web Store package (extension/dist-store + zip, no "key").
build-store:
    npm run build:store -w extension

# Development install: run the service from this checkout (launchd, pairing host, harnesses).
setup-dev:
    node daemon/dist/index.js setup --from-source "$(pwd)"

# Check the local installation.
doctor:
    node daemon/dist/index.js doctor

# Print the daemon's auth token (only needed for manual setups; pairing is automatic).
token:
    node daemon/dist/index.js token

# Show what `npm publish -w tabcrew` would ship.
pack:
    npm pack --dry-run -w tabcrew

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
