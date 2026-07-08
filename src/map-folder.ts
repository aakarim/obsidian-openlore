import { App, Modal, Setting, Notice, normalizePath } from "obsidian";
import type OpenLorePlugin from "../main";
import { DocsetRow } from "./types";

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

	constructor(
		app: App,
		private plugin: OpenLorePlugin,
		private onDone: () => void
	) {
		super(app);
	}

	onOpen(): void {
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

		let pathText: import("obsidian").TextComponent;

		new Setting(contentEl)
			.setName("Docset")
			.setDesc("Which server docset to sync into your vault")
			.addDropdown((d) => {
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
							pathText?.setValue(this.vaultPath);
						}
					}
				});
			});

		new Setting(contentEl)
			.setName("Vault folder")
			.setDesc("Where it lives in your vault (you can rename it later)")
			.addText((t) => {
				pathText = t;
				t.setPlaceholder("Folder path")
					.setValue(this.vaultPath)
					.onChange((v) => {
						this.vaultPath = v;
						this.pathEdited = true;
					});
			});

		this.status = contentEl.createDiv({ cls: "openlore-onboarding-status" });

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Add folder")
				.setCta()
				.onClick(() => void this.add())
		);
	}

	private available(): DocsetRow[] {
		const taken = new Set(this.plugin.mappings.map((m) => m.docset));
		return this.plugin.settings.docsets.filter((d) => !taken.has(d.name));
	}

	private suggestPath(ds: DocsetRow): string {
		const base = this.plugin.settings.vaultRoot?.trim();
		return normalizePath(base ? `${base}/${ds.name}` : ds.name);
	}

	private setStatus(msg: string, error = false): void {
		if (!this.status) return;
		this.status.setText(msg);
		this.status.toggleClass("is-error", error);
	}

	private async add(): Promise<void> {
		if (this.busy) return;
		const path = normalizePath(this.vaultPath.trim().replace(/^\/+|\/+$/g, ""));
		if (!path) return this.setStatus("Enter a vault folder path.", true);
		if (this.plugin.mappings.some((m) => m.vaultPath === path)) {
			return this.setStatus("That folder is already mapped.", true);
		}

		this.busy = true;
		this.setStatus("Creating folder and pulling…");
		try {
			await this.plugin.addMapping(this.docset, path);
			new Notice(`OpenLore: mapped ${this.docset} → ${path}`);
			this.close();
			this.onDone();
		} catch (e) {
			this.busy = false;
			const msg = e instanceof Error ? e.message : "failed to map folder";
			this.setStatus(msg, true);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
