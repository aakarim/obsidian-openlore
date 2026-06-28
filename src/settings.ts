import { App, PluginSettingTab, Setting } from "obsidian";
import type OpenLorePlugin from "../main";

export class OpenLoreSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: OpenLorePlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "OpenLore Settings" });

		// Server connection
		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("Your OpenLore knowledge-backend URL (e.g. https://openlore.sh)")
			.addText((text) =>
				text
					.setPlaceholder("https://openlore.sh")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API Token")
			.setDesc("Bearer token for authentication. Leave blank in demo mode.")
			.addText((text) => {
				text
					.setPlaceholder("Optional bearer token")
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Agent ID")
			.setDesc("Acting-agent identity recorded as provenance on every write")
			.addText((text) =>
				text
					.setPlaceholder("obsidian-openlore")
					.setValue(this.plugin.settings.agentId)
					.onChange(async (value) => {
						this.plugin.settings.agentId =
							value.trim() || "obsidian-openlore";
						await this.plugin.saveSettings();
					})
			);

		// Publish settings
		containerEl.createEl("h3", { text: "Publishing" });

		new Setting(containerEl)
			.setName("Auto-publish on change")
			.setDesc("Automatically publish notes to OpenLore as you edit them")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoPublish)
					.onChange(async (value) => {
						this.plugin.settings.autoPublish = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-publish delay")
			.setDesc(
				"Seconds of inactivity to wait after edits before publishing a batch"
			)
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.autoPublishDelaySeconds))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 1) {
							this.plugin.settings.autoPublishDelaySeconds = num;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Sync whole vault on startup")
			.setDesc("Publish every eligible note once each time the vault opens")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		// Folder filtering
		containerEl.createEl("h3", { text: "Watched Folders" });

		const folderDesc = containerEl.createEl("p", {
			cls: "setting-item-description",
		});
		folderDesc.setText(
			"Select which folders to watch. If none are selected, all folders are watched."
		);

		const allFolders = this.getVaultFolders();
		for (const folder of allFolders) {
			new Setting(containerEl).setName(folder + "/").addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.watchedFolders.includes(folder))
					.onChange(async (value) => {
						if (value) {
							if (!this.plugin.settings.watchedFolders.includes(folder)) {
								this.plugin.settings.watchedFolders.push(folder);
							}
						} else {
							this.plugin.settings.watchedFolders =
								this.plugin.settings.watchedFolders.filter(
									(f) => f !== folder
								);
						}
						await this.plugin.saveSettings();
					})
			);
		}

		// Exclusions
		containerEl.createEl("h3", { text: "Exclusions" });

		new Setting(containerEl)
			.setName("Exclude tags")
			.setDesc("Comma-separated tags to exclude (without #)")
			.addText((text) =>
				text
					.setPlaceholder("personal, draft")
					.setValue(this.plugin.settings.excludeTags.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.excludeTags = value
							.split(",")
							.map((t) => t.trim().toLowerCase())
							.filter((t) => t.length > 0);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Exclude folders")
			.setDesc("Comma-separated folder names to exclude")
			.addText((text) =>
				text
					.setPlaceholder("Daily Notes")
					.setValue(this.plugin.settings.excludeFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.excludeFolders = value
							.split(",")
							.map((f) => f.trim())
							.filter((f) => f.length > 0);
						await this.plugin.saveSettings();
					})
			);
	}

	private getVaultFolders(): string[] {
		const folders: string[] = [];
		const root = this.app.vault.getRoot();

		const walk = (path: string) => {
			const children = root.children;
			// Use the vault's internal folder listing
		};

		// Get all folders from the vault's file list
		const allFiles = this.app.vault.getAllLoadedFiles();
		const folderSet = new Set<string>();
		for (const f of allFiles) {
			if ("children" in f && f.parent) {
				folderSet.add(f.path);
			}
		}

		// Only return top-level folders
		for (const p of folderSet) {
			if (!p.includes("/")) {
				folders.push(p);
			}
		}

		return folders.sort();
	}
}
