import { requestUrl } from "obsidian";
import { DocsetRow, parseDocsets } from "./types";

/** Thrown when the server rejects the bearer token even after a refresh. */
export class UnauthorizedError extends Error {}

export interface ApiConfig {
	serverUrl: string;
	/** Returns the current access token. */
	getToken: () => string;
	/**
	 * Called on a 401 to obtain a fresh access token (via refresh). Returns the
	 * new token, or null if re-auth is required. Requests are retried once.
	 */
	refresh: () => Promise<string | null>;
}

interface ShellResult {
	output: string;
	isError: boolean;
}

/**
 * Client for go-openlore's JSON HTTP API (`POST /api/shell`). Every file
 * operation is expressed as a scoped shell command run as the signed-in
 * identity; the server enforces lore/docset access and writability.
 *
 * File content is transferred base64-encoded on write (`base64 -d`) so no file
 * content ever needs shell escaping. Paths are single-quoted.
 */
export class OpenLoreAPI {
	constructor(private cfg: ApiConfig) {}

	private base(): string {
		return this.cfg.serverUrl.replace(/\/+$/, "");
	}

	/** Run one shell command, refreshing the token once on a 401. */
	async shell(command: string): Promise<ShellResult> {
		let res = await this.rawShell(command, this.cfg.getToken());
		if (res.status === 401) {
			const token = await this.cfg.refresh();
			if (!token) {
				throw new UnauthorizedError("Sign in to OpenLore again.");
			}
			res = await this.rawShell(command, token);
			if (res.status === 401) {
				throw new UnauthorizedError("Sign in to OpenLore again.");
			}
		}
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`shell ${res.status}: ${res.text || "request failed"}`);
		}
		const body = res.json as { output?: string; is_error?: boolean };
		const output = body?.output ?? "";
		if (body?.is_error) {
			throw new Error(output.trim() || "command failed");
		}
		// The server reports command failures with is_error:false, appending the
		// non-zero status as a trailing "exit code: N" line. Surface those as
		// errors so callers (and the sync engine) don't treat them as success.
		const m = output.match(/\n\nexit code: (\d+)\s*$/);
		if (m && m[1] !== "0") {
			const msg = output.slice(0, m.index).trim();
			throw new Error(msg || `command failed (exit code ${m[1]})`);
		}
		return { output, isError: false };
	}

	private rawShell(command: string, token: string) {
		return requestUrl({
			url: `${this.base()}/api/shell`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({ command }),
			throw: false,
		});
	}

	/** List the docsets the identity can access. */
	async listDocsets(): Promise<DocsetRow[]> {
		const { output } = await this.shell("lore docsets");
		return parseDocsets(output);
	}

	/** List markdown files under a virtual path (recursively). */
	async listFiles(vfsDir: string): Promise<string[]> {
		const { output } = await this.shell(
			`find ${q(vfsDir)} -type f -name '*.md'`
		);
		return output
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
	}

	/** Read a file's content. */
	async readFile(vfsPath: string): Promise<string> {
		const { output } = await this.shell(`cat ${q(vfsPath)}`);
		return output;
	}

	/**
	 * Create or overwrite a file with the given content, creating parent dirs.
	 *
	 * The docset root always exists on the server and cannot be `mkdir`ed (it
	 * fails with "cannot create docset root"), so we only create intermediate
	 * directories strictly below `mountRoot`. Writing a file directly under the
	 * root needs no `mkdir` at all.
	 */
	async writeFile(
		vfsPath: string,
		content: string,
		mountRoot = ""
	): Promise<void> {
		const b64 = base64(content);
		const dir = parentDir(vfsPath);
		const root = mountRoot.replace(/\/+$/, "");
		const write = `echo ${q(b64)} | base64 -d > ${q(vfsPath)}`;
		const command =
			dir && dir !== root ? `mkdir -p ${q(dir)} && ${write}` : write;
		await this.shell(command);
	}

	/**
	 * Delete a file (requires the server's `rm` command). Uses `-f` so deleting
	 * an already-removed file is a harmless no-op — important because folder and
	 * child-file delete events can both try to remove the same path.
	 */
	async deleteFile(vfsPath: string): Promise<void> {
		await this.shell(`rm -f ${q(vfsPath)}`);
	}

	/** Move/rename a file (requires the server's `mv` command). */
	async moveFile(from: string, to: string): Promise<void> {
		await this.shell(`mv ${q(from)} ${q(to)}`);
	}
}

/** Single-quote a value for POSIX shell (safe against every metacharacter). */
function q(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The parent directory of a virtual path, or "" if it has none. */
function parentDir(vfsPath: string): string {
	const i = vfsPath.replace(/\/+$/, "").lastIndexOf("/");
	return i > 0 ? vfsPath.slice(0, i) : "";
}

/** UTF-8 safe base64 of a string. */
function base64(content: string): string {
	const bytes = new TextEncoder().encode(content);
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}
