import type { App } from "obsidian";

/**
 * IndexedDB schema version — the object-store layout. Bump this only when the
 * set of object stores changes (handled in `onupgradeneeded`). It is separate
 * from the per-payload `Versioned.v` data versions below.
 */
const DB_VERSION = 1;
const STORE = "kv";

/** Object-store keys. */
export const SYNC_STATE_KEY = "sync-state";
export const SETTINGS_KEY = "settings";
export const PENDING_AUTH_KEY = "pending-auth";

/**
 * A stored value tagged with a monotonically increasing data-schema version.
 * The version lets us migrate the *shape* of a payload later without guessing:
 * on read, callers step `v` forward through their own migration functions.
 */
export interface Versioned<T> {
	v: number;
	data: T;
}

/**
 * Per-vault database name. IndexedDB is shared across the whole Obsidian app
 * (one origin for every vault), so we namespace by the vault's app id. `appId`
 * isn't in the public typings but is stable at runtime (the same identifier
 * Relay uses); we fall back to the vault name if it's ever absent.
 */
function dbName(app: App): string {
	const id = (app as unknown as { appId?: string }).appId || app.vault.getName();
	return `openlore-${id}`;
}

function openDb(app: App): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(dbName(app), DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error("IndexedDB open blocked"));
	});
}

/**
 * A tiny key-value store backed by Obsidian's own IndexedDB. This lives in the
 * app's private storage (device-local), so nothing here is ever touched by
 * Obsidian Sync, iCloud, Dropbox, etc. — unlike files under `.obsidian/`.
 *
 * Values are stored structured-cloned as-is; wrap them in `Versioned<T>` so the
 * data schema can be migrated later.
 */
export class KVStore {
	private dbp: Promise<IDBDatabase> | null = null;

	constructor(private app: App) {}

	private db(): Promise<IDBDatabase> {
		return (this.dbp ??= openDb(this.app));
	}

	async get<T>(key: string): Promise<T | undefined> {
		const db = await this.db();
		return new Promise<T | undefined>((resolve, reject) => {
			const tx = db.transaction(STORE, "readonly");
			const req = tx.objectStore(STORE).get(key);
			req.onsuccess = () => resolve(req.result as T | undefined);
			req.onerror = () => reject(req.error);
		});
	}

	async set<T>(key: string, value: T): Promise<void> {
		const db = await this.db();
		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).put(value, key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	async delete(key: string): Promise<void> {
		const db = await this.db();
		return new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	close(): void {
		if (this.dbp) {
			void this.dbp.then((db) => db.close()).catch(() => {});
			this.dbp = null;
		}
	}
}
