# Contributing to Locale Mirror

Thank you for your interest in contributing to **Locale Mirror**! This document outlines guidelines for reporting issues, suggesting enhancements, and submitting pull requests.

## Architecture & Design Principles

Locale Mirror is intentionally designed to be **lightweight, fast, and dependency-free**:
- **Zero build step required for basic development**: `main.js` uses standard CommonJS (`require("obsidian")`) compatible with Obsidian `>= 1.4.0` on both Desktop and Mobile.
- **Theme-native styling**: `styles.css` relies strictly on Obsidian CSS variables (`--interactive-accent`, `--background-primary`, `--background-secondary`, `--text-normal`, `--text-muted`, etc.) with all classes namespaced under `.lm-*`.
- **Non-destructive file handling**: Viewing a translation never mutates the original file on disk. Frontmatter modifications (`translation_id`) happen only when explicitly triggered by the user via `app.fileManager.processFrontMatter`.
- **Clean lifecycle management**: All workspace/vault listeners use `this.registerEvent` / `this.registerDomEvent`, rendered Markdown overlays are scoped to a dedicated `Component` instance that is unloaded on teardown, and all debounced callbacks are cancelled on `onunload()`.

## Local Development Setup

1. Clone the repository into a test vault's plugins folder (or symlink it):
   ```bash
   git clone https://github.com/exekit-dev/Locale-Mirror.git <YourTestVault>/.obsidian/plugins/locale-mirror
   ```
2. Reload Obsidian (`Ctrl+R` / `Cmd+R`) and enable **Locale Mirror** under **Settings → Community plugins**.
3. Check syntax after making edits:
   ```bash
   node --check main.js
   ```

## Pull Request Checklist

Before opening a Pull Request, please verify:
- [ ] `node --check main.js` exits with code `0`.
- [ ] All CSS selectors in `styles.css` are prefixed with `.lm-` (or scoped to `.lm-*` containers) and use Obsidian CSS variables instead of hardcoded colors.
- [ ] Disabling and re-enabling the plugin in Obsidian leaves zero orphaned DOM elements, style tags, or event listeners.
- [ ] All code, comments, UI strings, and commit messages are written in clear English.
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat: ...`, `fix: ...`, `docs: ...`, `style: ...`).

## Reporting Bugs & Requesting Features

Please use the provided [GitHub Issue Templates](https://github.com/exekit-dev/Locale-Mirror/issues/new/choose) and include your Obsidian version, OS/platform, and minimal reproduction steps.
