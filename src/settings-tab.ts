import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type OpenLorePlugin from "../main";
import { homeCandidates, homeStatus, homeStatusMessage } from "./types";

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

		new Setting(containerEl).setName("Home").setHeading();

		const candidates = homeCandidates(s.docsets, s.homeDocset);
		const homeSetting = new Setting(containerEl)
			.setName("Home folder")
			.setDesc(
				"The read/write docset your whole vault syncs to. Sync stays disabled until this is set."
			);

		if (candidates.length === 0) {
			homeSetting.descEl.createDiv({
				cls: "openlore-status-err",
				text: "No read/write docsets available. Ask your admin for write access.",
			});
		} else {
			homeSetting.addDropdown((d) => {
				d.addOption("", "— select —");
				let hasCurrent = false;
				for (const ds of candidates) {
					d.addOption(ds.name, ds.name);
					if (ds.name === s.homeDocset) hasCurrent = true;
				}
				// Keep a stale/unavailable selection visible so the user sees it.
				if (s.homeDocset && !hasCurrent) {
					d.addOption(s.homeDocset, `${s.homeDocset} (unavailable)`);
				}
				d.setValue(s.homeDocset);
				d.onChange(async (v) => {
					if (v) await this.plugin.selectHome(v);
				});
			});
		}

		const st = homeStatus(s);
		if (!st.ok && s.homeDocset) {
			homeSetting.descEl.createDiv({
				cls: "openlore-status-err",
				text: homeStatusMessage(st),
			});
		}

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
			.setName("Sync interval")
			.setDesc("Minutes between automatic two-way syncs with the server.")
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

		new Setting(containerEl).setName("Developer").setHeading();

		new Setting(containerEl)
			.setName("Developer diagnostics")
			.setDesc(
				Platform.isDesktopApp
					? `Write sanitized sync diagnostics to ${this.plugin.developerLogPath}. The log contains paths and server errors, but never tokens or note contents.`
					: "Developer diagnostics are only available in the desktop app."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(Platform.isDesktopApp && s.developerMode)
					.setDisabled(!Platform.isDesktopApp)
					.onChange(async (enabled) => {
						await this.plugin.setDeveloperMode(enabled);
					})
			);
	}
}
