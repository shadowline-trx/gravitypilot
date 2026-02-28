# Changelog

All notable changes to GravityPilot are documented here.

## [4.1.2] - 2026-02-28

### Fixed

- **Account switch recovery**: gRPC cache (CSRF token + port) and CDP WebSocket connections are now automatically invalidated when the window regains focus or a new terminal opens — fixes the extension silently failing after account switch + restart
- **gRPC cache TTL**: Reduced from 5 minutes to 60 seconds so stale server info expires faster
- **Activation crash resilience**: `activate()` wrapped in try-catch; if anything fails, status bar shows `AG: ERROR` with the error message instead of silently not loading
- **`ensureDebugPort()` safety**: CDP argv.json setup can no longer crash the entire extension on corrupt files

## [4.1.0] - 2026-02-28

### Added

- **Multi-port CDP scanning**: Scans 20+ ports (8997–9014, 9222, 9229) automatically — no manual configuration needed
- **Webview target support**: Connects to both `page` and `webview` CDP targets for full agent panel coverage
- **God Mode toggle**: Auto-allow folder access prompts via status bar or command palette
- **Force Accept hotkey**: `Ctrl+Alt+Shift+A` to manually trigger immediate acceptance
- **Sleep/lock recovery**: Detects system sleep via timer drift and resumes FAST mode automatically
- **Auto-CDP setup**: Writes `--remote-debugging-port` to `argv.json` on first run
- **Marketplace-ready**: LICENSE, CHANGELOG, proper keywords, gallery banner

### Architecture

- **Layer 1 — gRPC**: Discovers AG language server, calls `HandleCascadeUserInteraction` directly — accepts terminal commands with zero UI involvement
- **Layer 2 — CDP WebSocket**: Fresh WebSocket per evaluation cycle, evaluates DOM click script on all matching targets
- **Layer 3 — VS Code Commands**: `Promise.allSettled` fallback for inline completions and edge cases
- **State Machine**: IDLE → FAST (500ms) → SLOW (3s) → IDLE (8s heartbeat), driven by 13 event types

### Fixed

- CDP now scans all common debug ports instead of only 9222
- Includes `webview` type targets (where the agent panel actually lives)
- Removed persistent WebSocket that failed silently on startup — switched to fresh-per-eval model

## [4.0.0] - 2026-02-28

### Added

- Complete rewrite with 3-layer architecture (gRPC + CDP + VS Code commands)
- Event-driven state machine (IDLE/FAST/SLOW)

## [3.0.0] - 2026-02-26

### Changed

- Zero focus-stealing rewrite
- Adaptive back-off (5s base → 12s idle)
- Event-driven wake on editor/terminal/window focus

## [2.0.0] - 2026-02-25

### Fixed

- setTimeout chain (no stacking)
- Cached config (no disk reads per tick)
- Safety timeout (8s)

## [1.2.0] - 2026-02-23

### Fixed

- Overlapping setInterval causing 100% CPU

## [1.0.0] - 2026-02-22

### Added

- Initial release with basic auto-accept functionality
