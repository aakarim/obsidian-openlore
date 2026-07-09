import { App, Modal, Setting } from "obsidian";
import type OpenLorePlugin from "../main";

/**
 * One-time confirmation before OpenLore starts pushing the user's whole vault
 * up to their home folder. Shows how many notes will be uploaded and to where,
 * so turning on whole-vault sync is always a deliberate choice.
 */
export class HomeConsentModal extends Modal {
	constructor(
		app: App,
		private plugin: OpenLorePlugin,
		private onConfirm: () => void
	) {
		super(app);
	}

	/** Markdown files that would be pushed to home (not owned by a carve-out). */
	private homeFileCount(): number {
		return this.plugin.app.vault.getMarkdownFiles().filter((f) => {
			// A file goes to home unless a more-specific carve-out mapping owns it.
			const m = this.plugin.sync.mappingFor(f.path);
			return !m || m.isHome;
		}).length;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("openlore-onboarding");

		const brand = contentEl.createDiv({ cls: "openlore-brand" });
		brand.createSpan({ cls: "openlore-brand-mark", text: "☁️" });
		brand.createEl("h2", { text: "Sync your vault to home?" });

		const count = this.homeFileCount();
		const s = this.plugin.settings;
		contentEl.createEl("p", {
			cls: "openlore-brand-sub",
			text:
				`OpenLore will upload ${count} note${count === 1 ? "" : "s"} from your vault ` +
				`to your home folder "${s.homeDocset}" on ${s.serverUrl}. Your shared ` +
				`(mapped) folders are excluded, and your notes stay on this device too.`,
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Not now").onClick(() => this.close())
			)
			.addButton((b) =>
				b
					.setButtonText(
						`Upload ${count} note${count === 1 ? "" : "s"}`
					)
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
