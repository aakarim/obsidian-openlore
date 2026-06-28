/** A staged assertion (proposal) returned by the OpenLore backend. */
export interface Proposal {
	id: string;
	/** Entity the assertion is about. */
	entity: string;
	/** The factual claim staged for review. */
	assertion: string;
	/** Why the system proposed this assertion. */
	reasoning?: string;
	proposal_type: string;
	/** pending | approved | rejected */
	status: string;
	confidence_score: number;
	partition_id?: string;
	source: string;
	created_at: string;
}

/** Plugin settings persisted to data.json. */
export interface OpenLoreSettings {
	/** Knowledge-backend base URL (e.g. https://openlore.sh). */
	serverUrl: string;
	/** Optional bearer token (left blank in demo mode). */
	apiToken: string;
	/** Acting-agent identity recorded as provenance on every write. */
	agentId: string;
	/** Folders to publish from. Empty = whole vault. */
	watchedFolders: string[];
	/** Publish notes automatically as they change. */
	autoPublish: boolean;
	/** Quiet period (seconds) to wait after edits before publishing a batch. */
	autoPublishDelaySeconds: number;
	/** Publish every eligible note once when the vault opens. */
	syncOnStartup: boolean;
	/** Skip notes carrying any of these tags. */
	excludeTags: string[];
	/** Skip notes under any of these folders. */
	excludeFolders: string[];
}

export const DEFAULT_SETTINGS: OpenLoreSettings = {
	serverUrl: "https://openlore.sh",
	apiToken: "",
	agentId: "obsidian-openlore",
	watchedFolders: [],
	autoPublish: true,
	autoPublishDelaySeconds: 5,
	syncOnStartup: false,
	excludeTags: ["personal", "draft"],
	excludeFolders: ["Daily Notes"],
};
