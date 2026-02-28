# Privacy Policy

**Last updated: February 28, 2026**

## Data Collection

GravityPilot does **NOT** collect, store, transmit, or process any personal data, telemetry, analytics, or usage information of any kind.

## What GravityPilot Does

GravityPilot operates entirely on your local machine. It:

- Reads your VS Code/Antigravity configuration files (`argv.json`) to check if the CDP debug port is enabled
- Makes local network connections to `127.0.0.1` only (localhost) for:
  - Chrome DevTools Protocol (CDP) on ports 8997–9229
  - Antigravity language server gRPC endpoints
- Executes VS Code commands via the extension API

**No data ever leaves your machine.** There are no external API calls, no telemetry endpoints, no crash reporting, and no analytics.

## Local Process Inspection

GravityPilot discovers the Antigravity language server process by running local system commands (`Get-CimInstance` on Windows, `ps` on Unix) and `netstat`/`lsof`. This information is used solely to find the gRPC port and is never stored or transmitted.

## Third-Party Services

GravityPilot does not integrate with any third-party services, cloud platforms, or external APIs.

## Changes to This Policy

If this privacy policy changes, the updated version will be published in this repository with a new "Last updated" date.

## Contact

For questions about this privacy policy, please open an issue on the [GitHub repository](https://github.com/theha/gravitypilot/issues).
