"use strict";

const {
	Component,
	FuzzySuggestModal,
	Keymap,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	debounce,
	getFrontMatterInfo,
	normalizePath,
	setIcon,
} = require("obsidian");

const DEFAULT_SETTINGS = {
	localesFolder: "Locales",
	defaultLanguage: "",
	uuidProperty: "translation_id",
	enableSuffixFallback: true,
	hideLocalesFolder: true,
	showOverlayBanner: true,
	showHeaderButtonWhenNoTranslation: true,
	showStatusBar: true,
	syncScrollPosition: true,
};

const DYNAMIC_STYLE_ID = "locale-mirror-dynamic-css";
const DEFAULT_QUICK_LANGS = ["ES", "FR", "DE", "JA", "EN", "PT"];

/* =========================================================================
 * Utility Helpers
 * ========================================================================= */

function normalizeFolderPath(raw) {
	const trimmed = String(raw || "").trim();
	if (!trimmed) return "Locales";
	const normalized = normalizePath(trimmed).replace(/^\/+|\/+$/g, "");
	return normalized || "Locales";
}

function escapeRegExp(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCssAttr(str) {
	return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function generateUuid() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

function stripFrontmatter(rawContent) {
	if (!rawContent) return "";
	if (typeof getFrontMatterInfo === "function") {
		try {
			const info = getFrontMatterInfo(rawContent);
			if (info && info.exists) {
				return rawContent.slice(info.contentStart);
			}
		} catch (_) {
			// Fall back to regex below
		}
	}
	const match = rawContent.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
	return match ? rawContent.slice(match[0].length) : rawContent;
}

function stripLanguageSuffix(basename, langKey) {
	if (!basename || !langKey) return null;
	const escaped = escapeRegExp(langKey);
	const patterns = [
		new RegExp(`\\s+-\\s+${escaped}$`, "i"),
		new RegExp(`\\.${escaped}$`, "i"),
		new RegExp(`_${escaped}$`, "i"),
		new RegExp(`\\s+\\(${escaped}\\)$`, "i"),
	];
	for (const re of patterns) {
		if (re.test(basename)) {
			const stripped = basename.replace(re, "").trim();
			if (stripped) return stripped;
		}
	}
	return null;
}

async function ensureParentFolders(vault, filePath) {
	const normalized = normalizePath(filePath);
	const parts = normalized.split("/");
	parts.pop(); // remove filename
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = vault.getAbstractFileByPath(current);
		if (!existing) {
			await vault.createFolder(current);
		}
	}
}

function formatMatchReason(matchedBy) {
	if (matchedBy === "uuid") return "UUID";
	if (matchedBy === "path") return "Path";
	if (matchedBy === "suffix") return "Suffix";
	return matchedBy || "";
}

/* =========================================================================
 * Translation Index (UUID -> Mirrored Path -> Suffix)
 * ========================================================================= */

class TranslationIndex {
	constructor(plugin) {
		this.plugin = plugin;
		this.languages = new Map(); // langKeyLower -> langLabel (e.g. "es" -> "ES")
		this.byUuid = new Map(); // uuidLower -> Map<langKeyLower, Entry>
		this.byRelPath = new Map(); // relPathLower -> Map<langKeyLower, Entry>
		this.byDirStem = new Map(); // dirLower -> Array<{ langKey, langLabel, stemLower, file }>
		this.originalsByUuid = new Map(); // uuidLower -> TFile
		this.originalsByRelPath = new Map(); // pathLower -> TFile
		this.pendingUuids = new Map(); // filePath -> { prop, uuid }
		this.stats = {
			totalTranslations: 0,
			languageCount: 0,
			uuidLinkedCount: 0,
		};
	}

	setPendingUuid(filePath, prop, uuid) {
		if (!filePath || !prop || !uuid) return;
		this.pendingUuids.set(filePath, {
			prop: String(prop).trim(),
			uuid: String(uuid).trim().toLowerCase(),
		});
	}

	clearPendingUuid(filePath) {
		if (!filePath) return;
		this.pendingUuids.delete(filePath);
	}

	renamePendingUuid(oldPath, newPath) {
		if (!oldPath || !this.pendingUuids.has(oldPath)) return;
		const val = this.pendingUuids.get(oldPath);
		this.pendingUuids.delete(oldPath);
		if (newPath) {
			this.pendingUuids.set(newPath, val);
		}
	}

	getLocalesFolder() {
		return normalizeFolderPath(this.plugin.settings.localesFolder);
	}

	isTranslationPath(filePath) {
		if (!filePath) return false;
		const prefix = `${this.getLocalesFolder().toLowerCase()}/`;
		return filePath.toLowerCase().startsWith(prefix);
	}

	parseTranslationPath(filePath) {
		if (!this.isTranslationPath(filePath)) return null;
		const folder = this.getLocalesFolder();
		const rest = filePath.slice(folder.length + 1);
		const slashIdx = rest.indexOf("/");
		if (slashIdx <= 0) return null; // must be inside Locales/<LANG>/...
		const langLabel = rest.slice(0, slashIdx);
		const relPath = rest.slice(slashIdx + 1);
		if (!relPath) return null;

		const lastSlash = relPath.lastIndexOf("/");
		const relDir = lastSlash >= 0 ? relPath.slice(0, lastSlash) : "";
		const fileName = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
		const basename = fileName.toLowerCase().endsWith(".md")
			? fileName.slice(0, -3)
			: fileName;

		return {
			langKey: langLabel.toLowerCase(),
			langLabel,
			relPath,
			relDir,
			basename,
		};
	}

	getFileUuid(file) {
		const prop = (this.plugin.settings.uuidProperty || "").trim();
		if (!prop || !file) return "";
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		const fm = cache && cache.frontmatter;
		if (fm && fm[prop] !== undefined && fm[prop] !== null) {
			const val = String(fm[prop]).trim().toLowerCase();
			if (val) {
				this.pendingUuids.delete(file.path);
				return val;
			}
		}
		const pending = this.pendingUuids.get(file.path);
		if (pending && pending.prop === prop && pending.uuid) {
			return pending.uuid;
		}
		return "";
	}

	rebuild() {
		this.languages.clear();
		this.byUuid.clear();
		this.byRelPath.clear();
		this.byDirStem.clear();
		this.originalsByUuid.clear();
		this.originalsByRelPath.clear();

		let totalTranslations = 0;
		let uuidLinkedCount = 0;

		const { vault } = this.plugin.app;
		const localesFolder = this.getLocalesFolder();

		// Discover language folders even if currently empty
		const rootAbstract = vault.getAbstractFileByPath(localesFolder);
		if (rootAbstract instanceof TFolder) {
			for (const child of rootAbstract.children) {
				if (child instanceof TFolder) {
					const langKey = child.name.toLowerCase();
					if (!this.languages.has(langKey)) {
						this.languages.set(langKey, child.name);
					}
				}
			}
		}

		const files = vault.getMarkdownFiles();
		for (const file of files) {
			const parsed = this.parseTranslationPath(file.path);
			const uuid = this.getFileUuid(file);

			if (parsed) {
				totalTranslations += 1;
				const { langKey, langLabel, relPath, relDir, basename } = parsed;
				if (!this.languages.has(langKey)) {
					this.languages.set(langKey, langLabel);
				}

				const entry = {
					langKey,
					langLabel: this.languages.get(langKey) || langLabel,
					file,
				};

				// 1. Index by UUID
				if (uuid) {
					uuidLinkedCount += 1;
					let langMap = this.byUuid.get(uuid);
					if (!langMap) {
						langMap = new Map();
						this.byUuid.set(uuid, langMap);
					}
					langMap.set(langKey, entry);
				}

				// 2. Index by mirrored relative path
				const relPathLower = relPath.toLowerCase();
				let pathMap = this.byRelPath.get(relPathLower);
				if (!pathMap) {
					pathMap = new Map();
					this.byRelPath.set(relPathLower, pathMap);
				}
				pathMap.set(langKey, entry);

				// 3. Index by suffix-stripped stem inside mirrored directory
				const stripped = stripLanguageSuffix(basename, langKey);
				if (stripped) {
					const dirLower = relDir.toLowerCase();
					let dirList = this.byDirStem.get(dirLower);
					if (!dirList) {
						dirList = [];
						this.byDirStem.set(dirLower, dirList);
					}
					dirList.push({
						langKey,
						langLabel: entry.langLabel,
						stemLower: stripped.toLowerCase(),
						file,
					});
				}
			} else if (!this.isTranslationPath(file.path)) {
				this.originalsByRelPath.set(file.path.toLowerCase(), file);
				if (uuid) {
					this.originalsByUuid.set(uuid, file);
				}
			}
		}

		this.stats = {
			totalTranslations,
			languageCount: this.languages.size,
			uuidLinkedCount,
		};
	}

	getAvailableLanguages() {
		return Array.from(this.languages.entries())
			.map(([key, label]) => ({ key, label }))
			.sort((a, b) => a.label.localeCompare(b.label));
	}

	resolveForOriginal(file) {
		const results = new Map(); // langKey -> { langKey, langLabel, file, matchedBy }
		if (!file || !(file instanceof TFile) || this.isTranslationPath(file.path)) {
			return [];
		}

		// Priority 1: Frontmatter UUID
		const uuid = this.getFileUuid(file);
		if (uuid) {
			const uuidMap = this.byUuid.get(uuid);
			if (uuidMap) {
				for (const [langKey, entry] of uuidMap.entries()) {
					results.set(langKey, {
						langKey: entry.langKey,
						langLabel: entry.langLabel,
						file: entry.file,
						matchedBy: "uuid",
					});
				}
			}
		}

		// Priority 2: Mirrored relative path
		const pathMap = this.byRelPath.get(file.path.toLowerCase());
		if (pathMap) {
			for (const [langKey, entry] of pathMap.entries()) {
				if (!results.has(langKey)) {
					results.set(langKey, {
						langKey: entry.langKey,
						langLabel: entry.langLabel,
						file: entry.file,
						matchedBy: "path",
					});
				}
			}
		}

		// Priority 3: Filename suffix fallback inside mirrored folder
		if (this.plugin.settings.enableSuffixFallback) {
			let dirPath = "";
			if (file.parent && typeof file.parent.path === "string") {
				dirPath = file.parent.path !== "/" ? file.parent.path.toLowerCase() : "";
			} else if (typeof file.path === "string") {
				const lastSlash = file.path.lastIndexOf("/");
				dirPath = lastSlash >= 0 ? file.path.slice(0, lastSlash).toLowerCase() : "";
			}
			const dirEntries = this.byDirStem.get(dirPath);
			if (dirEntries) {
				const fallbackBase =
					file.basename ||
					String(file.path || "")
						.split("/")
						.pop()
						.replace(/\.md$/i, "");
				const baseLower = fallbackBase.toLowerCase();
				for (const item of dirEntries) {
					if (item.stemLower === baseLower && !results.has(item.langKey)) {
						results.set(item.langKey, {
							langKey: item.langKey,
							langLabel: item.langLabel,
							file: item.file,
							matchedBy: "suffix",
						});
					}
				}
			}
		}

		return Array.from(results.values()).sort((a, b) =>
			a.langLabel.localeCompare(b.langLabel)
		);
	}

	resolveOriginalForTranslation(translationFile) {
		if (!translationFile || !(translationFile instanceof TFile)) return null;
		const parsed = this.parseTranslationPath(translationFile.path);
		if (!parsed) return null;

		// Priority 1: UUID
		const uuid = this.getFileUuid(translationFile);
		if (uuid) {
			const byUuid = this.originalsByUuid.get(uuid);
			if (byUuid) return byUuid;
		}

		// Priority 2: Exact mirrored path
		const exact = this.originalsByRelPath.get(parsed.relPath.toLowerCase());
		if (exact) return exact;

		// Priority 3: Suffix stripped path
		if (this.plugin.settings.enableSuffixFallback) {
			const stripped = stripLanguageSuffix(parsed.basename, parsed.langKey);
			if (stripped) {
				const candidateRel = parsed.relDir
					? `${parsed.relDir}/${stripped}.md`
					: `${stripped}.md`;
				const bySuffix = this.originalsByRelPath.get(candidateRel.toLowerCase());
				if (bySuffix) return bySuffix;
			}
		}

		return null;
	}
}

/* =========================================================================
 * Modals
 * ========================================================================= */

class CreateTranslationModal extends Modal {
	constructor(app, plugin, sourceFile) {
		super(app);
		this.plugin = plugin;
		this.sourceFile = sourceFile;

		const defaultLang =
			(plugin.settings.defaultLanguage || "").trim() ||
			(plugin.index.getAvailableLanguages()[0]?.label || "ES");
		this.langCode = defaultLang;
		this.copyContent = true;
		this.assignUuid = true;
		this.openInSplit = true;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("lm-modal");

		if (typeof this.setTitle === "function") {
			this.setTitle("Create translation");
		} else {
			contentEl.createEl("h3", { text: "Create translation" });
		}

		// Live Target Path Preview Card
		const previewCard = contentEl.createDiv({ cls: "lm-modal-preview" });
		const previewHeader = previewCard.createDiv({ cls: "lm-modal-preview-header" });
		previewHeader.createSpan({
			cls: "lm-modal-preview-label",
			text: "Target path",
		});
		const statusBadgeEl = previewHeader.createSpan({
			cls: "lm-modal-status-badge is-new",
			text: "New file",
		});
		const previewPathEl = previewCard.createEl("code", {
			cls: "lm-modal-preview-path",
		});

		// Quick language chips
		const quickLangsMap = new Map();
		for (const code of DEFAULT_QUICK_LANGS) {
			quickLangsMap.set(code.toLowerCase(), code);
		}
		for (const item of this.plugin.index.getAvailableLanguages()) {
			if (!quickLangsMap.has(item.label.toLowerCase())) {
				quickLangsMap.set(item.label.toLowerCase(), item.label);
			}
		}

		const chipsSection = contentEl.createDiv({ cls: "lm-modal-chips-section" });
		chipsSection.createSpan({
			cls: "lm-modal-section-label",
			text: "Quick select language",
		});
		const chipsWrap = chipsSection.createDiv({ cls: "lm-modal-quick-langs" });
		const chipButtons = [];
		let langInputEl = null;

		const validationEl = contentEl.createEl("p", {
			cls: "lm-modal-validation",
			attr: { role: "alert" },
		});

		const syncState = (rawInput) => {
			const raw = rawInput !== undefined ? String(rawInput) : String(this.langCode || "");
			const trimmed = raw.trim();
			const sanitized = trimmed.replace(/[\\/:*?"<>|]/g, "").trim();
			const isRelativeDot = /^\.+$/.test(sanitized);
			const validLang = !isRelativeDot ? sanitized : "";
			const previewLang = validLang || "<LANG>";
			const targetPath = this.plugin.buildMirroredTranslationPath(
				this.sourceFile,
				previewLang
			);
			previewPathEl.setText(targetPath);

			// Existence indicator
			if (validLang) {
				const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
				if (existing instanceof TFile) {
					statusBadgeEl.removeClass("is-new");
					statusBadgeEl.addClass("is-exists");
					statusBadgeEl.setText("Already exists — will open");
				} else {
					statusBadgeEl.removeClass("is-exists");
					statusBadgeEl.addClass("is-new");
					statusBadgeEl.setText("New file");
				}
			} else {
				statusBadgeEl.removeClass("is-exists");
				statusBadgeEl.addClass("is-new");
				statusBadgeEl.setText("New file");
			}

			// Bidirectional chip active state
			const activeKey = validLang.toLowerCase();
			for (const entry of chipButtons) {
				const isSelected = Boolean(activeKey) && entry.key === activeKey;
				entry.el.toggleClass("is-selected", isSelected);
				entry.el.setAttribute("aria-pressed", isSelected ? "true" : "false");
			}

			// Inline validation hint
			if (!trimmed || !sanitized) {
				validationEl.setText("Enter a language folder code (e.g. ES, FR, DE).");
				validationEl.addClass("is-visible");
			} else if (isRelativeDot) {
				validationEl.setText('Relative path segments ("." or "..") are not allowed.');
				validationEl.addClass("is-visible");
			} else if (trimmed !== sanitized) {
				validationEl.setText(
					'Unsupported path characters (\\ / : * ? " < > |) will be removed.'
				);
				validationEl.addClass("is-visible");
			} else {
				validationEl.setText("");
				validationEl.removeClass("is-visible");
			}
		};

		for (const code of quickLangsMap.values()) {
			const chip = chipsWrap.createEl("button", {
				text: code,
				cls: "lm-modal-lang-chip",
				attr: {
					type: "button",
					"aria-label": `Select language ${code}`,
					"aria-pressed": "false",
				},
			});
			chipButtons.push({ key: code.toLowerCase(), label: code, el: chip });
			chip.addEventListener("click", () => {
				this.langCode = code;
				if (langInputEl) langInputEl.value = code;
				syncState(code);
			});
		}

		const optionsEl = contentEl.createDiv({ cls: "lm-modal-options" });

		new Setting(optionsEl)
			.setName("Language folder")
			.setDesc("Subfolder name inside your Locales directory (e.g. ES, FR, DE).")
			.addText((text) => {
				langInputEl = text.inputEl;
				text
					.setPlaceholder("ES")
					.setValue(this.langCode)
					.onChange((val) => {
						this.langCode = val.trim();
						syncState(val);
					});
				text.inputEl.setAttribute("aria-label", "Language folder code");
				text.inputEl.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter") {
						evt.preventDefault();
						this.submit(syncState);
					}
				});
			});

		new Setting(optionsEl)
			.setName("Copy original content as template")
			.setDesc("Copies the original note body so you can translate it in-place.")
			.addToggle((toggle) =>
				toggle.setValue(this.copyContent).onChange((v) => {
					this.copyContent = v;
				})
			);

		new Setting(optionsEl)
			.setName("Assign shared UUID")
			.setDesc(
				`Links both files via frontmatter "${this.plugin.settings.uuidProperty}" so renames never break matching.`
			)
			.addToggle((toggle) =>
				toggle.setValue(this.assignUuid).onChange((v) => {
					this.assignUuid = v;
				})
			);

		new Setting(optionsEl)
			.setName("Open side-by-side (Split View)")
			.setDesc("Opens the new translation next to the original note.")
			.addToggle((toggle) =>
				toggle.setValue(this.openInSplit).onChange((v) => {
					this.openInSplit = v;
				})
			);

		const actionsEl = contentEl.createDiv({ cls: "lm-modal-actions" });
		const cancelBtn = actionsEl.createEl("button", {
			text: "Cancel",
			attr: { type: "button" },
		});
		cancelBtn.addEventListener("click", () => this.close());

		const createBtn = actionsEl.createEl("button", {
			text: "Create",
			cls: "mod-cta",
			attr: { type: "button" },
		});
		createBtn.addEventListener("click", () => this.submit(syncState));

		syncState(this.langCode);
	}

	async submit(syncState) {
		const raw = String(this.langCode || "").trim();
		const lang = raw.replace(/[\\/:*?"<>|]/g, "").trim();
		if (!lang || /^\.+$/.test(lang)) {
			if (typeof syncState === "function") syncState(raw);
			new Notice("Please enter a valid language code (e.g. ES or FR).");
			return;
		}
		this.close();
		await this.plugin.createTranslationFile(this.sourceFile, lang, {
			copyContent: this.copyContent,
			assignUuid: this.assignUuid,
			openInSplit: this.openInSplit,
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

class LanguageSuggestModal extends FuzzySuggestModal {
	constructor(app, items, placeholder, onChoose) {
		super(app);
		this.items = items;
		this.onChooseCallback = onChoose;
		this.setPlaceholder(placeholder);
	}

	getItems() {
		return this.items;
	}

	getItemText(item) {
		return item.label;
	}

	renderSuggestion(value, el) {
		const item = value && value.item ? value.item : value;
		if (!item) return;
		const rowEl = el.createDiv({ cls: "lm-suggest-item" });
		rowEl.createSpan({ cls: "lm-suggest-label", text: item.label });
		if (item.meta) {
			rowEl.createSpan({ cls: "lm-suggest-meta", text: item.meta });
		}
	}

	onChooseItem(item) {
		this.onChooseCallback(item);
	}
}

/* =========================================================================
 * Main Plugin
 * ========================================================================= */

class LocaleMirrorPlugin extends Plugin {
	async onload() {
		this.isUnloaded = false;
		await this.loadSettings();

		this.index = new TranslationIndex(this);
		this.leafOverlays = new Map(); // WorkspaceLeaf -> OverlayState
		this.pendingOverlays = new WeakMap(); // WorkspaceLeaf -> renderSignature
		this.renderTokens = new WeakMap(); // WorkspaceLeaf -> number
		this.fileOverrides = new Map(); // sourceFile.path -> "original" | langKey
		this.headerActions = new Map(); // MarkdownView -> HTMLElement
		this.statusBarEl = null;

		this.debouncedRebuildAndRefresh = debounce(
			() => {
				if (this.isUnloaded) return;
				this.index.rebuild();
				this.refreshAllLeaves();
			},
			180,
			true
		);

		this.debouncedReloadOverlayFile = debounce(
			(modifiedFile) => {
				if (this.isUnloaded) return;
				this.reloadOverlaysForTranslationFile(modifiedFile);
			},
			220,
			true
		);

		this.applyDynamicCss();
		this.setupStatusBar();
		this.registerCommands();
		this.addSettingTab(new LocaleMirrorSettingTab(this.app, this));

		// Vault & MetadataCache events
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile || file instanceof TFolder) {
					this.debouncedRebuildAndRefresh();
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) {
					this.fileOverrides.delete(file.path);
					this.index.clearPendingUuid(file.path);
				}
				this.debouncedRebuildAndRefresh();
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					this.index.renamePendingUuid(oldPath, file.path);
					if (this.fileOverrides.has(oldPath)) {
						const val = this.fileOverrides.get(oldPath);
						this.fileOverrides.delete(oldPath);
						this.fileOverrides.set(file.path, val);
					}
				}
				this.debouncedRebuildAndRefresh();
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && this.index.isTranslationPath(file.path)) {
					this.debouncedReloadOverlayFile(file);
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file instanceof TFile) {
					this.index.clearPendingUuid(file.path);
					this.debouncedRebuildAndRefresh();
				}
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("resolved", () => {
				this.index.rebuild();
				this.refreshAllLeaves();
			})
		);

		// Workspace events
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.refreshAllLeaves();
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.refreshAllLeaves();
			})
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.refreshAllLeaves();
			})
		);
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				this.updateOverlayReadableLineClass();
			})
		);

		this.app.workspace.onLayoutReady(() => {
			if (this.isUnloaded) return;
			this.index.rebuild();
			this.refreshAllLeaves();
		});
	}

	onunload() {
		this.isUnloaded = true;
		if (
			this.debouncedRebuildAndRefresh &&
			typeof this.debouncedRebuildAndRefresh.cancel === "function"
		) {
			this.debouncedRebuildAndRefresh.cancel();
		}
		if (
			this.debouncedReloadOverlayFile &&
			typeof this.debouncedReloadOverlayFile.cancel === "function"
		) {
			this.debouncedReloadOverlayFile.cancel();
		}

		// Remove all overlays cleanly
		for (const leaf of Array.from(this.leafOverlays.keys())) {
			this.deactivateOverlay(leaf, false);
		}
		this.leafOverlays.clear();

		// Remove all header action buttons
		for (const actionEl of this.headerActions.values()) {
			actionEl.remove();
		}
		this.headerActions.clear();

		// Remove injected dynamic CSS
		const styleEl = document.getElementById(DYNAMIC_STYLE_ID);
		if (styleEl) styleEl.remove();
	}

	async loadSettings() {
		const loaded = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
		this.settings.localesFolder = normalizeFolderPath(this.settings.localesFolder);
	}

	async saveSettings() {
		this.settings.localesFolder = normalizeFolderPath(this.settings.localesFolder);
		await this.saveData(this.settings);
		this.applyDynamicCss();
		this.index.rebuild();
		this.refreshAllLeaves();
	}

	/* ---------------------------------------------------------------------
	 * Dynamic CSS (Hide Locales folder in File Explorer)
	 * --------------------------------------------------------------------- */

	applyDynamicCss() {
		let styleEl = document.getElementById(DYNAMIC_STYLE_ID);
		if (!this.settings.hideLocalesFolder) {
			if (styleEl) styleEl.remove();
			return;
		}
		if (!styleEl) {
			styleEl = document.createElement("style");
			styleEl.id = DYNAMIC_STYLE_ID;
			document.head.appendChild(styleEl);
		}
		const escapedPath = escapeCssAttr(this.index.getLocalesFolder());
		styleEl.textContent = `.nav-folder:has(> .nav-folder-title[data-path="${escapedPath}"]) { display: none !important; }`;
	}

	/* ---------------------------------------------------------------------
	 * Obsidian Excluded Files (userIgnoreFilters) Integration
	 * --------------------------------------------------------------------- */

	getExcludeFilterPattern() {
		return `^${escapeRegExp(this.index.getLocalesFolder())}/`;
	}

	isLocalesExcluded() {
		try {
			const filters = this.app.vault.getConfig("userIgnoreFilters");
			if (!Array.isArray(filters)) return false;
			const pattern = this.getExcludeFilterPattern();
			return filters.includes(pattern);
		} catch (_) {
			return false;
		}
	}

	setLocalesExcluded(shouldExclude) {
		try {
			const current = this.app.vault.getConfig("userIgnoreFilters");
			const filters = Array.isArray(current) ? [...current] : [];
			const pattern = this.getExcludeFilterPattern();
			const idx = filters.indexOf(pattern);

			if (shouldExclude && idx === -1) {
				filters.push(pattern);
				this.app.vault.setConfig("userIgnoreFilters", filters);
				new Notice(`Added "${pattern}" to Obsidian Excluded files.`);
				return true;
			}
			if (!shouldExclude && idx !== -1) {
				filters.splice(idx, 1);
				this.app.vault.setConfig("userIgnoreFilters", filters);
				new Notice(`Removed "${pattern}" from Obsidian Excluded files.`);
				return true;
			}
			return true;
		} catch (err) {
			console.error("[Locale Mirror] Failed to update userIgnoreFilters:", err);
			new Notice(
				"Could not update Excluded files automatically. Add it in Settings → Files & Links → Excluded files."
			);
			return false;
		}
	}

	/* ---------------------------------------------------------------------
	 * Commands
	 * --------------------------------------------------------------------- */

	registerCommands() {
		this.addCommand({
			id: "toggle-translation",
			name: "Toggle translation",
			checkCallback: (checking) => {
				const view = this.getActiveMarkdownView();
				if (!view || !view.file) return false;
				if (!checking) {
					this.toggleActiveLeafTranslation(view.leaf, view);
				}
				return true;
			},
		});

		this.addCommand({
			id: "choose-translation-language",
			name: "Choose translation language for current note",
			checkCallback: (checking) => {
				const view = this.getActiveMarkdownView();
				if (!view || !view.file || this.index.isTranslationPath(view.file.path)) {
					return false;
				}
				if (!checking) {
					this.openLanguagePickerModal(view.leaf, view);
				}
				return true;
			},
		});

		this.addCommand({
			id: "set-default-display-language",
			name: "Set default display language",
			callback: () => {
				const currentDefault = (this.settings.defaultLanguage || "").trim().toLowerCase();
				const items = [
					{
						key: "",
						label: "Original (manual toggle)",
						meta: !currentDefault ? "Active" : "Manual",
					},
				];
				for (const lang of this.index.getAvailableLanguages()) {
					const isCurrent = currentDefault === lang.key;
					items.push({
						key: lang.label,
						label: lang.label,
						meta: isCurrent ? "Active default" : "Auto-show",
					});
				}
				new LanguageSuggestModal(
					this.app,
					items,
					"Select default display language for all notes...",
					async (chosen) => {
						this.settings.defaultLanguage = chosen.key;
						this.fileOverrides.clear();
						await this.saveSettings();
						new Notice(
							chosen.key
								? `Default display language set to ${chosen.key}`
								: "Default display language set to Original"
						);
					}
				).open();
			},
		});

		this.addCommand({
			id: "open-translation-for-editing",
			name: "Open translation for editing",
			checkCallback: (checking) => {
				const view = this.getActiveMarkdownView();
				if (!view || !view.file || this.index.isTranslationPath(view.file.path)) {
					return false;
				}
				const matches = this.index.resolveForOriginal(view.file);
				if (matches.length === 0) return false;
				if (!checking) {
					const target = this.pickPreferredMatch(view.leaf, view.file, matches);
					if (target) this.openTranslationFile(target.file, false);
				}
				return true;
			},
		});

		this.addCommand({
			id: "open-translation-in-split",
			name: "Open translation in split view",
			checkCallback: (checking) => {
				const view = this.getActiveMarkdownView();
				if (!view || !view.file || this.index.isTranslationPath(view.file.path)) {
					return false;
				}
				const matches = this.index.resolveForOriginal(view.file);
				if (matches.length === 0) return false;
				if (!checking) {
					const target = this.pickPreferredMatch(view.leaf, view.file, matches);
					if (target) this.openTranslationInSplit(view.leaf, target.file);
				}
				return true;
			},
		});

		this.addCommand({
			id: "create-translation-file",
			name: "Create translation file (with shared UUID)",
			checkCallback: (checking) => {
				const view = this.getActiveMarkdownView();
				if (!view || !view.file || this.index.isTranslationPath(view.file.path)) {
					return false;
				}
				if (!checking) {
					new CreateTranslationModal(this.app, this, view.file).open();
				}
				return true;
			},
		});

		this.addCommand({
			id: "assign-sync-uuid",
			name: "Assign / sync UUID to current note and its translations",
			checkCallback: (checking) => {
				const view = this.getActiveMarkdownView();
				if (!view || !view.file) return false;
				if (!checking) {
					this.assignAndSyncUuid(view.file);
				}
				return true;
			},
		});
	}

	getActiveMarkdownView() {
		return this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	/* ---------------------------------------------------------------------
	 * Language Resolution State (Default Language + Per-File Override)
	 * --------------------------------------------------------------------- */

	getDesiredLangForFile(file, matches) {
		if (!file || matches.length === 0) return null;

		const override = this.fileOverrides.get(file.path);
		if (override === "original") return null;
		if (override) {
			const exact = matches.find((m) => m.langKey === override);
			if (exact) return exact;
		}

		const defaultLangKey = (this.settings.defaultLanguage || "").trim().toLowerCase();
		if (defaultLangKey) {
			const defMatch = matches.find((m) => m.langKey === defaultLangKey);
			if (defMatch) return defMatch;
		}

		return null;
	}

	pickPreferredMatch(leaf, file, matches) {
		if (!matches || matches.length === 0) return null;
		const activeOverlay = this.leafOverlays.get(leaf);
		if (activeOverlay) {
			const same = matches.find((m) => m.langKey === activeOverlay.langKey);
			if (same) return same;
		}
		const defaultLangKey = (this.settings.defaultLanguage || "").trim().toLowerCase();
		if (defaultLangKey) {
			const def = matches.find((m) => m.langKey === defaultLangKey);
			if (def) return def;
		}
		return matches[0];
	}

	/* ---------------------------------------------------------------------
	 * Workspace Leaf Sync & Header Buttons
	 * --------------------------------------------------------------------- */

	refreshAllLeaves() {
		const activeLeaves = new Set();
		const activeViews = new Set();

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			activeLeaves.add(leaf);
			activeViews.add(leaf.view);
			this.syncLeaf(leaf, leaf.view);
		});

		// Prune overlays for closed/non-markdown leaves
		for (const leaf of Array.from(this.leafOverlays.keys())) {
			if (!activeLeaves.has(leaf)) {
				this.deactivateOverlay(leaf, false);
			}
		}

		// Prune header actions for closed views
		for (const [view, actionEl] of Array.from(this.headerActions.entries())) {
			if (!activeViews.has(view)) {
				actionEl.remove();
				this.headerActions.delete(view);
			}
		}

		this.updateStatusBar();
	}

	syncLeaf(leaf, view) {
		const file = view.file;
		const actionEl = this.ensureHeaderAction(leaf, view);

		if (!file) {
			this.deactivateOverlay(leaf, false);
			this.updateHeaderAction(actionEl, { mode: "hidden" });
			return;
		}

		// Case A: User directly opened a translation file inside Locales/<LANG>/...
		if (this.index.isTranslationPath(file.path)) {
			this.deactivateOverlay(leaf, false);
			const parsed = this.index.parseTranslationPath(file.path);
			const origFile = this.index.resolveOriginalForTranslation(file);
			this.updateHeaderAction(actionEl, {
				mode: "translation-file",
				langLabel: parsed ? parsed.langLabel : "",
				origFile,
			});
			return;
		}

		// Case B: Original note
		const matches = this.index.resolveForOriginal(file);
		const desiredMatch = this.getDesiredLangForFile(file, matches);

		if (!desiredMatch) {
			this.deactivateOverlay(leaf, true);
		} else {
			const matchesSignature = matches
				.map((m) => `${m.langKey}:${m.langLabel}:${m.matchedBy}:${m.file.path}`)
				.join("|");
			const renderSignature = `${file.path}::${desiredMatch.file.path}::${desiredMatch.langKey}::${desiredMatch.matchedBy}::${matchesSignature}`;
			const existing = this.leafOverlays.get(leaf);
			const pendingSig = this.pendingOverlays.get(leaf);
			const needsRender =
				pendingSig !== renderSignature &&
				(!existing ||
					existing.sourcePath !== file.path ||
					existing.translationPath !== desiredMatch.file.path ||
					existing.langKey !== desiredMatch.langKey ||
					existing.matchedBy !== desiredMatch.matchedBy ||
					existing.matchCount !== matches.length ||
					existing.matchesSignature !== matchesSignature);

			if (needsRender) {
				this.activateOverlay(leaf, view, file, desiredMatch, matches);
			}
		}

		this.updateHeaderAction(actionEl, {
			mode: "original-file",
			matches,
			activeMatch: desiredMatch,
		});
	}

	ensureHeaderAction(leaf, view) {
		let actionEl = this.headerActions.get(view);
		if (actionEl && actionEl.isConnected) {
			return actionEl;
		}

		actionEl = view.addAction("languages", "Locale Mirror", (evt) => {
			this.handleHeaderButtonClick(leaf, view, evt);
		});
		actionEl.addClass("lm-header-action");

		// Right-click always opens full context menu
		this.registerDomEvent(actionEl, "contextmenu", (evt) => {
			evt.preventDefault();
			this.openContextMenu(leaf, view, evt);
		});

		this.headerActions.set(view, actionEl);
		return actionEl;
	}

	updateHeaderAction(actionEl, state) {
		if (!actionEl) return;
		actionEl.removeClass("lm-hidden", "is-translated", "is-empty");
		actionEl.removeAttribute("data-lm-badge");

		if (state.mode === "hidden") {
			actionEl.addClass("lm-hidden");
			return;
		}

		if (state.mode === "translation-file") {
			actionEl.addClass("is-translated");
			actionEl.setAttribute("data-lm-badge", state.origFile ? "← ORIG" : state.langLabel || "LOC");
			actionEl.setAttribute(
				"aria-label",
				state.origFile
					? `Locale Mirror: Jump to original (${state.origFile.basename})`
					: "Locale Mirror: Translation file (original not found)"
			);
			return;
		}

		const { matches, activeMatch } = state;
		if (!matches || matches.length === 0) {
			if (!this.settings.showHeaderButtonWhenNoTranslation) {
				actionEl.addClass("lm-hidden");
				return;
			}
			actionEl.addClass("is-empty");
			actionEl.setAttribute(
				"aria-label",
				"Locale Mirror: No translation found (click to create)"
			);
			return;
		}

		if (activeMatch) {
			actionEl.addClass("is-translated");
			actionEl.setAttribute("data-lm-badge", activeMatch.langLabel);
			actionEl.setAttribute(
				"aria-label",
				`Locale Mirror: Showing ${activeMatch.langLabel} (click to switch, right-click for menu)`
			);
		} else {
			const langs = matches.map((m) => m.langLabel).join(", ");
			actionEl.setAttribute(
				"aria-label",
				`Locale Mirror: Show translation (${langs}) — right-click for menu`
			);
		}
	}

	handleHeaderButtonClick(leaf, view, evt) {
		const file = view.file;
		if (!file) return;

		// If viewing a translation file directly, jump to original
		if (this.index.isTranslationPath(file.path)) {
			const orig = this.index.resolveOriginalForTranslation(file);
			if (orig) {
				leaf.openFile(orig);
			} else {
				new Notice("Original note for this translation was not found.");
			}
			return;
		}

		const matches = this.index.resolveForOriginal(file);
		if (matches.length === 0) {
			this.openContextMenu(leaf, view, evt);
			return;
		}

		// 1 translation -> instant toggle Original <-> Translation
		if (matches.length === 1) {
			this.toggleActiveLeafTranslation(leaf, view);
			return;
		}

		// Multiple translations -> open selection menu
		this.openContextMenu(leaf, view, evt);
	}

	toggleActiveLeafTranslation(leaf, view) {
		const file = view.file;
		if (!file) return;

		if (this.index.isTranslationPath(file.path)) {
			const orig = this.index.resolveOriginalForTranslation(file);
			if (orig) {
				leaf.openFile(orig);
			} else {
				new Notice("Original note was not found.");
			}
			return;
		}

		const matches = this.index.resolveForOriginal(file);
		if (matches.length === 0) {
			new CreateTranslationModal(this.app, this, file).open();
			return;
		}

		const currentOverlay = this.leafOverlays.get(leaf);
		if (currentOverlay) {
			this.setFileLanguage(leaf, view, file, "original");
		} else {
			const target = this.pickPreferredMatch(leaf, file, matches);
			if (target) {
				this.setFileLanguage(leaf, view, file, target.langKey);
			}
		}
	}

	setFileLanguage(leaf, view, file, langKeyOrOriginal) {
		if (!file) return;
		this.fileOverrides.set(file.path, langKeyOrOriginal);
		this.syncLeaf(leaf, view);
		this.updateStatusBar();
	}

	openLanguagePickerModal(leaf, view) {
		const file = view.file;
		if (!file) return;
		const matches = this.index.resolveForOriginal(file);
		const activeOverlay = this.leafOverlays.get(leaf);
		const items = [
			{
				key: "original",
				label: "Original",
				meta: !activeOverlay ? "Active" : "Source note",
			},
		];
		for (const m of matches) {
			const isActive = activeOverlay && activeOverlay.langKey === m.langKey;
			items.push({
				key: m.langKey,
				label: `${m.langLabel} (${formatMatchReason(m.matchedBy)}: ${m.file.basename})`,
				meta: isActive ? "Active" : formatMatchReason(m.matchedBy),
			});
		}
		new LanguageSuggestModal(
			this.app,
			items,
			"Select display language for this note...",
			(chosen) => {
				this.setFileLanguage(leaf, view, file, chosen.key);
			}
		).open();
	}

	openContextMenu(leaf, view, evt) {
		const file = view.file;
		if (!file) return;

		const menu = new Menu();

		if (this.index.isTranslationPath(file.path)) {
			const orig = this.index.resolveOriginalForTranslation(file);
			menu.addItem((item) =>
				item
					.setTitle(orig ? `Open original (${orig.basename})` : "Original note not found")
					.setIcon("arrow-left")
					.setDisabled(!orig)
					.onClick(() => {
						if (orig) leaf.openFile(orig);
					})
			);
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Assign / sync UUID")
					.setIcon("fingerprint")
					.onClick(() => this.assignAndSyncUuid(file))
			);
			menu.showAtMouseEvent(evt);
			return;
		}

		const matches = this.index.resolveForOriginal(file);
		const activeOverlay = this.leafOverlays.get(leaf);

		// Language choices
		menu.addItem((item) =>
			item
				.setTitle("Original")
				.setIcon(!activeOverlay ? "check" : "file-text")
				.onClick(() => this.setFileLanguage(leaf, view, file, "original"))
		);

		for (const m of matches) {
			const isActive = activeOverlay && activeOverlay.langKey === m.langKey;
			menu.addItem((item) =>
				item
					.setTitle(`${m.langLabel} (${formatMatchReason(m.matchedBy)})`)
					.setIcon(isActive ? "check" : "languages")
					.onClick(() => this.setFileLanguage(leaf, view, file, m.langKey))
			);
		}

		if (matches.length > 0) {
			menu.addSeparator();
			const target = this.pickPreferredMatch(leaf, file, matches);

			menu.addItem((item) =>
				item
					.setTitle(`Edit ${target.langLabel} translation`)
					.setIcon("pencil")
					.onClick(() => this.openTranslationFile(target.file, false))
			);

			menu.addItem((item) =>
				item
					.setTitle(`Open ${target.langLabel} in Split View`)
					.setIcon("columns-2")
					.onClick(() => this.openTranslationInSplit(leaf, target.file))
			);
		}

		menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle("Create translation file...")
				.setIcon("plus")
				.onClick(() => new CreateTranslationModal(this.app, this, file).open())
		);

		menu.addItem((item) =>
			item
				.setTitle("Assign / sync UUID")
				.setIcon("link")
				.onClick(() => this.assignAndSyncUuid(file))
		);

		menu.showAtMouseEvent(evt);
	}

	/* ---------------------------------------------------------------------
	 * Transparent Overlay Rendering & Scroll Sync
	 * --------------------------------------------------------------------- */

	getNativeScrollElement(view) {
		if (!view || !view.contentEl) return null;
		const mode = typeof view.getMode === "function" ? view.getMode() : "source";
		if (mode === "preview") {
			return view.contentEl.querySelector(".markdown-reading-view .markdown-preview-view");
		}
		return view.contentEl.querySelector(".markdown-source-view .cm-scroller");
	}

	captureScrollRatio(scrollEl) {
		if (!this.settings.syncScrollPosition || !scrollEl) return 0;
		const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
		if (maxScroll <= 0) return 0;
		return Math.max(0, Math.min(1, scrollEl.scrollTop / maxScroll));
	}

	restoreScrollRatio(scrollEl, ratio) {
		if (!this.settings.syncScrollPosition || !scrollEl || !ratio) return;
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
				if (maxScroll > 0) {
					scrollEl.scrollTop = Math.round(ratio * maxScroll);
				}
			});
		});
	}

	updateOverlayReadableLineClass() {
		const isReadable = this.app.vault.getConfig("readableLineLength") !== false;
		for (const overlay of this.leafOverlays.values()) {
			if (overlay.containerEl) {
				overlay.containerEl.toggleClass("is-readable-line-width", isReadable);
			}
		}
	}

	async activateOverlay(leaf, view, sourceFile, match, allMatches, preservedRatio) {
		const nextToken = (this.renderTokens.get(leaf) || 0) + 1;
		this.renderTokens.set(leaf, nextToken);

		const matchesSignature = Array.isArray(allMatches)
			? allMatches
					.map((m) => `${m.langKey}:${m.langLabel}:${m.matchedBy}:${m.file.path}`)
					.join("|")
			: `${match.langKey}:${match.langLabel}:${match.matchedBy}:${match.file.path}`;
		const renderSignature = `${sourceFile.path}::${match.file.path}::${match.langKey}::${match.matchedBy}::${matchesSignature}`;
		this.pendingOverlays.set(leaf, renderSignature);

		// Capture scroll ratio before switching view
		let scrollRatio = typeof preservedRatio === "number" ? preservedRatio : 0;
		if (typeof preservedRatio !== "number") {
			const existing = this.leafOverlays.get(leaf);
			if (existing && existing.containerEl) {
				scrollRatio = this.captureScrollRatio(existing.containerEl);
			} else {
				scrollRatio = this.captureScrollRatio(this.getNativeScrollElement(view));
			}
		}

		// Read translation file asynchronously first (avoids flash if read fails)
		let rawContent = "";
		try {
			rawContent = await this.app.vault.cachedRead(match.file);
		} catch (err) {
			if (this.renderTokens.get(leaf) === nextToken) {
				this.pendingOverlays.delete(leaf);
			}
			console.error("[Locale Mirror] Failed to read translation file:", err);
			new Notice(`Failed to read translation: ${match.file.path}`);
			return;
		}

		// Abort if a newer render/deactivation superseded this one
		if (this.renderTokens.get(leaf) !== nextToken || this.isUnloaded) return;
		if (leaf.view !== view || !view.file || view.file.path !== sourceFile.path) {
			this.pendingOverlays.delete(leaf);
			return;
		}

		// Tear down previous overlay DOM/Component if present
		const prev = this.leafOverlays.get(leaf);
		if (prev) {
			prev.component.unload();
			if (prev.containerEl) prev.containerEl.remove();
			this.leafOverlays.delete(leaf);
		}

		// Build new overlay DOM
		const isReadable = this.app.vault.getConfig("readableLineLength") !== false;
		const containerEl = createDiv({
			cls: [
				"lm-overlay-container",
				"markdown-preview-view",
				"markdown-rendered",
				...(isReadable ? ["is-readable-line-width"] : []),
			],
		});

		if (this.settings.showOverlayBanner) {
			this.buildOverlayBanner(containerEl, leaf, view, sourceFile, match, allMatches);
		}

		const sizerEl = containerEl.createDiv({
			cls: "lm-overlay-sizer markdown-preview-sizer markdown-preview-section",
		});

		// Inline title matching Obsidian's setting
		const showInlineTitle = this.app.vault.getConfig("showInlineTitle") !== false;
		if (showInlineTitle) {
			const transCache = this.app.metadataCache.getFileCache(match.file);
			const translatedTitle =
				(transCache && transCache.frontmatter && transCache.frontmatter.title) ||
				match.file.basename;
			sizerEl.createDiv({
				cls: "lm-inline-title inline-title",
				text: String(translatedTitle),
			});
		}

		const bodyEl = sizerEl.createDiv({ cls: "lm-body" });
		const component = new Component();
		component.load();

		const markdownBody = stripFrontmatter(rawContent);

		try {
			if (typeof MarkdownRenderer.render === "function") {
				await MarkdownRenderer.render(
					this.app,
					markdownBody,
					bodyEl,
					sourceFile.path,
					component
				);
			} else {
				await MarkdownRenderer.renderMarkdown(
					markdownBody,
					bodyEl,
					sourceFile.path,
					component
				);
			}
		} catch (err) {
			if (this.renderTokens.get(leaf) === nextToken) {
				this.pendingOverlays.delete(leaf);
			}
			console.error("[Locale Mirror] Failed to render translation:", err);
			component.unload();
			containerEl.remove();
			return;
		}

		if (this.renderTokens.get(leaf) !== nextToken || this.isUnloaded) {
			component.unload();
			containerEl.remove();
			return;
		}

		this.pendingOverlays.delete(leaf);

		// Interactive internal link & hover preview handling inside rendered body
		this.wireOverlayInteractions(bodyEl, view, sourceFile, match.file);

		view.contentEl.addClass("lm-overlay-active");
		view.contentEl.appendChild(containerEl);

		this.leafOverlays.set(leaf, {
			sourcePath: sourceFile.path,
			translationPath: match.file.path,
			langKey: match.langKey,
			langLabel: match.langLabel,
			matchedBy: match.matchedBy,
			matchCount: allMatches ? allMatches.length : 1,
			matchesSignature,
			renderSignature,
			containerEl,
			component,
		});

		this.restoreScrollRatio(containerEl, scrollRatio);
	}

	buildOverlayBanner(containerEl, leaf, view, sourceFile, match, allMatches) {
		const bannerEl = containerEl.createDiv({
			cls: "lm-banner",
			attr: { role: "region", "aria-label": "Locale Mirror translation bar" },
		});

		const leftEl = bannerEl.createDiv({ cls: "lm-banner-left" });
		const reasonLabel = formatMatchReason(match.matchedBy);

		const badgeEl = leftEl.createSpan({
			cls: "lm-banner-badge",
			attr: {
				"aria-label": `Active translation: ${match.langLabel} (${match.file.path})`,
				"data-tooltip-position": "bottom",
			},
		});
		const badgeIcon = badgeEl.createSpan({ cls: "lm-banner-badge-icon" });
		setIcon(badgeIcon, "languages");
		badgeEl.createSpan({ cls: "lm-banner-badge-text", text: match.langLabel });

		leftEl.createSpan({
			cls: "lm-banner-match-chip",
			text: reasonLabel,
			attr: {
				"data-match-type": match.matchedBy,
				"aria-label": `Matched by ${reasonLabel}`,
				"data-tooltip-position": "bottom",
			},
		});

		leftEl.createSpan({
			cls: "lm-banner-filename",
			text: match.file.basename,
			attr: {
				"aria-label": match.file.path,
				"data-tooltip-position": "bottom",
			},
		});

		// Segmented language switcher when multiple translations exist
		if (allMatches && allMatches.length > 1) {
			const langsEl = leftEl.createDiv({
				cls: "lm-banner-langs",
				attr: { role: "group", "aria-label": "Switch translation language" },
			});
			for (const m of allMatches) {
				const isActive = m.langKey === match.langKey;
				const langBtn = langsEl.createEl("button", {
					cls: `lm-banner-lang-btn${isActive ? " is-active" : ""}`,
					text: m.langLabel,
					attr: {
						type: "button",
						"aria-label": `Switch to ${m.langLabel}`,
						"aria-pressed": isActive ? "true" : "false",
						"data-tooltip-position": "bottom",
					},
				});
				langBtn.addEventListener("click", () => {
					this.setFileLanguage(leaf, view, sourceFile, m.langKey);
				});
			}
		}

		const actionsEl = bannerEl.createDiv({
			cls: "lm-banner-actions",
			attr: { role: "group", "aria-label": "Translation actions" },
		});

		const origBtn = actionsEl.createEl("button", {
			cls: "lm-banner-btn lm-banner-btn-primary",
			attr: {
				type: "button",
				"aria-label": "Return to original note",
				"data-tooltip-position": "bottom",
			},
		});
		const origIcon = origBtn.createSpan({ cls: "lm-banner-btn-icon" });
		setIcon(origIcon, "file-text");
		origBtn.createSpan({ cls: "lm-banner-btn-label", text: "Original" });
		origBtn.addEventListener("click", () => {
			this.setFileLanguage(leaf, view, sourceFile, "original");
		});

		const editBtn = actionsEl.createEl("button", {
			cls: "lm-banner-btn",
			attr: {
				type: "button",
				"aria-label": `Edit ${match.file.path}`,
				"data-tooltip-position": "bottom",
			},
		});
		const editIcon = editBtn.createSpan({ cls: "lm-banner-btn-icon" });
		setIcon(editIcon, "pencil");
		editBtn.createSpan({ cls: "lm-banner-btn-label", text: "Edit" });
		editBtn.addEventListener("click", (evt) => {
			this.openTranslationFile(match.file, Keymap.isModEvent(evt));
		});

		const splitBtn = actionsEl.createEl("button", {
			cls: "lm-banner-btn",
			attr: {
				type: "button",
				"aria-label": "Show original and translation side-by-side",
				"data-tooltip-position": "bottom",
			},
		});
		const splitIcon = splitBtn.createSpan({ cls: "lm-banner-btn-icon" });
		setIcon(splitIcon, "columns-2");
		splitBtn.createSpan({ cls: "lm-banner-btn-label", text: "Split" });
		splitBtn.addEventListener("click", () => {
			this.openTranslationInSplit(leaf, match.file);
		});
	}

	wireOverlayInteractions(bodyEl, view, sourceFile, translationFile) {
		bodyEl.addEventListener("click", (evt) => {
			const internalLink = evt.target && evt.target.closest
				? evt.target.closest("a.internal-link")
				: null;
			if (internalLink) {
				evt.preventDefault();
				const linktext =
					internalLink.getAttribute("data-href") || internalLink.getAttribute("href");
				if (!linktext) return;

				const isMod = Keymap.isModEvent(evt);
				if (linktext.startsWith("#") && !isMod) {
					const rawAnchor = linktext.slice(1);
					let decodedAnchor = rawAnchor;
					try {
						decodedAnchor = decodeURIComponent(rawAnchor);
					} catch (_) {
						// keep rawAnchor
					}
					const targetLower = decodedAnchor.trim().toLowerCase();
					if (targetLower && typeof bodyEl.querySelectorAll === "function") {
						const headings = bodyEl.querySelectorAll("h1, h2, h3, h4, h5, h6");
						for (const h of headings) {
							const dataHeading =
								typeof h.getAttribute === "function"
									? h.getAttribute("data-heading")
									: "";
							const textHeading = h.textContent || "";
							if (
								(dataHeading && dataHeading.trim().toLowerCase() === targetLower) ||
								(textHeading && textHeading.trim().toLowerCase() === targetLower)
							) {
								if (typeof h.scrollIntoView === "function") {
									h.scrollIntoView({ behavior: "smooth", block: "start" });
									return;
								}
							}
						}
					}
					this.app.workspace.openLinkText(linktext, sourceFile.path, false);
					return;
				}

				const linkPathPart = linktext.split("#")[0];
				const destFromOrig = linkPathPart
					? this.app.metadataCache.getFirstLinkpathDest(linkPathPart, sourceFile.path)
					: sourceFile;
				const fromPath = destFromOrig ? sourceFile.path : translationFile.path;
				this.app.workspace.openLinkText(linktext, fromPath, isMod);
				return;
			}

			const tagLink = evt.target && evt.target.closest
				? evt.target.closest("a.tag")
				: null;
			if (tagLink) {
				evt.preventDefault();
				const tagText = (tagLink.textContent || "").trim();
				const searchPlugin =
					this.app.internalPlugins &&
					this.app.internalPlugins.getPluginById("global-search");
				if (tagText && searchPlugin && searchPlugin.instance) {
					searchPlugin.instance.openGlobalSearch(`tag:${tagText}`);
				}
			}
		});

		bodyEl.addEventListener("mouseover", (evt) => {
			const internalLink = evt.target && evt.target.closest
				? evt.target.closest("a.internal-link")
				: null;
			if (!internalLink) return;
			const linktext =
				internalLink.getAttribute("data-href") || internalLink.getAttribute("href");
			if (!linktext) return;
			const linkPathPart = linktext.split("#")[0];
			const destFromOrig = linkPathPart
				? this.app.metadataCache.getFirstLinkpathDest(linkPathPart, sourceFile.path)
				: sourceFile;
			const fromPath = destFromOrig ? sourceFile.path : translationFile.path;
			this.app.workspace.trigger("hover-link", {
				event: evt,
				source: "preview",
				hoverParent: view,
				targetEl: internalLink,
				linktext,
				sourcePath: fromPath,
			});
		});
	}

	deactivateOverlay(leaf, restoreScroll) {
		// Invalidate any pending async renders on this leaf
		this.renderTokens.set(leaf, (this.renderTokens.get(leaf) || 0) + 1);
		this.pendingOverlays.delete(leaf);

		const existing = this.leafOverlays.get(leaf);
		if (!existing) return;

		const ratio = restoreScroll ? this.captureScrollRatio(existing.containerEl) : 0;

		existing.component.unload();
		if (existing.containerEl) {
			existing.containerEl.remove();
		}
		this.leafOverlays.delete(leaf);

		if (leaf.view instanceof MarkdownView && leaf.view.contentEl) {
			leaf.view.contentEl.removeClass("lm-overlay-active");
			if (restoreScroll && ratio > 0) {
				this.restoreScrollRatio(this.getNativeScrollElement(leaf.view), ratio);
			}
		}
	}

	reloadOverlaysForTranslationFile(modifiedFile) {
		for (const [leaf, overlay] of this.leafOverlays.entries()) {
			if (overlay.translationPath !== modifiedFile.path) continue;
			if (!(leaf.view instanceof MarkdownView) || !leaf.view.file) continue;

			const sourceFile = leaf.view.file;
			const matches = this.index.resolveForOriginal(sourceFile);
			const match = matches.find((m) => m.file.path === modifiedFile.path);
			if (!match) continue;

			const ratio = this.captureScrollRatio(overlay.containerEl);
			this.activateOverlay(leaf, leaf.view, sourceFile, match, matches, ratio);
		}
	}

	/* ---------------------------------------------------------------------
	 * Status Bar
	 * --------------------------------------------------------------------- */

	setupStatusBar() {
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("lm-status", "lm-hidden");
	}

	updateStatusBar() {
		if (!this.statusBarEl) return;
		this.statusBarEl.empty();

		if (!this.settings.showStatusBar) {
			this.statusBarEl.addClass("lm-hidden");
			return;
		}

		const view = this.getActiveMarkdownView();
		if (!view || !view.file) {
			this.statusBarEl.addClass("lm-hidden");
			return;
		}

		const file = view.file;
		this.statusBarEl.removeClass("lm-hidden");

		const iconEl = this.statusBarEl.createSpan({ cls: "lm-status-icon" });
		setIcon(iconEl, "languages");

		const pillsEl = this.statusBarEl.createDiv({ cls: "lm-status-pills" });

		if (this.index.isTranslationPath(file.path)) {
			const parsed = this.index.parseTranslationPath(file.path);
			const orig = this.index.resolveOriginalForTranslation(file);
			const itemEl = pillsEl.createEl("button", {
				cls: "lm-status-pill is-active",
				text: parsed ? `Editing ${parsed.langLabel}` : "Translation",
				attr: {
					type: "button",
					"aria-label": orig
						? `Click to jump back to original (${orig.basename})`
						: "Translation file (original not found)",
					"data-tooltip-position": "top",
				},
			});
			itemEl.addEventListener("click", () => {
				if (orig) view.leaf.openFile(orig);
			});
			return;
		}

		const matches = this.index.resolveForOriginal(file);
		const activeOverlay = this.leafOverlays.get(view.leaf);

		const origActive = !activeOverlay;
		const origEl = pillsEl.createEl("button", {
			cls: `lm-status-pill${origActive ? " is-active" : ""}`,
			text: "ORIG",
			attr: {
				type: "button",
				"aria-label": "Show original note",
				"aria-pressed": origActive ? "true" : "false",
				"data-tooltip-position": "top",
			},
		});
		origEl.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.setFileLanguage(view.leaf, view, file, "original");
		});

		for (const m of matches) {
			const isActive = Boolean(activeOverlay && activeOverlay.langKey === m.langKey);
			const langEl = pillsEl.createEl("button", {
				cls: `lm-status-pill${isActive ? " is-active" : ""}`,
				text: m.langLabel,
				attr: {
					type: "button",
					"aria-label": `Show ${m.langLabel} (${formatMatchReason(m.matchedBy)}: ${m.file.path})`,
					"aria-pressed": isActive ? "true" : "false",
					"data-tooltip-position": "top",
				},
			});
			langEl.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.setFileLanguage(view.leaf, view, file, m.langKey);
			});
		}

		if (matches.length === 0) {
			const createEl = pillsEl.createEl("button", {
				cls: "lm-status-pill is-add",
				text: "+ Add",
				attr: {
					type: "button",
					"aria-label": "Create a translation for this note",
					"data-tooltip-position": "top",
				},
			});
			createEl.addEventListener("click", (evt) => {
				evt.stopPropagation();
				new CreateTranslationModal(this.app, this, file).open();
			});
		}
	}

	/* ---------------------------------------------------------------------
	 * File Actions: Open, Split, Create Translation, Assign/Sync UUID
	 * --------------------------------------------------------------------- */

	findOpenLeafForFile(targetFile) {
		let found = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (
				!found &&
				leaf.view instanceof MarkdownView &&
				leaf.view.file &&
				leaf.view.file.path === targetFile.path
			) {
				found = leaf;
			}
		});
		return found;
	}

	async openTranslationFile(translationFile, forceNewTab) {
		const existing = this.findOpenLeafForFile(translationFile);
		if (existing && !forceNewTab) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			return;
		}
		const leaf = this.app.workspace.getLeaf(forceNewTab ? "tab" : true);
		await leaf.openFile(translationFile);
	}

	async openTranslationInSplit(sourceLeaf, translationFile) {
		// Show original on the source pane so Split displays Original | Translation
		if (sourceLeaf && sourceLeaf.view instanceof MarkdownView && sourceFileOrNull(sourceLeaf)) {
			this.fileOverrides.set(sourceLeaf.view.file.path, "original");
			this.syncLeaf(sourceLeaf, sourceLeaf.view);
			this.updateStatusBar();
		}

		const existing = this.findOpenLeafForFile(translationFile);
		if (existing && existing !== sourceLeaf) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			return;
		}

		const splitLeaf = this.app.workspace.getLeaf("split");
		await splitLeaf.openFile(translationFile);
	}

	buildMirroredTranslationPath(sourceFile, langLabel) {
		const root = this.index.getLocalesFolder();
		return normalizePath(`${root}/${langLabel}/${sourceFile.path}`);
	}

	async ensureFileUuid(file, preferredUuid) {
		const prop = (this.settings.uuidProperty || "translation_id").trim();
		const existing = this.index.getFileUuid(file);
		const uuid = preferredUuid || existing || generateUuid();

		if (existing && existing === uuid.toLowerCase()) {
			return uuid;
		}

		this.index.setPendingUuid(file.path, prop, uuid);
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[prop] = uuid;
		});
		return uuid;
	}

	async assignAndSyncUuid(activeFile) {
		const prop = (this.settings.uuidProperty || "translation_id").trim();
		if (!prop) {
			new Notice("UUID frontmatter property is empty in settings.");
			return;
		}

		let originalFile = activeFile;
		if (this.index.isTranslationPath(activeFile.path)) {
			const resolvedOrig = this.index.resolveOriginalForTranslation(activeFile);
			if (!resolvedOrig) {
				const uuid = await this.ensureFileUuid(activeFile);
				this.index.rebuild();
				new Notice(`Assigned ${prop}: ${uuid} to translation file.`);
				return;
			}
			originalFile = resolvedOrig;
		}

		const matches = this.index.resolveForOriginal(originalFile);
		let sharedUuid = this.index.getFileUuid(originalFile);

		// Reuse existing UUID from any matched translation if original didn't have one
		if (!sharedUuid) {
			for (const m of matches) {
				const tUuid = this.index.getFileUuid(m.file);
				if (tUuid) {
					sharedUuid = tUuid;
					break;
				}
			}
		}

		if (!sharedUuid) {
			sharedUuid = generateUuid();
		}

		await this.ensureFileUuid(originalFile, sharedUuid);
		for (const m of matches) {
			await this.ensureFileUuid(m.file, sharedUuid);
		}

		this.index.rebuild();
		this.refreshAllLeaves();
		new Notice(
			`Synced ${prop} (${sharedUuid.slice(0, 8)}…) across original + ${matches.length} translation(s).`
		);
	}

	async createTranslationFile(sourceFile, langLabel, options) {
		const opts = options || {};
		const targetPath = this.buildMirroredTranslationPath(sourceFile, langLabel);
		const existing = this.app.vault.getAbstractFileByPath(targetPath);

		if (existing instanceof TFile) {
			new Notice(`Translation already exists: ${targetPath}`);
			if (opts.openInSplit) {
				const activeView = this.getActiveMarkdownView();
				await this.openTranslationInSplit(activeView ? activeView.leaf : null, existing);
			} else {
				await this.openTranslationFile(existing, false);
			}
			return;
		}

		let sharedUuid = "";
		if (opts.assignUuid) {
			sharedUuid = await this.ensureFileUuid(sourceFile);
		}

		let initialContent = "";
		if (opts.copyContent) {
			initialContent = await this.app.vault.read(sourceFile);
		} else {
			initialContent = `# ${sourceFile.basename}\n\n`;
		}

		await ensureParentFolders(this.app.vault, targetPath);
		const createdFile = await this.app.vault.create(targetPath, initialContent);

		if (opts.assignUuid && sharedUuid) {
			await this.ensureFileUuid(createdFile, sharedUuid);
		}

		this.index.rebuild();
		this.refreshAllLeaves();
		new Notice(`Created translation: ${targetPath}`);

		if (opts.openInSplit) {
			const activeView = this.getActiveMarkdownView();
			await this.openTranslationInSplit(activeView ? activeView.leaf : null, createdFile);
		} else {
			await this.openTranslationFile(createdFile, false);
		}
	}
}

function sourceFileOrNull(leaf) {
	return leaf && leaf.view && leaf.view.file ? leaf.view.file : null;
}

/* =========================================================================
 * Settings Tab
 * ========================================================================= */

class LocaleMirrorSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.hasPendingSave = false;
		this.debouncedSaveLocalesFolder = null;
		this.debouncedSaveUuidProperty = null;
	}

	cancelPendingDebounces() {
		if (
			this.debouncedSaveLocalesFolder &&
			typeof this.debouncedSaveLocalesFolder.cancel === "function"
		) {
			this.debouncedSaveLocalesFolder.cancel();
		}
		if (
			this.debouncedSaveUuidProperty &&
			typeof this.debouncedSaveUuidProperty.cancel === "function"
		) {
			this.debouncedSaveUuidProperty.cancel();
		}
	}

	hide() {
		this.cancelPendingDebounces();
		if (this.hasPendingSave) {
			this.hasPendingSave = false;
			return this.plugin.saveSettings();
		}
	}

	display() {
		this.cancelPendingDebounces();
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("lm-settings");

		new Setting(containerEl).setName("Locale Mirror").setHeading();

		// 1. 3-Metric KPI Hero Card + Active Folder & Detected Language Pills
		const heroEl = containerEl.createDiv({ cls: "lm-settings-hero" });
		const kpiGridEl = heroEl.createDiv({ cls: "lm-settings-kpi-grid" });

		const translationsValEl = this.createKpiCard(kpiGridEl, "Translations");
		const languagesValEl = this.createKpiCard(kpiGridEl, "Languages");
		const uuidValEl = this.createKpiCard(kpiGridEl, "UUID-Linked");

		const metaRowEl = heroEl.createDiv({ cls: "lm-settings-meta-row" });
		const folderBadgeEl = metaRowEl.createDiv({ cls: "lm-settings-folder-badge" });
		const folderIconEl = folderBadgeEl.createSpan({ cls: "lm-settings-folder-icon" });
		setIcon(folderIconEl, "folder");
		const folderCodeEl = folderBadgeEl.createEl("code", { cls: "lm-settings-folder-code" });
		const langPillsEl = metaRowEl.createDiv({ cls: "lm-settings-lang-pills" });

		const refreshHeroStats = () => {
			const stats = this.plugin.index.stats;
			const langs = this.plugin.index.getAvailableLanguages();

			translationsValEl.setText(String(stats.totalTranslations));
			languagesValEl.setText(String(stats.languageCount));
			uuidValEl.setText(String(stats.uuidLinkedCount));
			folderCodeEl.setText(`${this.plugin.index.getLocalesFolder()}/`);

			langPillsEl.empty();
			if (langs.length === 0) {
				langPillsEl.createSpan({
					cls: "lm-settings-lang-empty",
					text: "No language folders detected yet",
				});
			} else {
				for (const lang of langs) {
					langPillsEl.createSpan({
						cls: "lm-settings-lang-pill",
						text: lang.label,
					});
				}
			}
		};

		let defaultLangDropdown = null;
		const refreshDefaultLanguageDropdown = () => {
			if (!defaultLangDropdown || !defaultLangDropdown.selectEl) return;
			const selectEl = defaultLangDropdown.selectEl;
			if (typeof selectEl.empty === "function") {
				selectEl.empty();
			} else {
				while (selectEl.firstChild) {
					selectEl.removeChild(selectEl.firstChild);
				}
			}
			const langs = this.plugin.index.getAvailableLanguages();
			defaultLangDropdown.addOption("", "Original (manual toggle)");
			const seen = new Set([""]);
			for (const lang of langs) {
				defaultLangDropdown.addOption(lang.label, lang.label);
				seen.add(lang.label.toLowerCase());
			}
			const current = (this.plugin.settings.defaultLanguage || "").trim();
			if (current && !seen.has(current.toLowerCase())) {
				defaultLangDropdown.addOption(current, `${current} (configured)`);
			}
			defaultLangDropdown.setValue(current);
		};

		let excludeSetting = null;
		let excludeBtnComponent = null;
		const refreshExcludeSetting = () => {
			if (!excludeSetting) return;
			const isExcluded = this.plugin.isLocalesExcluded();
			const excludePattern = this.plugin.getExcludeFilterPattern();
			excludeSetting.setDesc(
				isExcluded
					? `Active: "${excludePattern}" is in Obsidian Excluded files.`
					: `Recommended: adds "${excludePattern}" to Obsidian Excluded files so translated copies don't duplicate search or graph nodes.`
			);
			if (excludeBtnComponent) {
				excludeBtnComponent
					.setButtonText(isExcluded ? "Remove exclusion" : "Add to Excluded files")
					.setCta(!isExcluded);
			}
		};

		this.debouncedSaveLocalesFolder = debounce(
			async (value) => {
				this.hasPendingSave = false;
				this.plugin.settings.localesFolder = normalizeFolderPath(value);
				await this.plugin.saveSettings();
				refreshHeroStats();
				refreshDefaultLanguageDropdown();
				refreshExcludeSetting();
			},
			400,
			true
		);

		this.debouncedSaveUuidProperty = debounce(
			async (value) => {
				this.hasPendingSave = false;
				this.plugin.settings.uuidProperty = value.trim() || "translation_id";
				await this.plugin.saveSettings();
				refreshHeroStats();
			},
			400,
			true
		);

		// 2. Storage & Display Card
		const storageCard = containerEl.createDiv({ cls: "lm-settings-card" });
		new Setting(storageCard).setName("Storage & Display").setHeading();

		new Setting(storageCard)
			.setName("Translations root folder")
			.setDesc(
				"Folder containing per-language mirror trees, e.g. Locales/ES/<same path> and Locales/FR/<same path>."
			)
			.addText((text) =>
				text
					.setPlaceholder("Locales")
					.setValue(this.plugin.settings.localesFolder)
					.onChange((value) => {
						this.plugin.settings.localesFolder = normalizeFolderPath(value);
						this.hasPendingSave = true;
						this.debouncedSaveLocalesFolder(value);
					})
			);

		new Setting(storageCard)
			.setName("Default display language")
			.setDesc(
				"Automatically show this language when opening any note that has a translation. Leave on Original to toggle manually."
			)
			.addDropdown((dropdown) => {
				defaultLangDropdown = dropdown;
				refreshDefaultLanguageDropdown();
				dropdown.onChange(async (value) => {
					this.plugin.settings.defaultLanguage = value;
					this.plugin.fileOverrides.clear();
					await this.plugin.saveSettings();
				});
			});

		new Setting(storageCard)
			.setName("Hide translations folder in File Explorer")
			.setDesc(
				"Keeps your sidebar clean by hiding the Locales folder via CSS while keeping translations indexed and natively editable."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.hideLocalesFolder)
					.onChange(async (value) => {
						this.plugin.settings.hideLocalesFolder = value;
						await this.plugin.saveSettings();
					})
			);

		excludeSetting = new Setting(storageCard)
			.setName("Exclude translations from Search, Graph & Quick Switcher")
			.addButton((btn) => {
				excludeBtnComponent = btn;
				btn.onClick(() => {
					const currentlyExcluded = this.plugin.isLocalesExcluded();
					this.plugin.setLocalesExcluded(!currentlyExcluded);
					refreshExcludeSetting();
				});
			});

		// 3. Matching Card
		const matchingCard = containerEl.createDiv({ cls: "lm-settings-card" });
		new Setting(matchingCard).setName("Matching").setHeading();

		new Setting(matchingCard)
			.setName("Frontmatter UUID property")
			.setDesc(
				"YAML property used to pair original and translated notes even if renamed or moved (highest priority)."
			)
			.addText((text) =>
				text
					.setPlaceholder("translation_id")
					.setValue(this.plugin.settings.uuidProperty)
					.onChange((value) => {
						this.plugin.settings.uuidProperty = value.trim() || "translation_id";
						this.hasPendingSave = true;
						this.debouncedSaveUuidProperty(value);
					})
			);

		new Setting(matchingCard)
			.setName("Filename suffix fallback")
			.setDesc(
				'Also match files like "Note - es.md", "Note.es.md", "Note_es.md", or "Note (es).md" inside the mirrored folder.'
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableSuffixFallback)
					.onChange(async (value) => {
						this.plugin.settings.enableSuffixFallback = value;
						await this.plugin.saveSettings();
					})
			);

		// 4. Interface & Behavior Card
		const uiCard = containerEl.createDiv({ cls: "lm-settings-card" });
		new Setting(uiCard).setName("Interface & Behavior").setHeading();

		new Setting(uiCard)
			.setName("Show top banner on translated notes")
			.setDesc(
				"Displays a compact sticky bar with the active language badge and quick Original / Edit / Split buttons."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showOverlayBanner)
					.onChange(async (value) => {
						this.plugin.settings.showOverlayBanner = value;
						for (const leaf of Array.from(this.plugin.leafOverlays.keys())) {
							this.plugin.deactivateOverlay(leaf, true);
						}
						await this.plugin.saveSettings();
					})
			);

		new Setting(uiCard)
			.setName("Show header button when no translation exists")
			.setDesc(
				"Shows a dimmed language icon on untranslated notes so you can create a translation with one click."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeaderButtonWhenNoTranslation)
					.onChange(async (value) => {
						this.plugin.settings.showHeaderButtonWhenNoTranslation = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(uiCard)
			.setName("Show status bar indicator")
			.setDesc("Displays ORIG / ES / FR quick-switcher pills in the bottom status bar.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showStatusBar)
					.onChange(async (value) => {
						this.plugin.settings.showStatusBar = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(uiCard)
			.setName("Sync scroll position when toggling")
			.setDesc("Preserves relative reading position when switching between original and translation.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncScrollPosition)
					.onChange(async (value) => {
						this.plugin.settings.syncScrollPosition = value;
						await this.plugin.saveSettings();
					})
			);

		// 5. Maintenance Card
		const maintenanceCard = containerEl.createDiv({ cls: "lm-settings-card" });
		new Setting(maintenanceCard).setName("Maintenance").setHeading();

		new Setting(maintenanceCard)
			.setName("Rebuild translation index")
			.setDesc("Manually rescans the Locales directory and refreshes all open tabs.")
			.addButton((btn) =>
				btn.setButtonText("Rebuild now").onClick(() => {
					this.plugin.index.rebuild();
					this.plugin.refreshAllLeaves();
					new Notice(
						`Locale Mirror: indexed ${this.plugin.index.stats.totalTranslations} translation(s).`
					);
					refreshHeroStats();
					refreshDefaultLanguageDropdown();
					refreshExcludeSetting();
				})
			);

		refreshHeroStats();
		refreshExcludeSetting();
	}

	createKpiCard(parentEl, label) {
		const cardEl = parentEl.createDiv({ cls: "lm-settings-kpi-card" });
		const valEl = cardEl.createSpan({ cls: "lm-settings-kpi-value", text: "0" });
		cardEl.createSpan({ cls: "lm-settings-kpi-label", text: label });
		return valEl;
	}
}

module.exports = LocaleMirrorPlugin;
