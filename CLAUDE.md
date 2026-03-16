# ios-ship

CLI tool for building, archiving, and uploading iOS apps to TestFlight.

## Stack
- Node.js + TypeScript (ESM)
- Commander.js (CLI framework)
- Chalk + Ora (terminal UI)
- jose (JWT for App Store Connect API)
- xcrun altool (Apple's upload tool)
- xcodebuild (Apple's build tool)

## Commands
```bash
# Full pipeline

# Just build + archive

# Just upload

# Check status
```

## Required env vars (from .env.tpl via 1Password)
- `ASC_KEY_ID` — App Store Connect API Key ID
- `ASC_ISSUER_ID` — App Store Connect Issuer ID
- `ASC_KEY_PATH` — Path to .p8 private key file
- `APPLE_TEAM_ID` — Apple Developer Team ID

## Key files
- `src/cli.ts` — Main CLI entry point (Commander.js commands)
- `src/xcodebuild.ts` — xcodebuild wrapper for build/archive/export
- `src/appstore-connect.ts` — App Store Connect API client (JWT auth + upload)
