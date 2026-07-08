import { App, PluginSettingTab, Setting } from "obsidian";
import type OpenLorePlugin from "../main";

/**
 * Native Obsidian settings tab for OpenLore. Hosts connection and sync
 * configuration that used to live in the sidebar.
 */
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
		const s = this.plugin.settings;

		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl).setName("Server URL").addText((t) =>
			t.setValue(s.serverUrl).onChange(async (v) => {
				s.serverUrl = v.trim().replace(/\/+$/, "");
				await this.plugin.saveSettings();
			})
		);

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Default base folder")
			.setDesc("Suggested location when mapping a new folder.")
			.addText((t) =>
				t.setValue(s.vaultRoot).onChange(async (v) => {
					s.vaultRoot = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto-sync delay")
			.setDesc("Seconds to wait after a change before pushing to the server.")
			.addText((t) =>
				t.setValue(String(s.autoSyncDelaySeconds)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 1) {
						s.autoSyncDelaySeconds = n;
						await this.plugin.saveSettings();
					}
				})
			);

		new Setting(containerEl)
			.setName("Pull interval")
			.setDesc("Minutes between automatic pulls from the server.")
			.addText((t) =>
				t.setValue(String(s.pullIntervalMinutes)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 1) {
						s.pullIntervalMinutes = n;
						await this.plugin.saveSettings();
						this.plugin.restartPullInterval();
					}
				})
			);
	}
}
