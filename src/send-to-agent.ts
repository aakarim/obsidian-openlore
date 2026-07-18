import {
	App,
	ButtonComponent,
	Modal,
	Setting,
	TFile,
	TFolder,
} from "obsidian";
import type OpenLorePlugin from "../main";
import { DocsetRow } from "./types";

export class SendToAgentModal extends Modal {
	private agents: DocsetRow[] = [];
	private selected = new Set<string>();
	private busy = false;
	private status?: HTMLElement;
	private shareButton?: ButtonComponent;

	constructor(
		app: App,
		private plugin: OpenLorePlugin,
		private source: TFile | TFolder,
		private vfsPath: string
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass("openlore-onboarding");
		this.contentEl.createEl("p", {
			cls: "openlore-brand-sub",
			text: "Loading agent inboxes…",
		});
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			const docsets = await this.plugin.api.listDocsets();
			const byName = new Map<string, DocsetRow>();
			for (const docset of docsets) {
				if (
					docset.attributes.includes("alias") ||
					!docset.attributes.includes("inbox") ||
					!docset.grants.some((grant) => grant === "publish" || grant === "rw")
				) {
					continue;
				}
				byName.set(docset.name, docset);
			}
			this.agents = Array.from(byName.values()).sort((a, b) =>
				a.name.localeCompare(b.name)
			);
			this.render();
		} catch (error) {
			this.showLoadError(error);
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("openlore-onboarding");
		contentEl.createEl("h3", { text: "Send to agent" });
		contentEl.createEl("p", {
			cls: "openlore-brand-sub",
			text: `Share a pointer to “${this.source.name}” from your home workspace.`,
		});

		if (this.agents.length === 0) {
			contentEl.createEl("p", {
				text: "No agent inboxes are available to you.",
			});
			return;
		}

		for (const agent of this.agents) {
			new Setting(contentEl).setName(agent.name).addToggle((toggle) =>
				toggle.onChange((checked) => {
					if (checked) this.selected.add(agent.name);
					else this.selected.delete(agent.name);
					this.shareButton?.setDisabled(this.selected.size === 0);
				})
			);
		}

		this.status = contentEl.createDiv({ cls: "openlore-onboarding-status" });
		new Setting(contentEl).addButton((button) => {
			this.shareButton = button;
			button
				.setButtonText("Share")
				.setCta()
				.setDisabled(true)
				.onClick(() => void this.share());
		});
	}

	private async share(): Promise<void> {
		if (this.busy || this.selected.size === 0) return;
		this.busy = true;
		this.shareButton?.setDisabled(true);
		this.setStatus("Syncing and sharing…");

		try {
			if (this.source instanceof TFile) {
				await this.plugin.sync.pushFile(this.source);
			} else {
				await this.plugin.sync.pushFolder(this.source.path, true);
			}

			const content = this.pointerContent();
			const fileName = this.pointerFileName();
			const recipients = Array.from(this.selected);
			const results = await Promise.allSettled(
				recipients.map((agent) =>
					this.plugin.api.publish(agent, fileName, content)
				)
			);
			const failed = recipients.filter(
				(_, index) => results[index].status === "rejected"
			);
			if (failed.length > 0) {
				this.selected = new Set(failed);
				throw new Error(`Couldn’t share with ${failed.join(", ")}.`);
			}

			this.plugin.showNotice(
				`OpenLore: shared “${this.source.name}” with ${recipients.join(", ")}.`
			);
			this.close();
		} catch (error) {
			this.busy = false;
			this.shareButton?.setDisabled(this.selected.size === 0);
			this.setStatus(
				error instanceof Error ? error.message : "Failed to share the pointer.",
				true
			);
		}
	}

	private pointerContent(): string {
		const kind = this.source instanceof TFolder ? "folder" : "file";
		const encodedPath = this.vfsPath
			.split("/")
			.map((part) => encodeURIComponent(part))
			.join("/");
		const webUrl = `${this.plugin.settings.serverUrl.replace(/\/+$/, "")}/lore${encodedPath}`;
		return [
			`# Shared ${kind}: ${this.source.name}`,
			"",
			`[Open in OpenLore](${webUrl})`,
			"",
			`OpenLore path: \`${this.vfsPath}\``,
			"",
		].join("\n");
	}

	private pointerFileName(): string {
		return this.source instanceof TFolder
			? `${this.source.name}.md`
			: this.source.name;
	}

	private showLoadError(error: unknown): void {
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			cls: "openlore-onboarding-status is-error",
			text: error instanceof Error ? error.message : "Failed to load agent inboxes.",
		});
	}

	private setStatus(message: string, error = false): void {
		if (!this.status) return;
		this.status.setText(message);
		this.status.toggleClass("is-error", error);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
