import { Notice, Plugin, TFile, debounce } from "obsidian";
import { OpenLoreAPI } from "./src/api";
import { OpenLoreSidebarView, SIDEBAR_VIEW_TYPE } from "./src/sidebar";
import { OpenLoreSettingTab } from "./src/settings";
import { DEFAULT_SETTINGS, OpenLoreSettings } from "./src/types";

export default class OpenLorePlugin extends Plugin {
	settings: OpenLoreSettings = DEFAULT_SETTINGS;
	api!: OpenLoreAPI;

	/** Paths changed since the last auto-publish flush. */
	private pendingPaths = new Set<string>();
	/** Debounced flush of pending paths; rebuilt when the delay setting changes. */
	private flushDebounced: () => void = () => {};

	async onload(): Promise<void> {
		await this.loadSettings();
		this.rebuildApi();
		this.rebuildDebounce();

		this.registerView(
			SIDEBAR_VIEW_TYPE,
			(leaf) => new OpenLoreSidebarView(leaf, this)
		);

		// Auto-publish: collect changed/created markdown and flush as a batch.
		this.registerEvent(
			this.app.vault.on("modify", (file) => this.onFileChanged(file))
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => this.onFileChanged(file))
		);

		this.addCommand({
			id: "publish-current-note",
			name: "Publish current note",
			callback: () => this.publishActiveFile(),
		});

		this.addCommand({
			id: "publish-all-notes",
			name: "Publish all notes",
			callback: () => this.publishAll(),
		});

		this.addCommand({
			id: "open-sidebar",
			name: "Open review sidebar",
			callback: () => this.activateSidebarView(),
		});

		this.addRibbonIcon("brain", "OpenLore", () => {
			this.activateSidebarView();
		});

		this.addSettingTab(new OpenLoreSettingTab(this.app, this));

		// Optional one-time full-vault sync once the vault has finished loading
		// (avoids firing "create" events for every existing note at startup).
		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(() => void this.publishAll());
		}
	}

	onunload(): void {}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.rebuildApi();
		this.rebuildDebounce();
	}

	private onFileChanged(file: unknown): void {
		if (!this.settings.autoPublish) return;
		if (!(file instanceof TFile) || file.extension !== "md") return;
		if (!this.shouldWatch(file) || this.isExcludedByTag(file)) return;
		this.pendingPaths.add(file.path);
		this.flushDebounced();
	}

	private rebuildDebounce(): void {
		const ms = Math.max(1, this.settings.autoPublishDelaySeconds) * 1000;
		this.flushDebounced = debounce(() => void this.flushPending(), ms, true);
	}

	/** Publish everything queued by auto-publish, then run one extraction. */
	private async flushPending(): Promise<void> {
		if (this.pendingPaths.size === 0) return;
		if (!this.settings.serverUrl) return;

		const paths = Array.from(this.pendingPaths);
		this.pendingPaths.clear();

		const published = await this.publishPaths(paths);
		if (published === 0) return;

		try {
			await this.api.processTranscripts();
			console.log(`OpenLore: auto-published ${published} note(s)`);
		} catch (e) {
			console.error("OpenLore: extraction failed", e);
		}
	}

	private rebuildApi(): void {
		this.api = new OpenLoreAPI(
			this.settings.serverUrl,
			this.settings.apiToken,
			this.settings.agentId
		);
	}

	showNotice(message: string): void {
		new Notice(message);
	}

	private shouldWatch(file: TFile): boolean {
		for (const folder of this.settings.excludeFolders) {
			if (file.path.startsWith(folder + "/") || file.path === folder) {
				return false;
			}
		}
		if (this.settings.watchedFolders.length > 0) {
			return this.settings.watchedFolders.some(
				(f) => file.path.startsWith(f + "/") || file.path === f
			);
		}
		return true;
	}

	/** Skip notes tagged with any excluded tag (frontmatter or inline). */
	private isExcludedByTag(file: TFile): boolean {
		if (this.settings.excludeTags.length === 0) return false;
		const cache = this.app.metadataCache.getFileCache(file);
		const tags = new Set<string>();
		const fmTags = cache?.frontmatter?.tags;
		if (Array.isArray(fmTags)) {
			for (const t of fmTags) tags.add(String(t).replace(/^#/, "").toLowerCase());
		} else if (typeof fmTags === "string") {
			for (const t of fmTags.split(/[,\s]+/)) {
				tags.add(t.replace(/^#/, "").toLowerCase());
			}
		}
		for (const t of cache?.tags ?? []) {
			tags.add(t.tag.replace(/^#/, "").toLowerCase());
		}
		const excluded = new Set(this.settings.excludeTags.map((t) => t.toLowerCase()));
		for (const t of tags) {
			if (excluded.has(t)) return true;
		}
		return false;
	}

	/** Publish the currently active note. */
	async publishActiveFile(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") {
			this.showNotice("OpenLore: No active markdown note.");
			return;
		}
		if (!this.settings.serverUrl) {
			this.showNotice("OpenLore: Configure the server URL first.");
			return;
		}

		this.showNotice(`OpenLore: Publishing "${file.basename}"...`);
		const published = await this.publishPaths([file.path]);
		if (published === 0) {
			this.showNotice("OpenLore: Note skipped (excluded by tag/folder).");
			return;
		}

		try {
			await this.api.processTranscripts();
			this.showNotice("OpenLore: Note published. Review staged facts in the sidebar.");
		} catch (e) {
			const msg = e instanceof Error ? e.message : "unknown error";
			this.showNotice(`OpenLore: Extraction failed — ${msg}`);
		}
	}

	/** Publish every eligible note in the vault (manual trigger). */
	async publishAll(): Promise<void> {
		if (!this.settings.serverUrl) {
			this.showNotice("OpenLore: Configure the server URL first.");
			return;
		}

		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => this.shouldWatch(f));

		this.showNotice(`OpenLore: Publishing ${files.length} note(s)...`);

		const published = await this.publishPaths(files.map((f) => f.path));
		if (published === 0) {
			this.showNotice("OpenLore: No eligible notes to publish.");
			return;
		}

		try {
			await this.api.processTranscripts();
			this.showNotice(
				`OpenLore: Published ${published} note(s). Review staged facts in the sidebar.`
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "unknown error";
			this.showNotice(`OpenLore: Extraction failed — ${msg}`);
		}
	}

	/** Publish a list of vault file paths. Returns how many were sent. */
	private async publishPaths(paths: string[]): Promise<number> {
		let count = 0;
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			if (this.isExcludedByTag(file)) continue;

			try {
				const content = await this.app.vault.cachedRead(file);
				const observedAt = new Date(file.stat.mtime);
				await this.api.publishNote(file.path, content, observedAt);
				count++;
			} catch (e) {
				console.warn(`OpenLore: Failed to publish ${path}`, e);
			}
		}
		return count;
	}

	async activateSidebarView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}
}
