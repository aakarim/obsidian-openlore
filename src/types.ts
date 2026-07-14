/** A docset the signed-in identity can access, from `lore docsets`. */
export interface DocsetRow {
	/** Docset name. */
	name: string;
	/** Direct filesystem writability. */
	access: "r" | "rw";
	/** Named attribute tokens such as `home`, `inbox`, or `alias`. */
	attributes: string[];
	/** Display (virtual) paths mounted for this docset. */
	paths: string[];
}

/** A vault folder mapped to a server docset (persisted via its `.lore` file). */
export interface FolderMapping {
	/** Folder path in the vault. */
	vaultPath: string;
	/** Docset name this folder maps to. */
	docset: string;
}

/** A mapping resolved against the current docset list (mount + access filled). */
export interface ResolvedMapping extends FolderMapping {
	/** The docset's mount root (virtual path), or "" if the docset is unknown. */
	mount: string;
	/** Direct writability of the docset, or "r" if unknown. */
	access: "r" | "rw";
	/**
	 * The implicit whole-vault home mapping (vaultPath ""). Set only for the
	 * synthesized root→home docset mapping, never for `.lore`-backed folders.
	 */
	isHome?: boolean;
}

/** Plugin settings persisted to data.json. */
export interface OpenLoreSettings {
	/** Lore server base URL (e.g. https://openlore.sh). */
	serverUrl: string;
	/** OAuth access token (ES256 JWT) presented as a bearer to the server. */
	accessToken: string;
	/** OAuth refresh token, rotated on every use. */
	refreshToken: string;
	/** Access-token expiry (epoch ms); used to refresh proactively. */
	tokenExpiresAt: number;
	/** Signed-in identity (`sub` from the token). */
	identity: string;
	/** Name of the docset you selected as your home folder. Must be writable. */
	homeDocset: string;
	/** Primary virtual path of the selected home docset ($HOME on the server). */
	homePath: string;
	/**
	 * The home docset name the user consented to sync their whole vault into.
	 * Whole-vault push only turns on when this equals `homeDocset` — so changing
	 * home requires re-consent before anything is uploaded to the new docset.
	 */
	homeSyncConsentedFor: string;
	/** Cached docset list from the last `lore docsets`. */
	docsets: DocsetRow[];
	/** Default base folder suggested when mapping a new docset. */
	vaultRoot: string;
	/** How often to pull docsets (minutes). */
	pullIntervalMinutes: number;
	/** Quiet period (seconds) after edits before pushing your changes. */
	autoSyncDelaySeconds: number;
	/** Write sanitized sync diagnostics to /tmp on desktop. */
	developerMode: boolean;
	/** Whether the user has signed in at least once. */
	onboardingComplete: boolean;
}

export const DEFAULT_SETTINGS: OpenLoreSettings = {
	serverUrl: "https://openlore.sh",
	accessToken: "",
	refreshToken: "",
	tokenExpiresAt: 0,
	identity: "",
	homeDocset: "",
	homePath: "",
	homeSyncConsentedFor: "",
	docsets: [],
	vaultRoot: "OpenLore",
	pullIntervalMinutes: 5,
	autoSyncDelaySeconds: 5,
	developerMode: false,
	onboardingComplete: false,
};

/**
 * Parse the aligned table emitted by `lore docsets`:
 *
 *   DOCSET    ACCESS  ATTRIBUTES     PATHS
 *   public    r       -              /docs/public,/docs/getting-started.md
 *   home      rw      home,publish   /home/backend
 *
 * No field contains spaces (multi-valued cells are comma-joined), so splitting
 * each row on whitespace runs yields exactly four columns.
 */
export function parseDocsets(output: string): DocsetRow[] {
	const rows: DocsetRow[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const cols = line.split(/\s+/);
		if (cols.length < 4) continue;
		const [name, access, attrs, paths] = cols;
		if (name === "DOCSET") continue; // header
		rows.push({
			name,
			access: access === "rw" ? "rw" : "r",
			attributes: attrs === "-" ? [] : attrs.split(","),
			paths: paths === "-" ? [] : paths.split(","),
		});
	}
	return rows;
}

/**
 * Docsets offered for a new connection. Alias mounts are implementation
 * conveniences and should not normally appear as separate folders. Keep an
 * alias-only docset visible when it is already configured so an existing sync
 * can still be selected and repaired.
 *
 * When the server emits both canonical and alias rows with the same docset
 * name, prefer the canonical row so dropdowns do not contain duplicate values.
 */
export function connectableDocsets(
	docsets: DocsetRow[],
	configuredNames: Iterable<string> = []
): DocsetRow[] {
	const configured = new Set(configuredNames);
	const byName = new Map<string, DocsetRow>();

	for (const docset of docsets) {
		const alias = docset.attributes.includes("alias");
		if (alias && !configured.has(docset.name)) continue;

		const current = byName.get(docset.name);
		if (!current || (current.attributes.includes("alias") && !alias)) {
			byName.set(docset.name, docset);
		}
	}

	return Array.from(byName.values());
}

/**
 * A usable connection: signed in with a real identity. This gates whether the
 * user can map folders / pick a home; it does NOT by itself enable sync (see
 * `syncEnabled`, which additionally requires a writable home folder).
 */
export function settingsValid(s: OpenLoreSettings): boolean {
	return (
		s.onboardingComplete &&
		s.accessToken.trim().length > 0 &&
		s.identity.trim().length > 0
	);
}

/** The state of the user's selected home folder, with a reason when unusable. */
export type HomeStatus =
	| { ok: true; docset: DocsetRow }
	| { ok: false; reason: "unset" | "missing" | "readonly"; name?: string };

/**
 * Resolve the selected home docset against the current docset list. Home is
 * user-selected (not derived from any attribute) and MUST be writable: the
 * whole vault is pushed up to it, so a read-only or missing home is an error.
 */
export function homeStatus(s: OpenLoreSettings): HomeStatus {
	if (!s.homeDocset) return { ok: false, reason: "unset" };
	const d = s.docsets.find((x) => x.name === s.homeDocset);
	if (!d) return { ok: false, reason: "missing", name: s.homeDocset };
	if (d.access !== "rw") return { ok: false, reason: "readonly", name: s.homeDocset };
	return { ok: true, docset: d };
}

/** Human-readable message for a non-ok home status. */
export function homeStatusMessage(st: HomeStatus): string {
	if (st.ok) return "";
	switch (st.reason) {
		case "unset":
			return "Select a home folder (a read/write docset) to enable sync.";
		case "missing":
			return `Your home folder "${st.name}" is unavailable. Select another.`;
		case "readonly":
			return `Your home folder "${st.name}" is read-only. OpenLore needs read/write access to sync. Pick a read/write docset or ask your admin.`;
	}
}

/**
 * Sync is enabled only when signed in AND a writable home folder is selected.
 * When this is false, nothing syncs at all — not home, not mapped folders.
 */
export function syncEnabled(s: OpenLoreSettings): boolean {
	return settingsValid(s) && homeStatus(s).ok;
}

/**
 * Whether whole-vault → home push is live: a writable home is selected AND the
 * user has consented to sync into that specific docset. Until then the vault
 * root is not pushed (mapped carve-out folders can still sync).
 */
export function homeSyncActive(s: OpenLoreSettings): boolean {
	return homeStatus(s).ok && s.homeSyncConsentedFor === s.homeDocset;
}

/** Docsets the user could pick as home: connectable, writable, and mounted. */
export function homeCandidates(
	docsets: DocsetRow[],
	configuredHome = ""
): DocsetRow[] {
	return connectableDocsets(docsets, configuredHome ? [configuredHome] : []).filter(
		(d) => d.access === "rw" && d.paths.length > 0
	);
}
