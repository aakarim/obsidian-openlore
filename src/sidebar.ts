import { ItemView, WorkspaceLeaf, setIcon, Setting, Notice } from "obsidian";
import type OpenLorePlugin from "../main";
import {
	homeStatus,
	homeStatusMessage,
	homeSyncActive,
	syncEnabled,
} from "./types";
import { OnboardingModal } from "./onboarding";
import { MapFolderModal } from "./map-folder";
import type { SyncProgress } from "./sync";

export const SIDEBAR_VIEW_TYPE = "openlore-view";

/**
 * OpenLore control panel: connection status, settings, synced-folder mappings,
 * and sync actions. This is the primary settings surface for the plugin.
 */
export class OpenLoreSidebarView extends ItemView {
	private status: "ok" | "error" | "loading" = "loading";
	private error: string | null = null;
	private progressEl: HTMLElement | null = null;
	private errorsEl: HTMLElement | null = null;
	private syncButton: HTMLButtonElement | null = null;
	private pauseButton: HTMLButtonElement | null = null;
	private lastSyncEl: HTMLElement | null = null;
	private unsubscribeProgress: (() => void) | null = null;
	private unsubscribeErrors: (() => void) | null = null;
	private errorsExpanded = false;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: OpenLorePlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return SIDEBAR_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "OpenLore";
	}
	getIcon(): string {
		return "brain";
	}

	async onOpen(): Promise<void> {
		this.unsubscribeProgress = this.plugin.sync.onProgress((progress) =>
			this.updateProgress(progress)
		);
		this.unsubscribeErrors = this.plugin.sync.onErrorsChanged(() =>
			this.updateErrors()
		);
		this.render();
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = null;
		this.unsubscribeErrors?.();
		this.unsubscribeErrors = null;
		this.contentEl.empty();
	}

	async refresh(): Promise<void> {
		const s = this.plugin.settings;
		if (!s.onboardingComplete) {
			this.status = "error";
			this.error = "Not set up yet.";
			this.render();
			return;
		}
		if (!s.accessToken) {
			this.status = "error";
			this.error = "Signed out.";
			this.render();
			return;
		}

		this.status = "loading";
		this.render();
		try {
			await this.plugin.refreshDocsets();
			if (!s.identity) {
				this.status = "error";
				this.error =
					"Signed in without an identity (anonymous token). Register a " +
					"passkey bound to an identity on the server: " +
					"`passkey register --identity <name>`.";
			} else {
				this.status = "ok";
				this.error = null;
			}
		} catch (e) {
			this.status = "error";
			this.error = e instanceof Error ? e.message : "Connection failed";
		}
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("openlore-sidebar");
		this.progressEl = null;
		this.errorsEl = null;
		this.syncButton = null;
		this.pauseButton = null;
		this.lastSyncEl = null;

		const header = el.createDiv({ cls: "openlore-title-row" });
		header.createEl("h4", { text: "OpenLore" });
		const refreshBtn = header.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => this.refresh());

		const s = this.plugin.settings;
		if (!s.onboardingComplete) {
			el.createDiv({
				cls: "openlore-empty",
				text: "Connect your vault to a lore server to get started.",
			});
			new Setting(el).addButton((b) =>
				b
					.setButtonText("Set up OpenLore")
					.setCta()
					.onClick(() => this.openSetup())
			);
			return;
		}

		this.renderStatus(el);
		this.renderActions(el);
		this.renderMappings(el);
		this.errorsEl = el.createDiv({ cls: "openlore-sync-errors" });
		this.updateErrors();
	}

	private renderStatus(el: HTMLElement): void {
		const s = this.plugin.settings;
		const box = el.createDiv({ cls: "openlore-status" });
		const dot = box.createSpan({ cls: "openlore-dot" });
		if (this.status === "ok") dot.addClass("is-ok");
		else if (this.status === "error") dot.addClass("is-error");

		const label =
			this.status === "ok"
				? "Connected"
				: this.status === "loading"
					? "Connecting…"
					: s.accessToken
						? "Disconnected"
						: "Signed out";
		box.createSpan({ cls: "openlore-status-label", text: label });

		box.createDiv({ cls: "openlore-status-sub", text: s.serverUrl });
		box.createDiv({
			cls: "openlore-status-sub",
			text: s.identity || "(not signed in)",
		});
		if (s.identity) {
			const home = homeStatus(s);
			if (home.ok) {
				box.createDiv({
					cls: "openlore-status-sub",
					text: homeSyncActive(s)
						? `Home: ${home.docset.name}`
						: `Home: ${home.docset.name} (upload not confirmed)`,
				});
			} else {
				box.createDiv({
					cls: "openlore-status-err",
					text: homeStatusMessage(home),
				});
			}
		}
		if (this.error) {
			box.createDiv({ cls: "openlore-status-err", text: this.error });
		}
		if (s.identity && this.plugin.isObsidianSyncActive()) {
			box.createDiv({
				cls: "openlore-status-err",
				text:
					"⚠ Obsidian Sync is on. Don't let it and OpenLore cover the same " +
					"files — exclude your OpenLore folders in Settings → Sync → " +
					"Excluded folders to avoid conflicts and data loss.",
			});
		}
		this.lastSyncEl = box.createDiv({ cls: "openlore-status-sub" });
		this.updateLastSync();
		if (this.plugin.isSyncPaused()) {
			box.createDiv({
				cls: "openlore-status-sub",
				text: `Sync paused until ${new Date(s.syncPausedUntil).toLocaleString()}`,
			});
		}
	}

	private renderActions(el: HTMLElement): void {
		const s = this.plugin.settings;
		const actions = el.createDiv({ cls: "openlore-actions" });

		const syncBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: this.plugin.sync.progress ? "Syncing…" : "Sync now",
		});
		this.syncButton = syncBtn;
		syncBtn.disabled = !syncEnabled(s) || this.plugin.sync.progress !== null;
		syncBtn.addEventListener("click", async () => {
			syncBtn.disabled = true;
			syncBtn.textContent = "Syncing…";
			await this.plugin.syncNow();
			await this.refresh();
		});

		const pauseBtn = actions.createEl("button", {
			text: this.plugin.isSyncPaused() ? "Resume sync" : "Pause sync",
			attr: {
				"aria-label": this.plugin.isSyncPaused()
					? "Resume automatic sync"
					: "Pause automatic sync for 24 hours",
			},
		});
		this.pauseButton = pauseBtn;
		pauseBtn.disabled = !syncEnabled(s) || this.plugin.sync.progress !== null;
		pauseBtn.addEventListener("click", async () => {
			pauseBtn.disabled = true;
			await this.plugin.setSyncPaused(!this.plugin.isSyncPaused());
			this.render();
		});

		if (s.accessToken) {
			const outBtn = actions.createEl("button", { text: "Sign out" });
			outBtn.addEventListener("click", () => {
				this.plugin.signOut();
				this.refresh();
			});
		} else {
			const inBtn = actions.createEl("button", { text: "Sign in" });
			inBtn.addEventListener("click", () => this.openSetup());
		}

		this.progressEl = el.createDiv({ cls: "openlore-sync-progress" });
		this.updateProgress(this.plugin.sync.progress);
	}

	private updateProgress(progress: SyncProgress | null): void {
		if (progress === null) this.updateLastSync();
		if (this.syncButton) {
			this.syncButton.textContent = progress ? "Syncing…" : "Sync now";
			this.syncButton.disabled =
				progress !== null || !syncEnabled(this.plugin.settings);
		}
		if (this.pauseButton) {
			this.pauseButton.disabled =
				progress !== null || !syncEnabled(this.plugin.settings);
		}
		if (!this.progressEl) return;
		this.progressEl.empty();
		this.progressEl.toggleClass("is-active", progress !== null);
		if (!progress) return;

		const row = this.progressEl.createDiv({ cls: "openlore-progress-label" });
		row.createSpan({ text: progress.phase === "pulling" ? "Pulling" : "Pushing" });
		row.createSpan({
			text:
				progress.total > 0
					? `${progress.completed} / ${progress.total}`
					: "Preparing…",
		});
		const bar = this.progressEl.createEl("progress", {
			attr: {
				max: "100",
				value: String(Math.max(0, Math.min(100, progress.percent))),
				"aria-label": "OpenLore sync progress",
			},
		});
		bar.value = progress.percent;
		this.progressEl.createDiv({
			cls: "openlore-progress-current",
			text: progress.current,
		});
	}

	private updateLastSync(): void {
		if (!this.lastSyncEl) return;
		const lastSync = this.plugin.sync.lastSync;
		this.lastSyncEl.toggleAttribute("hidden", lastSync === null);
		this.lastSyncEl.setText(
			lastSync ? `Last sync: ${lastSync.toLocaleTimeString()}` : ""
		);
	}

	private updateErrors(): void {
		if (!this.errorsEl) return;
		const errors = Array.from(this.plugin.sync.errorPaths.entries());
		this.errorsEl.empty();
		this.errorsEl.toggleClass("is-active", errors.length > 0);
		if (errors.length === 0) return;

		const details = this.errorsEl.createEl("details");
		details.open = this.errorsExpanded;
		details.addEventListener("toggle", () => {
			this.errorsExpanded = details.open;
		});
		const summary = details.createEl("summary");
		const summaryIcon = summary.createSpan({ cls: "openlore-sync-errors-icon" });
		setIcon(summaryIcon, "circle-alert");
		summary.createSpan({
			cls: "openlore-sync-errors-title",
			text: "Sync errors",
		});
		summary.createSpan({
			cls: "openlore-sync-errors-count",
			text: String(errors.length),
			attr: {
				"aria-label": `${errors.length} sync error${errors.length === 1 ? "" : "s"}`,
			},
		});
		details.createDiv({
			cls: "openlore-sync-errors-summary",
			text: "These files need attention. Everything else was still processed.",
		});
		const list = details.createDiv({ cls: "openlore-sync-errors-list" });
		for (const [path, message] of errors) {
			const item = list.createDiv({ cls: "openlore-sync-error-item" });
			const itemHeader = item.createDiv({ cls: "openlore-sync-error-header" });
			const fileIcon = itemHeader.createSpan({ cls: "openlore-sync-error-icon" });
			setIcon(fileIcon, "file-warning");
			const pathButton = itemHeader.createEl("button", {
				cls: "openlore-sync-error-path",
				text: path,
				attr: { title: `Open ${path}` },
			});
			pathButton.addEventListener("click", () => {
				void this.app.workspace.openLinkText(path, "", false);
			});
			item.createDiv({ cls: "openlore-sync-error-message", text: message });
		}
	}

	private renderMappings(el: HTMLElement): void {
		const s = this.plugin.settings;
		const row = el.createDiv({ cls: "openlore-title-row openlore-section-row" });
		row.createEl("h5", { text: "Synced folders", cls: "openlore-section" });
		const addBtn = row.createEl("button", {
			cls: "clickable-icon",
			attr: { "aria-label": "Add folder" },
		});
		setIcon(addBtn, "plus");
		addBtn.toggleAttribute("disabled", !syncEnabled(s));
		addBtn.addEventListener("click", () => this.openMapFolder());

		// The whole-vault home mapping is shown in the status section and can't
		// be unmapped here — only explicit carve-out (`.lore`) folders are
		// listed as removable synced folders.
		const mappings = this.plugin.mappings.filter((m) => !m.isHome);
		if (mappings.length === 0) {
			el.createDiv({
				cls: "openlore-empty",
				text: "No folders synced yet. Add one to start.",
			});
			return;
		}

		const list = el.createDiv({ cls: "openlore-list" });
		for (const m of mappings) {
			const item = list.createDiv({ cls: "openlore-item openlore-map-item" });
			const info = item.createDiv({ cls: "openlore-map-info" });
			info.createSpan({ cls: "openlore-claim", text: m.vaultPath });
			const access = m.mount
				? m.access === "rw"
					? "read/write"
					: "read-only"
				: "docset unavailable";
			info.createDiv({
				cls: "openlore-status-sub",
				text: `→ ${m.docset} · ${access}`,
			});

			const unmap = item.createEl("button", {
				cls: "clickable-icon",
				attr: { "aria-label": "Unmap folder" },
			});
			setIcon(unmap, "unlink");
			unmap.addEventListener("click", async () => {
				await this.plugin.removeMapping(m.vaultPath);
				new Notice(`OpenLore: unmapped ${m.vaultPath}`);
				this.render();
			});
		}
	}

	private openMapFolder(): void {
		new MapFolderModal(this.app, this.plugin, () => this.render()).open();
	}

	private openSetup(): void {
		new OnboardingModal(this.app, this.plugin, () => {
			void this.refresh();
		}).open();
	}
}
