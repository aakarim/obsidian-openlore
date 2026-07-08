import { DataAdapter, TFolder, Vault, normalizePath } from "obsidian";
import { FolderMapping } from "./types";

/**
 * The per-folder mapping file. It lives *inside* the mapped folder and names the
 * docset the folder syncs with. Because the mapping travels with the folder, you
 * can rename or move the folder in Obsidian and the mapping still holds.
 *
 * It's a dotfile so Obsidian hides it, and it's never pushed to the server (we
 * only sync `*.md`).
 */
export const LOREFILE = ".lore";

interface LorefileData {
	docset: string;
}

function lorefilePath(folderPath: string): string {
	return normalizePath(`${folderPath}/${LOREFILE}`);
}

/** Read the docset a folder maps to, or null if it isn't a mapped folder. */
export async function readLorefile(
	adapter: DataAdapter,
	folderPath: string
): Promise<string | null> {
	const p = lorefilePath(folderPath);
	try {
		if (!(await adapter.exists(p))) return null;
		const data = JSON.parse(await adapter.read(p)) as Partial<LorefileData>;
		return typeof data.docset === "string" && data.docset ? data.docset : null;
	} catch {
		return null;
	}
}

/** Write (or update) a folder's Lorefile to point at a docset. */
export async function writeLorefile(
	adapter: DataAdapter,
	folderPath: string,
	docset: string
): Promise<void> {
	const data: LorefileData = { docset };
	await adapter.write(lorefilePath(folderPath), JSON.stringify(data, null, 2));
}

/** Remove a folder's Lorefile (unmaps it, leaving the files in place). */
export async function removeLorefile(
	adapter: DataAdapter,
	folderPath: string
): Promise<void> {
	const p = lorefilePath(folderPath);
	if (await adapter.exists(p)) await adapter.remove(p);
}

/** Discover every mapped folder in the vault by scanning for Lorefiles. */
export async function scanLorefiles(vault: Vault): Promise<FolderMapping[]> {
	const folders = vault
		.getAllLoadedFiles()
		.filter((f): f is TFolder => f instanceof TFolder && f.path !== "");
	const out: FolderMapping[] = [];
	for (const folder of folders) {
		const docset = await readLorefile(vault.adapter, folder.path);
		if (docset) out.push({ vaultPath: folder.path, docset });
	}
	return out;
}
