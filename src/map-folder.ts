import {
	App,
	ButtonComponent,
	DropdownComponent,
	Modal,
	Notice,
	Setting,
	TextComponent,
	normalizePath,
} from "obsidian";
import type OpenLorePlugin from "../main";
import { connectableDocsets, DocsetRow } from "./types";

/**
 * GUI to map a server docset into a vault folder. Pick a docset, choose where it
 * lives in the vault, and the plugin creates the folder, writes its Lorefile,
 * and does an initial pull.
 */
export class MapFolderModal extends Modal {
	private docset = "";
	private vaultPath = "";
	private pathEdited = false;
	private busy = false;
	private status?: HTMLElement;
	private progressEl?: HTMLElement;
	private addButton?: ButtonComponent;
	private docsetDropdown?: DropdownComponent;
	private pathText?: TextComponent;

	constructor(
		app: App,
		private plugin: OpenLorePlugin,
		private onDone: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("openlore-onboarding");
		this.contentEl.createEl("p", {
			cls: "openlore-brand-sub",
			text: "Loading folders…",
		});
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			await this.plugin.refreshDocsets();
			this.render();
		} catch (e) {
			const msg = e instanceof Error ? e.message : "failed to load folders";
			this.contentEl.empty();
			this.contentEl.createEl("p", {
				cls: "openlore-onboarding-status is-error",
				text: msg,
			});
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("openlore-onboarding");
		contentEl.createEl("h3", { text: "Map an OpenLore folder" });

		const docsets = this.available();
		if (docsets.length === 0) {
			contentEl.createEl("p", {
				cls: "openlore-brand-sub",
				text: "No docsets available. Sign in first, or you may not have access to any docsets yet.",
			});
			return;
		}

		this.docset = docsets[0].name;
		this.vaultPath = this.suggestPath(docsets[0]);

		new Setting(contentEl)
			.setName("Docset")
			.setDesc("Which server docset to sync into your vault")
			.addDropdown((d) => {
				this.docsetDropdown = d;
				for (const ds of docsets) {
					const tag = ds.access === "rw" ? "read/write" : "read-only";
					d.addOption(ds.name, `${ds.name} (${tag})`);
				}
				d.setValue(this.docset);
				d.onChange((v) => {
					this.docset = v;
					if (!this.pathEdited) {
						const ds = docsets.find((x) => x.name === v);
						if (ds) {
							this.vaultPath = this.suggestPath(ds);
							this.pathText?.setValue(this.vaultPath);
						}
					}
				});
			});

		new Setting(contentEl)
			.setName("Vault folder")
			.setDesc("Where it lives in your vault (you can rename it later)")
			.addText((t) => {
				this.pathText = t;
				t.setPlaceholder("Folder path")
					.setValue(this.vaultPath)
					.onChange((v) => {
						this.vaultPath = v;
						this.pathEdited = true;
					});
			});

		this.status = contentEl.createDiv({ cls: "openlore-onboarding-status" });
		this.progressEl = contentEl.createDiv({ cls: "openlore-sync-progress" });

		new Setting(contentEl).addButton((b) => {
			this.addButton = b;
			b
				.setButtonText("Add folder")
				.setCta()
				.onClick(() => void this.add());
		});
	}

	private available(): DocsetRow[] {
		const taken = new Set(this.plugin.mappings.map((m) => m.docset));
		return connectableDocsets(this.plugin.settings.docsets, taken).filter(
			(d) => !taken.has(d.name)
		);
	}

	private suggestPath(ds: DocsetRow): string {
		const base = this.plugin.settings.vaultRoot?.trim();
		const serverPath = ds.paths[0]?.replace(/^\/+|\/+$/g, "") || ds.name;
		return normalizePath(base ? `${base}/${serverPath}` : serverPath);
	}

	private setStatus(msg: string, error = false): void {
		if (!this.status) return;
		this.status.setText(msg);
		this.status.toggleClass("is-error", error);
	}

	private updateProgress(completed: number, total: number, current: string): void {
		if (!this.progressEl) return;
		this.progressEl.empty();
		this.progressEl.addClass("is-active");
		const row = this.progressEl.createDiv({ cls: "openlore-progress-label" });
		row.createSpan({ text: "Adding folder" });
		row.createSpan({ text: total > 0 ? `${completed} / ${total}` : "Preparing…" });
		const progress = this.progressEl.createEl("progress", {
			attr: { max: "100", "aria-label": "Add folder progress" },
		});
		if (total > 0) progress.value = Math.min(100, (completed / total) * 100);
		this.progressEl.createDiv({
			cls: "openlore-progress-current",
			text: current,
		});
	}

	private async add(): Promise<void> {
		if (this.busy) return;
		const path = normalizePath(this.vaultPath.trim().replace(/^\/+|\/+$/g, ""));
		if (!path) return this.setStatus("Enter a vault folder path.", true);
		if (this.plugin.mappings.some((m) => m.vaultPath === path)) {
			return this.setStatus("That folder is already mapped.", true);
		}

		const docset = this.docset;
		this.busy = true;
		this.addButton?.setDisabled(true);
		this.docsetDropdown?.setDisabled(true);
		this.pathText?.setDisabled(true);
		this.setStatus("");
		this.updateProgress(0, 0, "Creating vault folder…");
		try {
			await this.plugin.addMapping(docset, path, (completed, total, current) =>
				this.updateProgress(completed, total, current)
			);
			new Notice(`OpenLore: mapped ${docset} → ${path}`);
			this.close();
			this.onDone();
		} catch (e) {
			this.busy = false;
			this.addButton?.setDisabled(false);
			this.docsetDropdown?.setDisabled(false);
			this.pathText?.setDisabled(false);
			this.progressEl?.removeClass("is-active");
			const msg = e instanceof Error ? e.message : "failed to map folder";
			this.setStatus(msg, true);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
