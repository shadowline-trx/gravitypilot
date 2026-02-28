<p align="center">
  <img src="icon.png" width="128" height="128" alt="GravityPilot Logo">
</p>

<h1 align="center">GravityPilot</h1>

<p align="center">
  <strong>Ultimate auto-accept for Antigravity IDE</strong><br>
  3-layer architecture · Zero freezes · Zero focus-stealing
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=theha.gravitypilot">
    <img src="https://img.shields.io/visual-studio-marketplace/v/theha.gravitypilot?style=flat-square&color=00b4d8" alt="Version">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=theha.gravitypilot">
    <img src="https://img.shields.io/visual-studio-marketplace/i/theha.gravitypilot?style=flat-square&color=0077b6" alt="Installs">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License">
  </a>
</p>

---

## Why GravityPilot?

Other auto-accept extensions freeze your system with 100% RAM/disk usage, steal focus every few seconds, or simply don't work. GravityPilot was built by **reverse-engineering 4 competing extensions** and combining the best technique from each into one lightweight, battle-tested solution.

| Problem (other extensions) | GravityPilot Solution |
| --- | --- |
| `executeCommand` spam → RAM spikes | gRPC bypasses VS Code entirely |
| New WebSocket every poll → memory leaks | Fresh-per-eval with instant cleanup |
| Focus stealing every 3s | Zero focus switching, ever |
| No idle detection → constant CPU | Event-driven state machine |
| Hardcoded single CDP port | Scans 20+ ports automatically |

---

## ✨ Features

- **3-Layer Accept Architecture** — gRPC + CDP WebSocket + VS Code commands
- **Event-Driven State Machine** — IDLE → FAST → SLOW, only polls hard when activity is detected
- **Multi-Port CDP Scanning** — Auto-discovers the active debug port across 20+ candidates
- **God Mode** — Auto-allow folder access and permission prompts (toggle via status bar)
- **Auto-CDP Setup** — Configures `argv.json` automatically on first run
- **Sleep/Lock Recovery** — Detects system sleep and resumes instantly
- **Force Accept** — `Ctrl+Alt+Shift+A` to accept everything immediately
- **Log Capping** — Auto-clears output at 100 lines to prevent memory growth

---

## 🏗️ Architecture

```text
┌──────────────────────────────────────────────────┐
│                  GravityPilot                     │
├──────────────────────────────────────────────────┤
│  Layer 1: gRPC                                   │
│  ├─ Discovers AG language server process          │
│  ├─ Calls HandleCascadeUserInteraction            │
│  └─ Accepts terminal commands with ZERO UI        │
├──────────────────────────────────────────────────┤
│  Layer 2: CDP WebSocket                           │
│  ├─ Scans ports 8997–9014, 9222, 9229             │
│  ├─ Connects to page + webview targets            │
│  └─ Clicks Accept/Run/Allow buttons via DOM       │
├──────────────────────────────────────────────────┤
│  Layer 3: VS Code Commands (fallback)             │
│  ├─ Promise.allSettled on all accept commands      │
│  └─ Catches inline completions & edge cases       │
└──────────────────────────────────────────────────┘
```

---

## 🚀 State Machine

```text
IDLE ──(event)──→ FAST ──(10s)──→ SLOW ──(30s)──→ IDLE
                    ↑ 500ms          3s               │
                    └──── new event ───────────────────┘
               (heartbeat 8s)
```

**13 event triggers**: terminal open/close/switch, editor change, file create/save, text change, task start/end, debug start, window focus, sleep recovery.

---

## 📦 Installation

### From Marketplace

1. Open the Extensions sidebar (`Ctrl+Shift+X`)
2. Search for **GravityPilot**
3. Click **Install**
4. **Restart the IDE** for CDP to activate

### From VSIX

1. Download the `.vsix` from [Releases](https://github.com/theha/gravitypilot/releases)
2. Extensions → `...` → **Install from VSIX**
3. **Restart the IDE**

---

## ⚙️ Configuration

Open Settings (`Ctrl+,`) and search for `agAutoAccept`:

| Setting | Default | Description |
| --- | --- |--- |
| `fastIntervalMs` | `500` | Polling interval in FAST mode (ms) |
| `slowIntervalMs` | `3000` | Polling interval in SLOW mode (ms) |
| `heartbeatIntervalMs` | `8000` | Heartbeat in IDLE mode (ms) |
| `fastDurationMs` | `10000` | FAST mode duration before SLOW |
| `cooldownDurationMs` | `30000` | SLOW mode duration before IDLE |
| `enableCDP` | `true` | Enable CDP WebSocket layer |
| `cdpPort` | `9222` | Primary CDP port (20+ scanned) |
| `debugMode` | `false` | Verbose logging |

---

## ⌨️ Keybindings

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+Shift+Y` | Toggle ON/OFF |
| `Ctrl+Alt+Shift+A` | Force Accept Now |

---

## 🔥 God Mode

Click the shield icon in the status bar to toggle God Mode.

| Mode | Behavior |
| --- | --- |
| 🛡️ **Safe** (default) | Accepts: Run, Accept, Accept All, Continue, Proceed |
| 🔥 **God Mode** | Also accepts: Always Allow, Allow This Conversation, folder access |

> ⚠️ **Warning**: God Mode grants the agent access to files outside your workspace. Use with caution.

---

## 📊 Status Bar

| Icon | State | Meaning |
| --- | --- | --- |
| ✅ `AG: FAST` | FAST | Actively polling — event detected |
| 👁️ `AG: SLOW` | SLOW | Cooling down |
| 🕐 `AG: IDLE` | IDLE | Heartbeat only |
| 🚫 `AG: OFF` | OFF | Disabled |
| 🔥 `GOD` | God Mode | Folder access auto-allowed |
| 🛡️ `Safe` | Safe Mode | Manual folder approval required |

Hover over the FAST indicator to see CDP port and gRPC connection status.

---

## 🔍 Technical Details

### Layer 1: gRPC

Discovers the Antigravity language server process via system commands (`Get-CimInstance` on Windows, `ps` on Unix), extracts the CSRF token from its command line arguments, probes listening ports for the gRPC heartbeat endpoint, and calls `HandleCascadeUserInteraction` directly. This accepts terminal commands **without any UI or DOM involvement** — the most efficient method possible.

### Layer 2: CDP WebSocket

Scans ports 8997–9014, 9222, and 9229 for an active Chrome DevTools Protocol endpoint. Fetches the target list via `/json/list`, filters for `page` and `webview` types, and evaluates a DOM click script on each target. The script uses a **webview guard** (checks for `.react-app-container` or `[class*="agent"]`) to only click buttons inside the Antigravity agent panel. Button text matching is **direct-text-only** (ignores child node text) to avoid false positives.

### Layer 3: VS Code Commands

Fires all known Antigravity accept commands via `Promise.allSettled` — non-blocking, no exceptions thrown. Catches edge cases that Layers 1 and 2 might miss, such as inline completions.

---

## 🤝 Contributing

1. Fork this repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

---

## 📝 License

[MIT](LICENSE) © theha

---

<p align="center">
  Built by reverse-engineering 4 competing extensions and combining the best of each.<br>
  <strong>GravityPilot — autopilot for Antigravity.</strong>
</p>
