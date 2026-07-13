import { App, Modal, Setting } from "obsidian";
import type OpenLorePlugin from "../main";
import { homeCandidates, homeStatus, settingsValid } from "./types";

/**
 * Branded first-run setup, in two steps:
 *  1. Enter the lore server and sign in through the server's passkey login in
 *     your browser (OAuth authorization-code + PKCE).
 *  2. Choose your home folder — a read/write docset that your whole vault syncs
 *     up to. Sync stays disabled until a writable home is selected.
 */
export class OnboardingModal extends Modal {
	private serverUrl: string;
	private busy = false;
	private noIdentity = false;
	private homeChoice = "";
	private status?: HTMLElement;
	private signInButton?: import("obsidian").ButtonComponent;
	private preparedServerUrl = "";
	private preparation = 0;
	private unsubscribeAuthRecovery: (() => void) | null = null;

	constructor(
		app: App,
		private plugin: OpenLorePlugin,
		private onDone: () => void
	) {
		super(app);
		this.serverUrl = plugin.settings.serverUrl;
	}

	onOpen(): void {
		this.unsubscribeAuthRecovery = this.plugin.onAuthRecovery((error) => {
			this.busy = false;
			if (error) this.setStatus(error, true);
			else this.render();
		});
		this.render();
	}

	/** Show the step that matches the current state, or finish when ready. */
	private render(): void {
		const s = this.plugin.settings;
		if (!settingsValid(s)) return this.renderSignIn();
		if (!homeStatus(s).ok) return this.renderHome();
		this.close();
		this.onDone();
	}

	// ---- Step 1: sign in ----

	private renderSignIn(): void {
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
					.onChange((v) => {
						this.serverUrl = v;
						this.preparedServerUrl = "";
						this.preparation++;
						this.signInButton
							?.setButtonText("Prepare sign-in")
							.setDisabled(false);
					})
			);

		this.status = contentEl.createDiv({ cls: "openlore-onboarding-status" });

		if (this.noIdentity) {
			this.renderBanner(
				"Signed in without an identity",
				"Your passkey isn't bound to an OpenLore identity, so the server " +
					"issued an anonymous token. On the server, register a passkey " +
					"for your identity with `passkey register --identity <name>`, " +
					"then sign in again."
			);
		}

		new Setting(contentEl).addButton((b) => {
			this.signInButton = b;
			b
				.setButtonText("Prepare sign-in")
				.setCta()
				.onClick(() => void this.signIn());
		});
	}

	private async prepareSignIn(): Promise<boolean> {
		const serverUrl = this.serverUrl.trim().replace(/\/+$/, "");
		if (!serverUrl) {
			this.signInButton?.setButtonText("Prepare sign-in").setDisabled(false);
			return false;
		}
		const preparation = ++this.preparation;
		this.signInButton?.setButtonText("Preparing sign-in…").setDisabled(true);
		try {
			const ready = await this.plugin.prepareSignIn(serverUrl);
			if (!ready || preparation !== this.preparation) return false;
			this.preparedServerUrl = serverUrl;
			this.signInButton?.setButtonText("Sign in with OpenLore").setDisabled(false);
			return true;
		} catch (e) {
			if (preparation !== this.preparation) return false;
			const msg = e instanceof Error ? e.message : "could not prepare sign-in";
			this.setStatus(msg, true);
			this.signInButton?.setButtonText("Try again").setDisabled(false);
			return false;
		}
	}

	private async signIn(): Promise<void> {
		if (this.busy) return;
		this.serverUrl = this.serverUrl.trim().replace(/\/+$/, "");
		if (!this.serverUrl) return this.setStatus("Enter the server URL.", true);
		if (this.preparedServerUrl !== this.serverUrl) {
			await this.prepareSignIn();
			return;
		}

		this.noIdentity = false;
		this.busy = true;
		this.setStatus("Complete sign-in in your browser, then return to Obsidian…");
		try {
			// Call before the first await so window.open remains in the tap gesture.
			const completed = this.plugin.signIn(this.serverUrl);
			await completed;
			this.busy = false;
			if (!this.plugin.settings.identity) {
				this.noIdentity = true;
				this.renderSignIn();
				return;
			}
			// Signed in — advance to home selection.
			this.render();
		} catch (e) {
			this.busy = false;
			const msg = e instanceof Error ? e.message : "sign-in failed";
			this.setStatus(msg, true);
		}
	}

	// ---- Step 2: choose home folder ----

	private renderHome(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("openlore-onboarding");

		const brand = contentEl.createDiv({ cls: "openlore-brand" });
		brand.createSpan({ cls: "openlore-brand-mark", text: "🏠" });
		brand.createEl("h2", { text: "Choose your home folder" });
		contentEl.createEl("p", {
			cls: "openlore-brand-sub",
			text: "Your vault syncs up to this folder so your agents can read it. It must be read/write.",
		});

		if (this.plugin.isObsidianSyncActive()) {
			this.renderBanner(
				"Obsidian Sync is on",
				"Obsidian Sync and OpenLore must not sync the same files, or you " +
					"risk conflicts and data loss. After setup, exclude your OpenLore " +
					"folders in Settings → Sync → Excluded folders (or use only one " +
					"service on any given folder)."
			);
		}

		const candidates = homeCandidates(this.plugin.settings.docsets);
		if (candidates.length === 0) {
			this.renderBanner(
				"No writable docsets",
				"You don't have write access to any docsets, so there's nowhere to " +
					"put your home folder. Ask your server admin to grant you a " +
					"read/write docset, then reopen setup."
			);
			return;
		}

		if (!candidates.some((d) => d.name === this.homeChoice)) {
			this.homeChoice = candidates[0].name;
		}

		new Setting(contentEl)
			.setName("Home folder")
			.setDesc("The read/write docset your vault syncs to")
			.addDropdown((d) => {
				for (const ds of candidates) d.addOption(ds.name, ds.name);
				d.setValue(this.homeChoice);
				d.onChange((v) => (this.homeChoice = v));
			});

		this.status = contentEl.createDiv({ cls: "openlore-onboarding-status" });

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Use this home folder")
				.setCta()
				.onClick(() => void this.confirmHome())
		);
	}

	private async confirmHome(): Promise<void> {
		if (this.busy) return;
		if (!this.homeChoice) return this.setStatus("Pick a home folder.", true);

		this.busy = true;
		this.setStatus("Setting up your home folder…");
		try {
			await this.plugin.selectHome(this.homeChoice);
			this.busy = false;
			this.close();
			this.onDone();
		} catch (e) {
			this.busy = false;
			const msg = e instanceof Error ? e.message : "could not set home folder";
			this.setStatus(msg, true);
		}
	}

	// ---- Shared helpers ----

	private setStatus(msg: string, error = false): void {
		if (!this.status) return;
		this.status.setText(msg);
		this.status.toggleClass("is-error", error);
	}

	private renderBanner(title: string, detail: string): void {
		const b = this.contentEl.createDiv({ cls: "openlore-warning" });
		b.createDiv({ cls: "openlore-warning-title", text: `⚠ ${title}` });
		b.createDiv({ cls: "openlore-warning-body", text: detail });
	}

	onClose(): void {
		this.unsubscribeAuthRecovery?.();
		this.unsubscribeAuthRecovery = null;
		this.contentEl.empty();
	}
}
