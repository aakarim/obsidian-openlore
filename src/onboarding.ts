import { App, Modal, Setting } from "obsidian";
import type OpenLorePlugin from "../main";

/**
 * Branded first-run setup: enter the lore server, then sign in through the
 * server's passkey login in your browser (OAuth authorization-code + PKCE).
 * On success the plugin fetches your docsets and finds your home folder.
 */
export class OnboardingModal extends Modal {
	private serverUrl: string;
	private busy = false;
	private status?: HTMLElement;
	private banner?: HTMLElement;

	constructor(
		app: App,
		private plugin: OpenLorePlugin,
		private onDone: () => void
	) {
		super(app);
		this.serverUrl = plugin.settings.serverUrl;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("openlore-onboarding");

		const brand = contentEl.createDiv({ cls: "openlore-brand" });
		brand.createSpan({ cls: "openlore-brand-mark", text: "🧠" });
		brand.createEl("h2", { text: "Welcome to OpenLore" });
		contentEl.createEl("p", {
			cls: "openlore-brand-sub",
			text: "Collaborate on your agent knowledge",
		});

		new Setting(contentEl)
			.setName("Lore server URL")
			.setDesc("The shared OpenLore server your team uses")
			.addText((t) =>
				t
					.setPlaceholder("https://openlore.sh")
					.setValue(this.serverUrl)
					.onChange((v) => (this.serverUrl = v))
			);

		this.status = contentEl.createDiv({ cls: "openlore-onboarding-status" });

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Sign in with OpenLore")
				.setCta()
				.onClick(() => void this.signIn())
		);
	}

	private setStatus(msg: string, error = false): void {
		if (!this.status) return;
		this.status.setText(msg);
		this.status.toggleClass("is-error", error);
	}

	private async signIn(): Promise<void> {
		if (this.busy) return;
		this.serverUrl = this.serverUrl.trim().replace(/\/+$/, "");
		if (!this.serverUrl) return this.setStatus("Enter the server URL.", true);

		this.clearBanner();
		this.busy = true;
		this.setStatus("Opening your browser to sign in…");
		try {
			await this.plugin.signIn(this.serverUrl);
			this.busy = false;
			const s = this.plugin.settings;
			if (!s.identity) {
				this.setStatus("");
				this.renderBanner(
					"Signed in without an identity",
					"Your passkey isn't bound to an OpenLore identity, so the server " +
						"issued an anonymous token. On the server, register a passkey " +
						"for your identity with `passkey register --identity <name>`, " +
						"then sign in again."
				);
				return;
			}
			// Signed in. Folder syncing is opt-in — the panel lets you map
			// docsets into vault folders next.
			this.close();
			this.onDone();
		} catch (e) {
			this.busy = false;
			const msg = e instanceof Error ? e.message : "sign-in failed";
			this.setStatus(msg, true);
		}
	}

	private clearBanner(): void {
		this.banner?.remove();
		this.banner = undefined;
	}

	private renderBanner(title: string, detail: string): void {
		this.clearBanner();
		const b = this.contentEl.createDiv({ cls: "openlore-warning" });
		b.createDiv({ cls: "openlore-warning-title", text: `⚠ ${title}` });
		b.createDiv({ cls: "openlore-warning-body", text: detail });
		this.banner = b;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
