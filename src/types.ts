/** A docset the signed-in identity can access, from `lore docsets`. */
export interface DocsetRow {
	/** Docset name (also the local mirror folder name). */
	name: string;
	/** Direct filesystem writability. */
	access: "r" | "rw";
	/** Named attribute tokens: any of `home`, `publish`, `approval`. */
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
	/** Name of the docset carrying the `home` attribute (your folder). */
	homeDocset: string;
	/** Primary virtual path of the home docset ($HOME on the server). */
	homePath: string;
	/** Cached docset list from the last `lore docsets`. */
	docsets: DocsetRow[];
	/** Default base folder suggested when mapping a new docset. */
	vaultRoot: string;
	/** How often to pull docsets (minutes). */
	pullIntervalMinutes: number;
	/** Quiet period (seconds) after edits before pushing your changes. */
	autoSyncDelaySeconds: number;
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
	docsets: [],
	vaultRoot: "OpenLore",
	pullIntervalMinutes: 5,
	autoSyncDelaySeconds: 5,
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

/** The docset marked `home`, if any. */
export function homeDocsetOf(docsets: DocsetRow[]): DocsetRow | undefined {
	return docsets.find((d) => d.attributes.includes("home"));
}

/**
 * A usable connection: signed in with a real identity. Syncing is opt-in per
 * folder, so a home docset is no longer required — nothing syncs until the user
 * maps a folder.
 */
export function settingsValid(s: OpenLoreSettings): boolean {
	return (
		s.onboardingComplete &&
		s.accessToken.trim().length > 0 &&
		s.identity.trim().length > 0
	);
}
