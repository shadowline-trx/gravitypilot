# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 4.1.x | ✅ Active |
| < 4.0 | ❌ End of life |

## Reporting a Vulnerability

If you discover a security vulnerability in GravityPilot, please report it responsibly:

1. **DO NOT** open a public GitHub issue for security vulnerabilities
2. Email: [shadowline-trx@users.noreply.github.com](mailto:shadowline-trx@users.noreply.github.com)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 7 days
- **Fix**: Within 30 days for critical issues

## Security Model

GravityPilot operates with the following security characteristics:

### Local-Only Communication

- All network connections are to `127.0.0.1` (localhost) only
- No external network calls are made
- No data is transmitted outside the local machine

### CDP Access

- GravityPilot connects to the Chrome DevTools Protocol debug port
- This is the same mechanism VS Code's built-in developer tools use
- CDP access requires the debug port to be explicitly enabled

### Process Inspection

- GravityPilot reads local process information to discover the language server
- This uses standard OS utilities (`netstat`, `Get-CimInstance`)
- Process information is used transiently and never stored

### God Mode Warning

- When God Mode is enabled, GravityPilot will auto-accept folder access prompts
- This grants the AI agent access to files outside your workspace
- **Use God Mode with caution** — only enable it when you trust the agent's actions

### Permissions

- GravityPilot requires no special OS permissions beyond what VS Code grants
- It does not modify system files (except `argv.json` for CDP port setup, with user consent)
