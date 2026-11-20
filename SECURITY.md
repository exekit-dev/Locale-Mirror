# Security Policy

## Supported Versions

Security updates are applied to the latest release on the `main` branch:

| Version | Supported |
| :--- | :---: |
| `1.0.x` | Yes |

## Security Model of Locale Mirror

- **100% Offline & Local**: Locale Mirror performs zero network requests, collects zero telemetry, and connects to no external servers or APIs.
- **Native Markdown Sanitization**: All translated Markdown content is rendered exclusively through Obsidian's built-in `MarkdownRenderer.render()` API, inheriting Obsidian's native DOM sanitization and security boundaries.
- **Path Traversal Protection**: All folder and language inputs are sanitized and normalized via Obsidian's `normalizePath()` API, preventing directory traversal (`..`) outside the vault.

## Reporting a Vulnerability

If you discover a security vulnerability in Locale Mirror (such as path traversal, XSS via custom DOM attributes, or unintended file modification):

1. **Do not open a public GitHub issue** for exploitable vulnerabilities.
2. Report it privately using [GitHub Private Vulnerability Reporting](https://github.com/exekit-dev/Locale-Mirror/security/advisories/new) on this repository.
3. Include a clear description of the issue and steps to reproduce it.

Reports are typically acknowledged within 48 hours.
