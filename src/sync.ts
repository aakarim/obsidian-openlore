import { TFile, debounce, normalizePath } from "obsidian";
import type OpenLorePlugin from "../main";
import { ResolvedMapping } from "./types";
import { LOREFILE } from "./lorefile";
import { SYNC_STATE_KEY, Versioned } from "./store";

export interface SyncProgress {
	phase: "pulling" | "pushing";
	percent: number;
	completed: number;
	total: number;
	current: string;
}

type SyncProgressListener = (progress: SyncProgress | null) => void;
type SyncErrorsListener = () => void;

interface PushResult {
	pushed: number;
	failed: number;
}

/**
 * Data-schema version of the persisted sync state. Monotonically increasing;
 * bump it and add a step in `migrateSyncState` whenever the stored shape
 * changes. Legacy (pre-IndexedDB) state is treated as version 0.
 */
const SYNC_STATE_VERSION = 1;

/** Bring a stored sync-state payload up to the current shape. */
function migrateSyncState(
	stored: Versioned<Record<string, string>>
): Record<string, string> {
	// No shape migrations yet. Future: `if (stored.v < 2) { … }`.
	return stored.data ?? {};
}

/** Small, stable content hash (djb2) used to detect changes and break loops. */
function hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = (h * 33) ^ s.charCodeAt(i);
	}
	return (h >>> 0).toString(16);
}

/**
 * Is a vault path inside a mapping rooted at `vaultPath`? The implicit home
 * mapping uses an empty root (""), which owns every path in the vault.
 */
function isUnder(vaultPath: string, path: string): boolean {
	if (vaultPath === "") return true;
	return path === vaultPath || path.startsWith(vaultPath + "/");
}

/** A vault path relative to its mapping root. Root ("") returns the path as-is. */
function relOf(vaultPath: string, path: string): string {
	return vaultPath === "" ? path : path.slice(vaultPath.length + 1);
}

/**
 * Two-way file sync driven by per-folder mappings. Each mapping links a vault
 * folder to a server docset:
 *
 * - Writable docsets (`access: rw`) are pushed up: local edits/creates/deletes
 *   under the folder are mirrored to the docset.
 * - Read-only docsets are pulled into the folder as a mirror (never pushed).
 *
 * Nothing syncs unless a folder is mapped. A per-path hash of the last synced
 * content prevents pulled writes from being pushed straight back up.
 */
export class SyncEngine {
	/**
	 * Content hashes of what was last synced, keyed by **server (VFS) path** —
	 * not the local vault path. Keying by VFS path means the state survives a
	 * folder being renamed/moved and correctly treats a file that changes owner
	 * (e.g. carved out of home into another docset) as a different sync target.
	 * Used to skip unchanged pushes and to break pull→push echo loops.
	 */
	private syncedHashes = new Map<string, string>();
	/**
	 * Vault paths (in writable mappings) whose local content differs from the
	 * last content synced with the server — i.e. edits not yet pushed. Drives
	 * the "dirty" badge in the file explorer.
	 */
	readonly dirtyPaths = new Set<string>();
	/**
	 * Vault paths whose last sync attempt failed, mapped to the error message.
	 * Drives the red "error" dot in the file explorer. Cleared once a file
	 * syncs successfully.
	 */
	readonly errorPaths = new Map<string, string>();
	lastSync: Date | null = null;
	progress: SyncProgress | null = null;

	private readonly saveStateDebounced: () => void;
	private readonly progressListeners = new Set<SyncProgressListener>();
	private readonly errorListeners = new Set<SyncErrorsListener>();
	/** Local deletes caused by a pull; do not echo these back to the server. */
	private readonly pullDeletedPaths = new Set<string>();

	constructor(private plugin: OpenLorePlugin) {
		this.saveStateDebounced = debounce(
			() => void this.saveState(),
			2000,
			false
		);
	}

	/**
	 * Load persisted sync hashes from IndexedDB. Call once on plugin load,
	 * before syncing. If nothing is stored yet, import the legacy
	 * `.obsidian/openlore-sync.json` (and delete it) so state no longer rides
	 * Obsidian Sync via the config folder.
	 */
	async loadState(): Promise<void> {
		try {
			const stored =
				await this.plugin.store.get<Versioned<Record<string, string>>>(
					SYNC_STATE_KEY
				);
			if (stored) {
				this.syncedHashes = new Map(
					Object.entries(migrateSyncState(stored))
				);
				return;
			}
			await this.importLegacyState();
		} catch {
			// Corrupt/missing state just means we re-verify against the server.
		}
	}

	/** One-time import of the pre-IndexedDB state file, then remove it. */
	private async importLegacyState(): Promise<void> {
		const legacy = `${this.plugin.app.vault.configDir}/openlore-sync.json`;
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(legacy))) return;
		try {
			const obj = JSON.parse(await adapter.read(legacy)) as Record<
				string,
				string
			>;
			// Write to IndexedDB first; only drop the old file once it's safely
			// stored. (saveState swallows errors, so persist directly here.)
			await this.plugin.store.set<Versioned<Record<string, string>>>(
				SYNC_STATE_KEY,
				{ v: SYNC_STATE_VERSION, data: obj }
			);
			this.syncedHashes = new Map(Object.entries(obj));
			await adapter.remove(legacy);
		} catch {
			// Ignore a corrupt/failed legacy import; state self-heals from server.
		}
	}

	/** Persist sync hashes immediately (used on unload). */
	async flushState(): Promise<void> {
		await this.saveState();
	}

	private async saveState(): Promise<void> {
		try {
			const payload: Versioned<Record<string, string>> = {
				v: SYNC_STATE_VERSION,
				data: Object.fromEntries(this.syncedHashes),
			};
			await this.plugin.store.set(SYNC_STATE_KEY, payload);
		} catch {
			// Best-effort; state rebuilds from server comparison next time.
		}
	}

	private setHash(key: string, value: string): void {
		this.syncedHashes.set(key, value);
		this.saveStateDebounced();
	}

	private delHash(key: string): void {
		if (this.syncedHashes.delete(key)) this.saveStateDebounced();
	}

	onProgress(listener: SyncProgressListener): () => void {
		this.progressListeners.add(listener);
		listener(this.progress);
		return () => this.progressListeners.delete(listener);
	}

	private setProgress(progress: SyncProgress | null): void {
		this.progress = progress;
		for (const listener of this.progressListeners) listener(progress);
	}

	onErrorsChanged(listener: SyncErrorsListener): () => void {
		this.errorListeners.add(listener);
		listener();
		return () => this.errorListeners.delete(listener);
	}

	recordError(path: string, message: string): void {
		if (this.errorPaths.get(path) === message) return;
		this.errorPaths.set(path, message);
		this.plugin.logDiagnostic("sync.file_error", { path, message });
		for (const listener of this.errorListeners) listener();
	}

	private clearError(path: string): void {
		if (!this.errorPaths.delete(path)) return;
		this.plugin.logDiagnostic("sync.file_error_cleared", { path });
		for (const listener of this.errorListeners) listener();
	}

	/**
	 * Mark a writable file dirty optimistically. Any local edit means the file
	 * diverges from the server until a push proves otherwise; the following
	 * `pushFile` reconciles (clears it, or leaves it dirty if the push fails).
	 * No-ops for files outside writable mappings.
	 */
	markDirty(path: string): void {
		if (this.writableMappingFor(path)) this.dirtyPaths.add(path);
	}

	private get mappings(): ResolvedMapping[] {
		return this.plugin.mappings;
	}

	/**
	 * The most-specific mapping that owns a vault path: the one with the longest
	 * matching `vaultPath`. This includes the implicit home mapping (root "")
	 * and mappings whose docset is currently unavailable (empty mount) — an
	 * unavailable child must still block, so its subtree never leaks up to home.
	 */
	mappingFor(path: string): ResolvedMapping | null {
		let best: ResolvedMapping | null = null;
		for (const m of this.mappings) {
			if (!isUnder(m.vaultPath, path)) continue;
			if (!best || m.vaultPath.length > best.vaultPath.length) best = m;
		}
		return best;
	}

	/** The writable mapping that owns a vault path, if the owner is writable. */
	writableMappingFor(path: string): ResolvedMapping | null {
		const m = this.mappingFor(path);
		return m && m.access === "rw" && m.mount ? m : null;
	}

	/** Is a vault path inside a writable mapped folder? */
	isUnderWritable(path: string): boolean {
		return this.writableMappingFor(path) !== null;
	}

	/**
	 * The owning mapping when it is NOT a writable (pushable) one — i.e. a
	 * read-only or currently-unavailable docset. Used to flag edits that can't
	 * be pushed.
	 */
	readOnlyMappingFor(path: string): ResolvedMapping | null {
		const m = this.mappingFor(path);
		if (!m) return null;
		return m.access === "rw" && m.mount ? null : m;
	}

	/**
	 * A local edit inside a read-only mapped folder can never be pushed. Flag it
	 * with an error so the user isn't left wondering why it didn't sync. Returns
	 * true if a new error was recorded. Pull-induced writes (which match the
	 * guard hash) are ignored.
	 */
	async flagReadOnlyEdit(file: TFile): Promise<boolean> {
		const m = this.readOnlyMappingFor(file.path);
		if (!m) return false;
		const content = await this.plugin.app.vault.read(file);
		if (m.mount && this.syncedHashes.get(this.toVfs(m, file.path)) === hash(content))
			return false;
		const msg = `"${m.docset}" is read-only — changes to this file won't sync.`;
		if (this.errorPaths.get(file.path) === msg) return false;
		this.recordError(file.path, msg);
		return true;
	}

	/** Vault path within a mapping → server virtual path. */
	private toVfs(m: ResolvedMapping, vaultPath: string): string {
		const rel = relOf(m.vaultPath, vaultPath);
		return `${m.mount.replace(/\/+$/, "")}/${rel}`;
	}

	/** Push a single local file if it lives in a writable mapped folder. */
	async pushFile(file: TFile): Promise<void> {
		if (file.extension !== "md") return;
		const m = this.writableMappingFor(file.path);
		if (!m) return;

		const content = await this.plugin.app.vault.read(file);
		const key = this.toVfs(m, file.path);
		const h = hash(content);
		if (this.syncedHashes.get(key) === h) {
			this.dirtyPaths.delete(file.path); // already matches the server
			this.clearError(file.path);
			return; // unchanged / from pull
		}

		// If the write throws the file stays dirty (retried on next edit/sync).
		await this.plugin.api.writeFile(key, content, m.mount);
		this.setHash(key, h);
		this.dirtyPaths.delete(file.path);
		this.clearError(file.path);
	}

	/** Delete the remote counterpart of a deleted local file. */
	async deleteRemote(path: string): Promise<void> {
		if (this.pullDeletedPaths.delete(path)) return;
		this.dirtyPaths.delete(path);
		this.clearError(path);
		const m = this.writableMappingFor(path);
		if (!m) return;
		if (!path.endsWith(".md")) return;
		const key = this.toVfs(m, path);
		await this.plugin.api.deleteFile(key);
		this.delHash(key);
	}

	/**
	 * Delete every remote markdown file under a deleted vault folder, in the
	 * docset that owns the folder. Used for plain (non-carve-out) folder
	 * deletions — the caller must NOT invoke this for a carve-out root, so a
	 * shared docset is never wiped by deleting its local mirror folder.
	 */
	async deleteRemoteFolder(folderPath: string): Promise<number> {
		const m = this.writableMappingFor(folderPath);
		if (!m) return 0;
		const vfsDir = this.toVfs(m, folderPath);
		let deleted = 0;
		try {
			const files = await this.plugin.api.listFiles(vfsDir);
			for (const vfs of files) {
				await this.plugin.api.deleteFile(vfs);
				this.delHash(vfs);
				deleted++;
			}
		} catch {
			// Nothing at that remote path — treat as already gone.
		}
		return deleted;
	}

	/** Push every writable-owned markdown file under a folder to its docset. */
	async pushFolder(folderPath: string, homeOnly = false): Promise<void> {
		const prefix = folderPath + "/";
		const files = this.plugin.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix));
		for (const f of files) {
			const m = this.writableMappingFor(f.path);
			if (!m) continue;
			if (homeOnly && !m.isHome) continue;
			try {
				await this.pushFile(f);
			} catch (e) {
				this.recordError(
					f.path,
					e instanceof Error ? e.message : "push failed"
				);
			}
		}
	}

	/**
	 * Propagate a folder move/rename for **home-owned** files: remove the stale
	 * copies left at the old home path and push the files at their new path.
	 * Carve-out folders keep their remote paths (their `.lore` travels with
	 * them), so the caller skips this for carve-out roots.
	 */
	async renameFolder(oldPath: string, newPath: string): Promise<void> {
		// Push the moved files at their new home path first, so a crash between
		// steps can never leave the server without a copy it still needs.
		await this.pushFolder(newPath, true);
		const home = this.mappings.find((m) => m.isHome);
		if (home && home.mount) {
			const oldVfsDir = this.toVfs(home, oldPath);
			try {
				const stale = await this.plugin.api.listFiles(oldVfsDir);
				for (const vfs of stale) {
					await this.plugin.api.deleteFile(vfs);
					this.delHash(vfs);
				}
			} catch {
				// Nothing stale at the old home path.
			}
		}
	}

	/**
	 * After a folder is carved out of home into another docset, reconcile the
	 * home docset. For a **writable** carve-out we push the local files up to the
	 * new docset and then remove their now-duplicate copies from home. For a
	 * read-only/unavailable carve-out we leave the home copies in place, so the
	 * only server copy is never deleted.
	 */
	async reconcileCarveOut(folderPath: string): Promise<void> {
		const owner = this.writableMappingFor(folderPath);
		if (!owner || owner.isHome) return; // read-only/unavailable: keep home copies
		const home = this.mappings.find((m) => m.isHome);
		const prefix = folderPath + "/";
		const files = this.plugin.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix));
		for (const f of files) {
			try {
				await this.pushFile(f); // -> the carve-out docset
			} catch (e) {
				this.recordError(
					f.path,
					e instanceof Error ? e.message : "push failed"
				);
				continue; // don't drop the home copy if the new push failed
			}
			if (home && home.mount) {
				const homeVfs = this.toVfs(home, f.path);
				try {
					await this.plugin.api.deleteFile(homeVfs);
					this.delHash(homeVfs);
				} catch {
					// No home copy to remove.
				}
			}
		}
	}

	/** Pull every mapped folder. */
	async pullAll(reportProgress = false): Promise<number> {
		let written = 0;
		const mappings = this.mappings;
		for (let i = 0; i < mappings.length; i++) {
			const m = mappings[i];
			if (reportProgress) {
				this.setProgress({
					phase: "pulling",
					percent: mappings.length === 0 ? 50 : (i / mappings.length) * 50,
					completed: 0,
					total: 0,
					current: `Checking ${m.docset}…`,
				});
			}
			written += await this.pullMapping(
				m,
				reportProgress
					? (completed, total, current) => {
							const withinMapping = total === 0 ? 1 : completed / total;
							this.setProgress({
								phase: "pulling",
								percent: ((i + withinMapping) / mappings.length) * 50,
								completed,
								total,
								current,
							});
						}
					: undefined
			);
		}
		this.lastSync = new Date();
		return written;
	}

	/** Pull a single mapped folder's docset into the vault. */
	async pullMapping(
		m: ResolvedMapping,
		onProgress?: (completed: number, total: number, current: string) => void
	): Promise<number> {
		if (!m.mount) return 0;
		const mountRoot = m.mount.replace(/\/+$/, "");
		const writable = m.access === "rw";

		let written = 0;
		// Case-insensitive index of vault files. On macOS/Windows the local FS
		// folds case, so a remote "Notes/Foo.md" and an on-disk "notes/foo.md"
		// are the same file even though Obsidian's cache keys are case-sensitive.
		// Resolving through this index lets the no-clobber and skip logic below
		// recognise the existing file instead of trying to re-create it.
		const byLower = new Map<string, TFile>();
		for (const f of this.plugin.app.vault.getFiles()) {
			byLower.set(f.path.toLowerCase(), f);
		}
		const files = await this.plugin.api.listFiles(mountRoot);
		const remoteFiles = new Set(files);
		const modificationTimes = await this.plugin.api.fileModificationTimes(files);

		// Mirror server-side deletions, but only for files this mapping previously
		// synced and whose local content is still unchanged. A locally edited file
		// is preserved; for writable mappings the push phase will recreate it.
		for (const localFile of this.plugin.app.vault.getMarkdownFiles()) {
			if (this.mappingFor(localFile.path) !== m) continue;
			const key = this.toVfs(m, localFile.path);
			if (remoteFiles.has(key)) continue;
			const lastSynced = this.syncedHashes.get(key);
			if (lastSynced === undefined) continue;
			const content = await this.plugin.app.vault.read(localFile);
			if (hash(content) !== lastSynced) continue;

			this.pullDeletedPaths.add(localFile.path);
			try {
				await this.plugin.app.vault.delete(localFile);
			} catch (e) {
				this.pullDeletedPaths.delete(localFile.path);
				throw e;
			}
			// Obsidian normally emits the delete event before `delete` resolves.
			// Avoid retaining a stale guard if an adapter omits that event.
			window.setTimeout(() => this.pullDeletedPaths.delete(localFile.path), 0);
			this.delHash(key);
			this.dirtyPaths.delete(localFile.path);
			this.clearError(localFile.path);
			byLower.delete(localFile.path.toLowerCase());
			written++;
		}

		for (let i = 0; i < files.length; i++) {
			const vfsPath = files[i];
			onProgress?.(i, files.length, vfsPath);
			if (!vfsPath.startsWith(mountRoot)) continue;
			const rel =
				vfsPath === mountRoot
					? (vfsPath.split("/").pop() ?? "")
					: vfsPath.slice(mountRoot.length + 1);
			if (!rel || rel === LOREFILE) continue;

			const localPath =
				m.vaultPath === ""
					? normalizePath(rel)
					: normalizePath(`${m.vaultPath}/${rel}`);

			// A more-specific mapping (e.g. a carve-out folder under home) owns
			// this path — leave it to that mapping's own pull.
			const owner = this.mappingFor(localPath);
			if (owner && owner !== m) continue;

			const key = this.toVfs(m, localPath);
			const exact =
				this.plugin.app.vault.getAbstractFileByPath(localPath);
			const existing: TFile | null =
				exact instanceof TFile
					? exact
					: (byLower.get(localPath.toLowerCase()) ?? null);
			// Write to the existing file's real (possibly differently-cased)
			// path so we update it in place instead of forking a case variant.
			const writePath = existing ? existing.path : localPath;
			const serverMtime = modificationTimes.get(vfsPath);
			const lastSynced = this.syncedHashes.get(key);

			// Pulled files are written with the server mtime. If both the mtime and
			// a prior sync record still match, no content transfer is necessary.
			if (
				existing instanceof TFile &&
				lastSynced !== undefined &&
				serverMtime !== undefined &&
				existing.stat.mtime === serverMtime
			) {
				continue;
			}

			const content = await this.plugin.api.readFile(vfsPath);

			if (existing instanceof TFile) {
				const current = await this.plugin.app.vault.read(existing);
				if (current === content) {
					this.setHash(key, hash(content));
					if (
						serverMtime !== undefined &&
						existing.stat.mtime !== serverMtime
					) {
						await this.writeVaultFile(writePath, content, serverMtime);
					}
					continue; // already matches the server
				}
				if (writable) {
					// Never clobber local edits to a writable folder.
					continue;
				}
				// Read-only pull is additive: only refresh a file we previously
				// pulled and that hasn't been edited locally since. A file that
				// diverges (local edits, or a pre-existing note we never synced)
				// is left untouched and flagged, never overwritten.
				const lastPulled = lastSynced;
				if (lastPulled === undefined || lastPulled !== hash(current)) {
					this.recordError(
						localPath,
						`"${m.docset}" is read-only, but this file differs from the server copy — it was not overwritten.`
					);
					continue;
				}
			}

			// Set the guard hash before writing so the resulting vault event
			// does not trigger a push back up.
			this.setHash(key, hash(content));
			this.dirtyPaths.delete(localPath);
			this.clearError(localPath);
			await this.writeVaultFile(writePath, content, serverMtime);
			// Keep the index current so a later case-variant in this same pull
			// resolves to the file we just wrote rather than re-creating it.
			const created =
				this.plugin.app.vault.getAbstractFileByPath(writePath);
			if (created instanceof TFile) {
				byLower.set(writePath.toLowerCase(), created);
			}
			written++;
		}
		onProgress?.(files.length, files.length, m.docset);
		return written;
	}

	/** Push every file inside writable mapped folders. */
	async pushAllWritable(reportProgress = false): Promise<PushResult> {
		const files = this.plugin.app.vault
			.getMarkdownFiles()
			.filter((f) => this.isUnderWritable(f.path));
		let pushed = 0;
		let failed = 0;
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			if (reportProgress) {
				this.setProgress({
					phase: "pushing",
					percent: 50 + (i / files.length) * 50,
					completed: i,
					total: files.length,
					current: f.path,
				});
			}
			const m = this.writableMappingFor(f.path);
			if (!m) continue;
			const key = this.toVfs(m, f.path);
			const before = this.syncedHashes.get(key);
			try {
				await this.pushFile(f);
				if (this.syncedHashes.get(key) !== before) pushed++;
			} catch (e) {
				const message = e instanceof Error ? e.message : "push failed";
				console.error(`OpenLore: push failed for ${f.path}`, e);
				this.recordError(f.path, message);
				failed++;
			}
		}
		if (reportProgress) {
			this.setProgress({
				phase: "pushing",
				percent: 100,
				completed: files.length,
				total: files.length,
				current: "Finishing sync…",
			});
		}
		return { pushed, failed };
	}

	/** Full two-way sync across all mappings. */
	async syncNow(): Promise<{ pulled: number; pushed: number; failed: number }> {
		this.plugin.logDiagnostic("sync.started", {
			mappings: this.mappings.map((m) => ({
				vaultPath: m.vaultPath,
				docset: m.docset,
				mount: m.mount,
				access: m.access,
				isHome: m.isHome ?? false,
			})),
		});
		try {
			const pulled = await this.pullAll(true);
			const { pushed, failed } = await this.pushAllWritable(true);
			this.lastSync = new Date();
			this.plugin.logDiagnostic("sync.completed", { pulled, pushed, failed });
			return { pulled, pushed, failed };
		} catch (e) {
			this.plugin.logDiagnostic("sync.failed", {
				message: e instanceof Error ? e.message : String(e),
			});
			throw e;
		} finally {
			this.setProgress(null);
		}
	}

	private async writeVaultFile(
		path: string,
		content: string,
		mtime?: number
	): Promise<void> {
		const vault = this.plugin.app.vault;
		const options = mtime === undefined ? undefined : { mtime };
		const existing = vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await vault.modify(existing, content, options);
			return;
		}
		await this.ensureFolder(path.substring(0, path.lastIndexOf("/")));
		try {
			await vault.create(path, content, options);
		} catch (e) {
			// `create` throws "File already exists" when the file is on disk but
			// not (yet) in Obsidian's cache — a common race during bulk pulls, or
			// a note created outside Obsidian. Re-resolve and modify, or fall back
			// to a direct adapter write, instead of failing the whole sync.
			const again = vault.getAbstractFileByPath(path);
			if (again instanceof TFile) {
				await vault.modify(again, content, options);
				return;
			}
			// Case-insensitive filesystem (macOS/Windows): the file exists at a
			// differently-cased path that the case-sensitive cache lookup above
			// missed. Modify the real file in place rather than forking a variant.
			const lower = path.toLowerCase();
			const ci = vault.getFiles().find((f) => f.path.toLowerCase() === lower);
			if (ci) {
				await vault.modify(ci, content, options);
				return;
			}
			if (await vault.adapter.exists(path)) {
				await vault.adapter.write(path, content, options);
				return;
			}
			throw e;
		}
	}

	private async ensureFolder(dir: string): Promise<void> {
		if (!dir) return;
		const parts = dir.split("/");
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!this.plugin.app.vault.getAbstractFileByPath(cur)) {
				try {
					await this.plugin.app.vault.createFolder(cur);
				} catch {
					// already exists / race — ignore
				}
			}
		}
	}
}
