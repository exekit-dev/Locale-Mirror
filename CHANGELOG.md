# Changelog

All notable changes to **Locale Mirror** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-11-20

### Changed
- Scoped translation index scanning directly to the configured `Locales/` folder hierarchy (`vault.getAbstractFileByPath`) instead of full-vault enumeration (`vault.getMarkdownFiles()`).
- Replaced `!important` CSS overrides with higher-specificity selectors and removed duplicate `background-color` fallback declaration in `styles.css`.
- Removed redundant top-level plugin name heading inside `LocaleMirrorSettingTab`.
- Added GitHub build provenance artifact attestations (`actions/attest-build-provenance@v2`) for `main.js`, `manifest.json`, and `styles.css` in the release workflow.

## [1.0.0] - 2026-11-20

### Added
- Non-destructive transparent translation overlay for both **Reading View** and **Live Preview** using Obsidian's native `MarkdownRenderer`.
- Three-tier translation matching engine (`TranslationIndex`):
  1. Frontmatter UUID (`translation_id`)
  2. Mirrored relative path (`Locales/<LANG>/<relative-path>`)
  3. Filename suffix fallback (`Note - <lang>.md`, `Note.<lang>.md`, `Note_<lang>.md`, `Note (<lang>).md`)
- Reverse resolution from translation files back to original notes (`← ORIG` header action).
- Vault-wide **Default display language** setting with per-note session overrides.
- Sticky glass overlay banner with active language badge, match-method chip, segmented multi-language switcher, and quick **Original**, **Edit**, and **Split** actions.
- Interactive status bar language pill bar (`ORIG · <LANG> · + Add`).
- **Create Translation File** modal with quick language chips, live target path preview, optional template copy, shared UUID assignment, and side-by-side Split View.
- **Assign / Sync UUID** command to link original notes and all matched translations with a shared UUID v4.
- Dynamic CSS option to hide the `Locales/` folder in Obsidian's File Explorer.
- One-click integration with Obsidian's **Excluded files** (`userIgnoreFilters`) to keep translations out of Search, Graph View, and Quick Switcher.
- Proportional scroll synchronization and live overlay hot-reload when editing translation files.
