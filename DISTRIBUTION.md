# ChromeUse MCP Distribution Guide

## Quick Answer

**Yes, you need both components:**
1. **Chrome Extension** (runs in browser)
2. **Gateway Server** (Node.js process that OpenCode communicates with)

The extension cannot work standalone - it needs the gateway to receive commands from OpenCode.

## Architecture Overview

```
OpenCode (MCP client)
    ↓ stdio
Gateway Server (Node.js)
    ↓ WebSocket (port 8765)
Chrome Extension (browser)
    ↓ Chrome APIs
Web Pages
```

## Distribution Methods

### Method 1: Quick Package (Recommended)

Run the packaging script:

```bash
npm run build
./scripts/package-for-distribution.sh
```

This creates `chromeuse-mcp-package.tar.gz` containing:
- Built extension
- Gateway runtime files
- Shared dependencies
- Installation guide (INSTALL.md)

**Share with users:**
```bash
# Send them the .tar.gz file
scp chromeuse-mcp-package.tar.gz user@host:~/
```

### Method 2: Full Repository

If users want to build from source:

```bash
# Create a zip of the entire repo
npm run build
cd ..
tar -czf chromeuse-mcp-full.tar.gz chromeuse-mcp/
```

Users run `./scripts/install.sh` (if they need native messaging) or just load the extension.

### Method 3: Git Clone (Development)

Users can clone directly:

```bash
git clone https://github.com/huynle/chromeuse-mcp.git
cd chromeuse-mcp
npm install
npm run build
```

## User Installation Steps (Summary)

1. **Extract the package**
2. **Load extension** in `chrome://extensions` (Load unpacked → select `extension/` dir)
3. **Configure OpenCode** in `~/.config/opencode/opencode.jsonc`:
   ```jsonc
   {
     "mcp": {
       "chromeuse-mcp": {
         "type": "local",
         "enabled": true,
         "command": ["node", "/absolute/path/to/gateway/dist/index.js"],
         "environment": {
           "CHROMEUSE_JEV_API_KEY": "{env:OPENROUTER_API_KEY}",
           "CHROMEUSE_JEV_MODEL": "typesafe/jev-1.13"
         },
          "timeout": 120000
       }
     }
   }
   ```
4. **Start OpenCode** (auto-launches gateway)
5. **Click Connect** in extension side panel
6. **Test**: Ask OpenCode to call `tabs_context`

The `CHROMEUSE_JEV_*` environment is optional. Without
`CHROMEUSE_JEV_API_KEY`, the browser tools remain available and the three
direct-decision tools are not registered. When enabled, ChromeUse calls only
OpenRouter `POST /api/v1/systemone` with direct `typesafe/jev-1.13`; there is no
chat-completion or generative fallback. Never place a real key in a distributed
archive or checked-in configuration—reference an existing secret environment
variable instead.

## What Users DON'T Need

- ❌ Native messaging host (only needed for old fallback mode)
- ❌ Extension ID registration (WebSocket mode doesn't require it)
- ❌ Build tools (if using pre-built package)
- ❌ The mcp-server directory (gateway mode is preferred)

## What Users DO Need

- ✅ Node.js 20+
- ✅ Chromium-based browser
- ✅ The built extension files
- ✅ The built gateway files
- ✅ OpenCode or another MCP client

## Common Issues

### "Extension won't connect"
- OpenCode must be running first (it starts the gateway)
- Check port 8765 is free: `lsof -i :8765`
- Click "Connect" button in extension side panel

### "OpenCode can't start MCP server"
- Path in `opencode.jsonc` must be absolute
- Point to `gateway/dist/index.js`, not `mcp-server/dist/index.js`
- Verify Node.js version: `node --version` (need 20+)

### "Tools return errors"
- Need at least one normal web page open (not `chrome://` URLs)
- Extension must show "Connected" in side panel
- Try reloading the extension

## File Size Reference

Minimal package (~1-2 MB compressed):
- Extension: ~500 KB
- Gateway + shared: ~500 KB
- Documentation: minimal

Full repository (~10-20 MB):
- Includes source, tests, build tools, docs

## Testing the Package

Before distributing:

```bash
# Build and package
npm run build
./scripts/package-for-distribution.sh

# Extract to temp location
cd /tmp
tar -xzf ~/code/chromeuse-mcp/chromeuse-mcp-package.tar.gz

# Test load extension
# - Open chrome://extensions
# - Load unpacked: /tmp/chromeuse-mcp-package/extension

# Test OpenCode config
# - Edit ~/.config/opencode/opencode.jsonc
# - Set path to /tmp/chromeuse-mcp-package/gateway/dist/index.js
# - Restart OpenCode
# - Try tabs_context tool
```

## Publishing Options

### Internal Distribution
- Email/Slack the .tar.gz file
- Upload to shared drive
- Internal package repository

### Public Distribution
- GitHub Releases (attach .tar.gz)
- npm package (if publishing to npm)
- Chrome Web Store (for extension only - but users still need gateway)

### Enterprise Distribution
- Internal artifact repository
- Configuration management (Ansible/Chef/Puppet)
- Docker container with Node.js + extension files

## Notes

- The extension uses Developer Mode (unpacked) - not suitable for Chrome Web Store yet
- Each user needs their own gateway instance (can't share across machines)
- Multiple OpenCode instances on same machine CAN share one gateway (automatic)
- The gateway only listens on localhost (secure by default)
- No authentication needed (localhost trust model)

## Security Considerations

- Extension has broad permissions (`<all_urls>`) - users should review
- Gateway only binds to 127.0.0.1 (not exposed to network)
- WebSocket has no auth (localhost trust)
- Users should only run this with trusted MCP clients
- Treat as development tool, not production service

## Version Tracking

When distributing updates:

1. Update version in `extension/manifest.json`
2. Update version in `package.json`
3. Rebuild: `npm run build`
4. Repackage: `./scripts/package-for-distribution.sh`
5. Tag release: `git tag v0.1.1 && git push --tags`
6. Notify users of breaking changes

## Support Resources for Users

Include in distribution:
- ✅ INSTALL.md (step-by-step setup)
- ✅ README.md (feature overview)
- ✅ TROUBLESHOOTING.md (common issues)
- ✅ Example OpenCode config snippet
- ✅ Link to GitHub issues for support

## Quick Test Commands

Once installed, users can test with:

```bash
# In OpenCode chat
"Call tabs_context to list my tabs"
"Take a screenshot of this page"
"Navigate to google.com in tab 1"
"Read the page text from the current tab"
```
