import { TFile, normalizePath } from "obsidian";
import type OpenLorePlugin from "../main";
import { ResolvedMapping } from "./types";
import { LOREFILE } from "./lorefile";

/** Small, stable content hash (djb2) used to detect changes and break loops. */
function hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = (h * 33) ^ s.charCodeAt(i);
	}
	return (h >>> 0).toString(16);
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

	constructor(private plugin: OpenLorePlugin) {}

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

	/** The writable mapping that owns a vault path, if any. */
	writableMappingFor(path: string): ResolvedMapping | null {
		for (const m of this.mappings) {
			if (m.access !== "rw" || !m.mount) continue;
			if (path === m.vaultPath || path.startsWith(m.vaultPath + "/")) return m;
		}
		return null;
	}

	/** Is a vault path inside a writable mapped folder? */
	isUnderWritable(path: string): boolean {
		return this.writableMappingFor(path) !== null;
	}

	/** The read-only mapping that owns a vault path, if any. */
	readOnlyMappingFor(path: string): ResolvedMapping | null {
		for (const m of this.mappings) {
			if (m.access === "rw" || !m.mount) continue;
			if (path === m.vaultPath || path.startsWith(m.vaultPath + "/")) return m;
		}
		return null;
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
		if (this.syncedHashes.get(file.path) === hash(content)) return false;
		const msg = `"${m.docset}" is read-only — changes to this file won't sync.`;
		if (this.errorPaths.get(file.path) === msg) return false;
		this.errorPaths.set(file.path, msg);
		return true;
	}

	/** Vault path within a mapping → server virtual path. */
	private toVfs(m: ResolvedMapping, vaultPath: string): string {
		const rel = vaultPath.slice(m.vaultPath.length + 1);
		return `${m.mount.replace(/\/+$/, "")}/${rel}`;
	}

	/** Push a single local file if it lives in a writable mapped folder. */
	async pushFile(file: TFile): Promise<void> {
		if (file.extension !== "md") return;
		const m = this.writableMappingFor(file.path);
		if (!m) return;

		const content = await this.plugin.app.vault.read(file);
		const h = hash(content);
		if (this.syncedHashes.get(file.path) === h) {
			this.dirtyPaths.delete(file.path); // already matches the server
			this.errorPaths.delete(file.path);
			return; // unchanged / from pull
		}

		// If the write throws the file stays dirty (retried on next edit/sync).
		await this.plugin.api.writeFile(this.toVfs(m, file.path), content, m.mount);
		this.syncedHashes.set(file.path, h);
		this.dirtyPaths.delete(file.path);
		this.errorPaths.delete(file.path);
	}

	/** Delete the remote counterpart of a deleted local file. */
	async deleteRemote(path: string): Promise<void> {
		this.dirtyPaths.delete(path);
		this.errorPaths.delete(path);
		const m = this.writableMappingFor(path);
		if (!m) return;
		if (!path.endsWith(".md")) return;
		await this.plugin.api.deleteFile(this.toVfs(m, path));
		this.syncedHashes.delete(path);
	}

	/** Pull every mapped folder. */
	async pullAll(): Promise<number> {
		let written = 0;
		for (const m of this.mappings) {
			written += await this.pullMapping(m);
		}
		this.lastSync = new Date();
		return written;
	}

	/** Pull a single mapped folder's docset into the vault. */
	async pullMapping(m: ResolvedMapping): Promise<number> {
		if (!m.mount) return 0;
		const mountRoot = m.mount.replace(/\/+$/, "");
		const writable = m.access === "rw";

		let written = 0;
		const files = await this.plugin.api.listFiles(mountRoot);
		for (const vfsPath of files) {
			if (!vfsPath.startsWith(mountRoot)) continue;
			const rel =
				vfsPath === mountRoot
					? (vfsPath.split("/").pop() ?? "")
					: vfsPath.slice(mountRoot.length + 1);
			if (!rel || rel === LOREFILE) continue;

			const localPath = normalizePath(`${m.vaultPath}/${rel}`);
			const existing =
				this.plugin.app.vault.getAbstractFileByPath(localPath);
			const content = await this.plugin.api.readFile(vfsPath);

			if (writable) {
				// Additive only — never clobber local edits to a writable folder.
				if (existing) continue;
			} else if (existing instanceof TFile) {
				const current = await this.plugin.app.vault.read(existing);
				if (current === content) {
					this.syncedHashes.set(localPath, hash(content));
					continue;
				}
			}

			// Set the guard hash before writing so the resulting vault event
			// does not trigger a push back up.
			this.syncedHashes.set(localPath, hash(content));
			this.dirtyPaths.delete(localPath);
			this.errorPaths.delete(localPath);
			await this.writeVaultFile(localPath, content);
			written++;
		}
		return written;
	}

	/** Push every file inside writable mapped folders. */
	async pushAllWritable(): Promise<number> {
		const files = this.plugin.app.vault
			.getMarkdownFiles()
			.filter((f) => this.isUnderWritable(f.path));
		let pushed = 0;
		for (const f of files) {
			const before = this.syncedHashes.get(f.path);
			await this.pushFile(f);
			if (this.syncedHashes.get(f.path) !== before) pushed++;
		}
		return pushed;
	}

	/** Full two-way sync across all mappings. */
	async syncNow(): Promise<{ pulled: number; pushed: number }> {
		const pulled = await this.pullAll();
		const pushed = await this.pushAllWritable();
		this.lastSync = new Date();
		return { pulled, pushed };
	}

	private async writeVaultFile(path: string, content: string): Promise<void> {
		const existing = this.plugin.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.plugin.app.vault.modify(existing, content);
			return;
		}
		await this.ensureFolder(path.substring(0, path.lastIndexOf("/")));
		await this.plugin.app.vault.create(path, content);
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
