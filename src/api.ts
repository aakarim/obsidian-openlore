import { requestUrl } from "obsidian";
import { Proposal } from "./types";

/**
 * HTTP client for the OpenLore knowledge-backend.
 *
 * Obsidian is a thin acting surface: publishing a note ingests the raw
 * markdown (`POST /ingest/transcript`) and triggers synchronous extraction
 * (`POST /process/transcripts`). Extracted facts land in the proposal review
 * queue (`/ontology/proposals`), which the sidebar accepts or rejects. No
 * local heuristic extraction happens in the plugin — the backend owns it.
 */
export class OpenLoreAPI {
	constructor(
		private serverUrl: string,
		private apiToken: string,
		private agentId: string
	) {}

	private url(path: string): string {
		return `${this.serverUrl.replace(/\/+$/, "")}${path}`;
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = { "Content-Type": "application/json" };
		if (this.apiToken) {
			h["Authorization"] = `Bearer ${this.apiToken}`;
		}
		return h;
	}

	/**
	 * Publish a note's raw markdown to the knowledge backend as a transcript.
	 * Provenance (acting agent) and the observation time are recorded.
	 */
	async publishNote(
		path: string,
		content: string,
		observedAt: Date
	): Promise<{ id: string }> {
		const body = `# Source: ${path}\n\n${content}`;
		const response = await requestUrl({
			url: this.url("/ingest/transcript"),
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({
				actor: this.agentId,
				tool: "obsidian",
				agent_id: this.agentId,
				timestamp: observedAt.toISOString(),
				content: body,
			}),
		});
		return response.json;
	}

	/**
	 * Trigger synchronous extraction of all unprocessed transcripts. Returns
	 * after staged assertions have been created.
	 */
	async processTranscripts(): Promise<unknown> {
		const response = await requestUrl({
			url: this.url("/process/transcripts"),
			method: "POST",
			headers: this.headers(),
			body: "{}",
		});
		return response.json;
	}

	/** Fetch staged assertions awaiting review. */
	async listProposals(status = "pending"): Promise<Proposal[]> {
		const response = await requestUrl({
			url: this.url(`/ontology/proposals?status=${encodeURIComponent(status)}`),
			method: "GET",
			headers: this.headers(),
		});
		const json = response.json;
		// Endpoint returns either a bare array or { proposals: [...] }.
		if (Array.isArray(json)) return json;
		return json?.proposals ?? [];
	}

	/** Accept a staged assertion into the knowledge base. */
	async approveProposal(id: string): Promise<void> {
		await requestUrl({
			url: this.url(`/ontology/proposals/${encodeURIComponent(id)}/approve`),
			method: "POST",
			headers: this.headers(),
			body: "{}",
		});
	}

	/** Reject a staged assertion. */
	async rejectProposal(id: string): Promise<void> {
		await requestUrl({
			url: this.url(`/ontology/proposals/${encodeURIComponent(id)}/reject`),
			method: "POST",
			headers: this.headers(),
			body: "{}",
		});
	}
}
