import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type OpenLorePlugin from "../main";
import { Proposal } from "./types";

export const SIDEBAR_VIEW_TYPE = "openlore-view";

/**
 * Review sidebar over the OpenLore proposal queue. Lists staged assertions
 * extracted from published notes and lets the user accept or reject them.
 */
export class OpenLoreSidebarView extends ItemView {
	private proposals: Proposal[] = [];
	private selected = new Set<string>();
	private loading = false;
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
		if (!this.plugin.settings.serverUrl) {
			this.error = "Configure the server URL in settings.";
			this.render();
			return;
		}

		this.loading = true;
		this.error = null;
		this.render();

		try {
			this.proposals = await this.plugin.api.listProposals("pending");
			this.selected.clear();
		} catch (e: unknown) {
			this.error = e instanceof Error ? e.message : "Failed to fetch proposals";
			this.proposals = [];
		}

		this.loading = false;
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("openlore-sidebar");

		const header = el.createDiv({ cls: "openlore-header" });
		const titleRow = header.createDiv({ cls: "openlore-title-row" });
		titleRow.createEl("h4", { text: "OpenLore" });

		const refreshBtn = titleRow.createEl("button", {
			cls: "openlore-refresh-btn clickable-icon",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => this.refresh());

		if (this.error) {
			el.createDiv({ cls: "openlore-error", text: this.error });
			return;
		}

		if (this.loading) {
			el.createDiv({ cls: "openlore-loading", text: "Loading proposals..." });
			return;
		}

		if (this.proposals.length === 0) {
			el.createDiv({
				cls: "openlore-empty",
				text: "No staged facts to review. Publish a note first.",
			});
			return;
		}

		const badge = header.createDiv({ cls: "openlore-badge" });
		badge.createSpan({
			text: `🔔 ${this.proposals.length} fact${this.proposals.length === 1 ? "" : "s"} staged for review`,
		});

		const list = el.createDiv({ cls: "openlore-list" });

		for (const p of this.proposals) {
			const item = list.createDiv({ cls: "openlore-item" });

			const checkbox = item.createEl("input", {
				type: "checkbox",
				attr: { id: `proposal-${p.id}` },
			});
			(checkbox as HTMLInputElement).checked = this.selected.has(p.id);
			checkbox.addEventListener("change", () => {
				if ((checkbox as HTMLInputElement).checked) {
					this.selected.add(p.id);
				} else {
					this.selected.delete(p.id);
				}
				this.updateButtons();
			});

			const label = item.createEl("label", {
				attr: { for: `proposal-${p.id}` },
			});
			label.createDiv({ cls: "openlore-claim", text: `"${p.assertion}"` });

			const meta = p.entity
				? `${p.entity}`
				: p.proposal_type;
			label.createDiv({ cls: "openlore-route", text: `→ ${meta}` });
		}

		const actions = el.createDiv({ cls: "openlore-actions" });

		const acceptBtn = actions.createEl("button", {
			cls: "mod-cta openlore-promote-btn",
			text: "Accept selected",
		});
		acceptBtn.disabled = this.selected.size === 0;
		acceptBtn.addEventListener("click", () => this.review(true));

		const rejectBtn = actions.createEl("button", {
			cls: "openlore-keep-btn",
			text: "Reject selected",
		});
		rejectBtn.disabled = this.selected.size === 0;
		rejectBtn.addEventListener("click", () => this.review(false));
	}

	private updateButtons(): void {
		const acceptBtn = this.contentEl.querySelector(
			".openlore-promote-btn"
		) as HTMLButtonElement | null;
		const rejectBtn = this.contentEl.querySelector(
			".openlore-keep-btn"
		) as HTMLButtonElement | null;
		const has = this.selected.size > 0;
		if (acceptBtn) {
			acceptBtn.disabled = !has;
			acceptBtn.textContent = `Accept selected (${this.selected.size})`;
		}
		if (rejectBtn) {
			rejectBtn.disabled = !has;
			rejectBtn.textContent = `Reject selected (${this.selected.size})`;
		}
	}

	private async review(accept: boolean): Promise<void> {
		if (this.selected.size === 0) return;

		const ids = Array.from(this.selected);
		this.loading = true;
		this.render();

		try {
			for (const id of ids) {
				if (accept) {
					await this.plugin.api.approveProposal(id);
				} else {
					await this.plugin.api.rejectProposal(id);
				}
			}
			const verb = accept ? "Accepted" : "Rejected";
			this.plugin.showNotice(
				`${verb} ${ids.length} fact${ids.length === 1 ? "" : "s"}.`
			);
			await this.refresh();
		} catch (e: unknown) {
			this.error = e instanceof Error ? e.message : "Failed to update proposals";
			this.loading = false;
			this.render();
		}
	}
}
