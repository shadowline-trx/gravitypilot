# Contributing to GravityPilot

Thank you for your interest in contributing to GravityPilot! This document provides guidelines and information to help you contribute effectively.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [License Agreement](#license-agreement)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Submitting Changes](#submitting-changes)
- [Reporting Issues](#reporting-issues)

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code.

## License Agreement

By contributing to GravityPilot, you agree that:

1. Your contributions are your own original work
2. You have the right to submit your contributions under the [MIT License](LICENSE)
3. Your contributions will be licensed under the same MIT License as the rest of the project
4. You grant the project maintainers a perpetual, worldwide, non-exclusive, royalty-free license to use, reproduce, modify, and distribute your contributions

### Developer Certificate of Origin (DCO)

All contributors must sign-off their commits to certify the [Developer Certificate of Origin (DCO)](https://developercertificate.org/):

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

**To sign off your commits**, add `-s` to your git commit:

```bash
git commit -s -m "feat: your feature description"
```

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/gravitypilot.git`
3. Create a branch: `git checkout -b feature/my-feature`

## Development Setup

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (auto-compile on changes)
npm run watch

# Package .vsix for testing
npm run package
```

### Testing Locally

1. Run `npm run compile`
2. Press `F5` in VS Code to launch the Extension Development Host
3. The extension will activate automatically
4. Check the Output Channel (`GravityPilot`) for logs

## Submitting Changes

### Pull Request Process

1. Ensure your code compiles without errors: `npm run compile`
2. Update `CHANGELOG.md` with your changes
3. Sign off your commits (DCO)
4. Push to your fork and create a Pull Request
5. Describe your changes clearly in the PR description

### Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation changes
- `refactor:` — Code refactoring
- `perf:` — Performance improvement
- `chore:` — Build/tooling changes

### Code Quality

- Write TypeScript (no `any` unless absolutely necessary)
- Keep functions focused and under 50 lines where possible
- Add comments for non-obvious logic
- Maintain the 3-layer architecture (gRPC → CDP → VS Code commands)

## Reporting Issues

- Use [GitHub Issues](https://github.com/shadowline-trx/gravitypilot/issues)
- Include your VS Code/Antigravity version
- Include relevant logs from the Output Channel
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)
