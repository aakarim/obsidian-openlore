import { ItemView, WorkspaceLeaf, setIcon, Setting, Notice } from "obsidian";
import type OpenLorePlugin from "../main";
import { settingsValid } from "./types";
import { OnboardingModal } from "./onboarding";
import { MapFolderModal } from "./map-folder";

export const SIDEBAR_VIEW_TYPE = "openlore-view";

/**
 * OpenLore control panel: connection status, settings, synced-folder mappings,
 * and sync actions. This is the primary settings surface for the plugin.
 */
export class OpenLoreSidebarView extends ItemView {
	private status: "ok" | "error" | "loading" = "loading";
	private error: string | null = null;

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
		this.render();
		await this.refresh();
	}

	async onClose(): Promise<void> {
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
		if (this.error) {
			box.createDiv({ cls: "openlore-status-err", text: this.error });
		}
		if (this.plugin.sync.lastSync) {
			box.createDiv({
				cls: "openlore-status-sub",
				text: `Last sync: ${this.plugin.sync.lastSync.toLocaleTimeString()}`,
			});
		}
	}

	private renderActions(el: HTMLElement): void {
		const s = this.plugin.settings;
		const actions = el.createDiv({ cls: "openlore-actions" });

		const syncBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: "Sync now",
		});
		syncBtn.disabled = !settingsValid(s);
		syncBtn.addEventListener("click", async () => {
			syncBtn.disabled = true;
			syncBtn.textContent = "Syncing…";
			await this.plugin.syncNow();
			await this.refresh();
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
		addBtn.toggleAttribute("disabled", !settingsValid(s));
		addBtn.addEventListener("click", () => this.openMapFolder());

		if (this.plugin.mappings.length === 0) {
			el.createDiv({
				cls: "openlore-empty",
				text: "No folders synced yet. Add one to start.",
			});
			return;
		}

		const list = el.createDiv({ cls: "openlore-list" });
		for (const m of this.plugin.mappings) {
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
