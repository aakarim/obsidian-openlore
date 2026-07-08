import {
	Menu,
	Notice,
	Plugin,
	TFile,
	TFolder,
	TAbstractFile,
	WorkspaceLeaf,
	debounce,
	setIcon,
	setTooltip,
} from "obsidian";
import { OpenLoreAPI } from "./src/api";
import { SyncEngine } from "./src/sync";
import { OpenLoreSidebarView, SIDEBAR_VIEW_TYPE } from "./src/sidebar";
import { OnboardingModal } from "./src/onboarding";
import { MapFolderModal } from "./src/map-folder";
import { OpenLoreSettingTab } from "./src/settings-tab";
import {
	DEFAULT_SETTINGS,
	OpenLoreSettings,
	ResolvedMapping,
	homeDocsetOf,
	settingsValid,
} from "./src/types";
import {
	buildAuthorizeUrl,
	createPkce,
	exchangeCode,
	randomState,
	refreshSession,
} from "./src/auth";
import {
	scanLorefiles,
	writeLorefile,
	removeLorefile,
} from "./src/lorefile";

const BADGE_CLASS = "openlore-tree-badge";
const DIRTY_CLASS = "openlore-dirty-dot";
const ERROR_CLASS = "openlore-error-dot";

interface PendingAuth {
	verifier: string;
	state: string;
	resolve: () => void;
	reject: (e: Error) => void;
	timer: number;
}

export default class OpenLorePlugin extends Plugin {
	settings: OpenLoreSettings = DEFAULT_SETTINGS;
	api!: OpenLoreAPI;
	sync!: SyncEngine;
	/** Resolved folder→docset mappings, rebuilt from Lorefiles on demand. */
	mappings: ResolvedMapping[] = [];

	private pendingPush = new Set<string>();
	private flushDebounced: () => void = () => {};
	private pullIntervalId: number | null = null;
	private pendingAuth: PendingAuth | null = null;
	private refreshInFlight: Promise<string | null> | null = null;
	private decorateDebounced: () => void = () => {};

	async onload(): Promise<void> {
		await this.loadSettings();
		this.rebuildApi();
		this.sync = new SyncEngine(this);
		this.rebuildDebounce();
		this.decorateDebounced = debounce(() => this.decorateExplorer(), 300, true);

		this.registerView(
			SIDEBAR_VIEW_TYPE,
			(leaf) => new OpenLoreSidebarView(leaf, this)
		);

		this.addSettingTab(new OpenLoreSettingTab(this.app, this));

		this.registerObsidianProtocolHandler(
			"openlore-auth",
			(params) => void this.handleAuthCallback(params)
		);

		this.registerEvent(this.app.vault.on("modify", (f) => this.onChanged(f)));
		this.registerEvent(this.app.vault.on("create", (f) => this.onChanged(f)));
		this.registerEvent(this.app.vault.on("delete", (f) => this.onDeleted(f)));
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => this.onRenamed(f, oldPath))
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.decorateDebounced())
		);

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.syncNow(),
		});
		this.addCommand({
			id: "map-folder",
			name: "Map an OpenLore folder",
			callback: () => this.openMapFolder(),
		});
		this.addCommand({
			id: "open-panel",
			name: "Open OpenLore panel",
			callback: () => this.activateSidebarView(),
		});
		this.addCommand({
			id: "setup",
			name: "Set up / sign in",
			callback: () => this.openOnboarding(),
		});

		this.addRibbonIcon("brain", "OpenLore", () => this.activateSidebarView());

		this.app.workspace.onLayoutReady(() => {
			void this.rescanMappings().then(() => this.decorateExplorer());
			if (!this.settings.onboardingComplete) {
				this.openOnboarding();
			} else {
				void this.afterOnboarding();
			}
		});
	}

	onunload(): void {
		this.stopPullInterval();
		this.clearExplorerBadges();
		if (this.pendingAuth) {
			window.clearTimeout(this.pendingAuth.timer);
			this.pendingAuth.reject(new Error("Plugin unloaded."));
			this.pendingAuth = null;
		}
	}

	/**
	 * Settings live in the vault's config dir (`.obsidian/openlore.json`), not
	 * the plugin's own `data.json`. The plugin folder is often symlinked across
	 * vaults during development, which would make `data.json` shared; storing in
	 * the (non-symlinked) config dir keeps each vault's sign-in/server separate.
	 */
	private settingsPath(): string {
		return `${this.app.vault.configDir}/openlore.json`;
	}

	async loadSettings(): Promise<void> {
		const path = this.settingsPath();
		let data: Partial<OpenLoreSettings> | null = null;
		try {
			if (await this.app.vault.adapter.exists(path)) {
				data = JSON.parse(await this.app.vault.adapter.read(path));
			}
		} catch {
			data = null;
		}
		// One-time migration from the legacy shared plugin data.json.
		if (!data) {
			data = (await this.loadData()) as Partial<OpenLoreSettings> | null;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.app.vault.adapter.write(
			this.settingsPath(),
			JSON.stringify(this.settings, null, 2)
		);
		this.rebuildApi();
		this.rebuildDebounce();
	}

	private rebuildApi(): void {
		this.api = new OpenLoreAPI({
			serverUrl: this.settings.serverUrl,
			getToken: () => this.settings.accessToken,
			refresh: () => this.refreshAccessToken(),
		});
	}

	private rebuildDebounce(): void {
		const ms = Math.max(1, this.settings.autoSyncDelaySeconds) * 1000;
		this.flushDebounced = debounce(() => void this.flushPush(), ms, true);
	}

	showNotice(message: string): void {
		new Notice(message);
	}

	// ---- Folder mappings ----

	/** Rebuild the resolved mapping list from the vault's Lorefiles. */
	async rescanMappings(): Promise<void> {
		const raw = await scanLorefiles(this.app.vault);
		this.mappings = raw.map((r) => {
			const d = this.settings.docsets.find((x) => x.name === r.docset);
			return {
				vaultPath: r.vaultPath,
				docset: r.docset,
				mount: d?.paths[0]?.replace(/\/+$/, "") ?? "",
				access: d?.access ?? "r",
			};
		});
	}

	/** Map a docset into a (possibly new) vault folder and pull it once. */
	async addMapping(docset: string, vaultPath: string): Promise<void> {
		await this.ensureVaultFolder(vaultPath);
		await writeLorefile(this.app.vault.adapter, vaultPath, docset);
		if (settingsValid(this.settings)) await this.refreshDocsets();
		await this.rescanMappings();
		const m = this.mappings.find((x) => x.vaultPath === vaultPath);
		if (m && m.mount && settingsValid(this.settings)) {
			await this.sync.pullMapping(m);
		}
		this.decorateExplorer();
	}

	/** Unmap a folder (removes its Lorefile; leaves the files in place). */
	async removeMapping(vaultPath: string): Promise<void> {
		await removeLorefile(this.app.vault.adapter, vaultPath);
		await this.rescanMappings();
		this.decorateExplorer();
	}

	private async ensureVaultFolder(dir: string): Promise<void> {
		const parts = dir.split("/");
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!this.app.vault.getAbstractFileByPath(cur)) {
				try {
					await this.app.vault.createFolder(cur);
				} catch {
					// already exists / race — ignore
				}
			}
		}
	}

	private openMapFolder(): void {
		if (!settingsValid(this.settings)) {
			this.showNotice("OpenLore: sign in before mapping folders.");
			this.openOnboarding();
			return;
		}
		new MapFolderModal(this.app, this, () => {
			void this.activateSidebarView();
		}).open();
	}

	// ---- File-explorer badges ----

	/**
	 * The file-explorer leaves. We iterate all leaves rather than using
	 * `getLeavesOfType("file-explorer")` because some plugins (e.g. make.md)
	 * monkey-patch that to return their own explorer. (Technique from Relay.)
	 */
	private getFileExplorers(): WorkspaceLeaf[] {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() === "file-explorer") leaves.push(leaf);
		});
		return leaves;
	}

	/**
	 * Decorate the file explorer: a brain badge on each mapped folder, and a
	 * dot on each file with local edits not yet pushed to the server.
	 */
	decorateExplorer(): void {
		this.clearExplorerBadges();
		const byPath = new Map(this.mappings.map((m) => [m.vaultPath, m]));
		const dirty = this.sync.dirtyPaths;
		for (const leaf of this.getFileExplorers()) {
			const items = (
				leaf.view as unknown as { fileItems?: Record<string, unknown> }
			).fileItems;
			if (!items) continue;

			for (const [path, m] of byPath) {
				const el = (items[path] as { selfEl?: HTMLElement } | undefined)
					?.selfEl;
				if (!el) continue;
				// Remove any stale badge before mounting (survives failed teardown).
				el.querySelectorAll(`.${BADGE_CLASS}`).forEach((n) => n.remove());
				el.addClass("openlore-mapped");
				const badge = el.createSpan({ cls: BADGE_CLASS });
				setIcon(badge, "brain");
				const access = m.mount
					? m.access === "rw"
						? "read/write"
						: "read-only"
					: "docset unavailable";
				setTooltip(badge, `OpenLore → docset "${m.docset}" (${access})`, {
					placement: "top",
				});
			}

			for (const path of dirty) {
				if (this.sync.errorPaths.has(path)) continue;
				const el = (items[path] as { selfEl?: HTMLElement } | undefined)
					?.selfEl;
				if (!el) continue;
				el.querySelectorAll(`.${DIRTY_CLASS}`).forEach((n) => n.remove());
				el.addClass("openlore-dirty");
				const dot = el.createSpan({ cls: DIRTY_CLASS });
				setTooltip(dot, "Local changes not yet synced to OpenLore", {
					placement: "top",
				});
			}

			for (const [path, message] of this.sync.errorPaths) {
				const el = (items[path] as { selfEl?: HTMLElement } | undefined)
					?.selfEl;
				if (!el) continue;
				el.querySelectorAll(`.${ERROR_CLASS}`).forEach((n) => n.remove());
				el.addClass("openlore-error");
				const dot = el.createSpan({ cls: ERROR_CLASS });
				setTooltip(dot, `Sync error: ${message}\nClick for options`, {
					placement: "top",
				});
				dot.addEventListener("click", (evt) => {
					evt.preventDefault();
					evt.stopPropagation();
					const menu = new Menu();
					menu.addItem((item) =>
						item
							.setTitle("Sync now")
							.setIcon("refresh-cw")
							.onClick(() => void this.syncNow())
					);
					menu.addItem((item) =>
						item
							.setTitle("Open console")
							.setIcon("terminal")
							.onClick(() => this.openConsole())
					);
					menu.showAtMouseEvent(evt);
				});
			}
		}
	}

	/** Open the Electron developer tools console (desktop only). */
	private openConsole(): void {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const req = (window as any).require as
				| ((mod: string) => any)
				| undefined;
			const electron = req?.("electron");
			const wc =
				electron?.remote?.getCurrentWindow?.()?.webContents ??
				electron?.remote?.getCurrentWebContents?.();
			if (wc?.openDevTools) {
				wc.openDevTools();
				return;
			}
		} catch (e) {
			console.error("OpenLore: could not open the console", e);
		}
		this.showNotice(
			"OpenLore: open the developer console with Cmd/Ctrl+Shift+I to see the error."
		);
	}

	private clearExplorerBadges(): void {
		for (const leaf of this.getFileExplorers()) {
			const root = (leaf.view as unknown as { containerEl?: HTMLElement })
				.containerEl;
			if (!root) continue;
			root
				.querySelectorAll(`.${BADGE_CLASS}, .${DIRTY_CLASS}, .${ERROR_CLASS}`)
				.forEach((n) => n.remove());
			root
				.querySelectorAll(
					".openlore-mapped, .openlore-dirty, .openlore-error"
				)
				.forEach((n) => {
					n.removeClass("openlore-mapped");
					n.removeClass("openlore-dirty");
					n.removeClass("openlore-error");
				});
		}
	}

	// ---- OAuth sign-in ----

	/**
	 * Begin the OAuth authorization-code + PKCE flow: open the server's
	 * `/authorize` page (passkey login) in the browser and resolve once the
	 * `obsidian://openlore-auth` callback completes the token exchange.
	 */
	async signIn(serverUrl: string): Promise<void> {
		const url = serverUrl.trim().replace(/\/+$/, "");
		if (!url) throw new Error("Enter the server URL first.");
		this.settings.serverUrl = url;
		await this.saveSettings();

		if (this.pendingAuth) {
			window.clearTimeout(this.pendingAuth.timer);
			this.pendingAuth.reject(new Error("Superseded by a new sign-in."));
			this.pendingAuth = null;
		}

		const { verifier, challenge } = await createPkce();
		const state = randomState();

		const done = new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				if (this.pendingAuth) {
					this.pendingAuth = null;
					reject(new Error("Sign-in timed out."));
				}
			}, 5 * 60 * 1000);
			this.pendingAuth = { verifier, state, resolve, reject, timer };
		});

		window.open(buildAuthorizeUrl(url, state, challenge), "_blank");
		return done;
	}

	private async handleAuthCallback(
		params: Record<string, string>
	): Promise<void> {
		const pending = this.pendingAuth;
		if (!pending) return;
		this.pendingAuth = null;
		window.clearTimeout(pending.timer);

		try {
			if (params.error) {
				throw new Error(params.error_description || params.error);
			}
			if (!params.code) throw new Error("No authorization code returned.");
			if (params.state !== pending.state) {
				throw new Error("State mismatch — sign-in was not initiated here.");
			}

			const session = await exchangeCode(
				this.settings.serverUrl,
				params.code,
				pending.verifier
			);
			this.settings.accessToken = session.accessToken;
			this.settings.refreshToken = session.refreshToken;
			this.settings.tokenExpiresAt = session.expiresAt;
			this.settings.identity = session.identity;
			this.settings.onboardingComplete = true;
			await this.saveSettings();

			await this.refreshDocsets();
			this.showNotice(`OpenLore: signed in as ${this.settings.identity}`);
			pending.resolve();
			await this.afterOnboarding();
		} catch (e) {
			const msg = e instanceof Error ? e.message : "sign-in failed";
			this.showNotice(`OpenLore: ${msg}`);
			pending.reject(e instanceof Error ? e : new Error(msg));
		}
	}

	/** Redeem the refresh token for a fresh access token; null if unavailable. */
	private refreshAccessToken(): Promise<string | null> {
		if (this.refreshInFlight) return this.refreshInFlight;
		this.refreshInFlight = (async () => {
			try {
				if (!this.settings.refreshToken) return null;
				const session = await refreshSession(
					this.settings.serverUrl,
					this.settings.refreshToken
				);
				this.settings.accessToken = session.accessToken;
				this.settings.refreshToken = session.refreshToken;
				this.settings.tokenExpiresAt = session.expiresAt;
				if (session.identity) this.settings.identity = session.identity;
				await this.saveSettings();
				return session.accessToken;
			} catch {
				this.settings.accessToken = "";
				await this.saveSettings();
				return null;
			} finally {
				this.refreshInFlight = null;
			}
		})();
		return this.refreshInFlight;
	}

	/** Fetch `lore docsets`, record the home docset, and re-resolve mappings. */
	async refreshDocsets(): Promise<void> {
		const docsets = await this.api.listDocsets();
		this.settings.docsets = docsets;
		const home = homeDocsetOf(docsets);
		this.settings.homeDocset = home?.name ?? "";
		this.settings.homePath = home?.paths[0] ?? "";
		await this.saveSettings();
		await this.rescanMappings();
	}

	signOut(): void {
		this.settings.accessToken = "";
		this.settings.refreshToken = "";
		this.settings.tokenExpiresAt = 0;
		this.settings.identity = "";
		this.settings.homeDocset = "";
		this.settings.homePath = "";
		this.settings.docsets = [];
		void this.saveSettings();
		this.stopPullInterval();
	}

	/** Called after a successful sign-in or on load when already set up. */
	async afterOnboarding(): Promise<void> {
		if (!settingsValid(this.settings)) return;
		await this.rescanMappings();
		this.restartPullInterval();
		await this.syncNow();
	}

	private openOnboarding(): void {
		new OnboardingModal(this.app, this, () => {
			void this.activateSidebarView();
		}).open();
	}

	private onChanged(file: TAbstractFile): void {
		if (!settingsValid(this.settings)) return;
		if (!(file instanceof TFile) || file.extension !== "md") return;
		if (!this.sync.isUnderWritable(file.path)) {
			// Edits inside a read-only mapped folder can never be pushed. Flag
			// them so the change doesn't silently fail to sync.
			void this.sync.flagReadOnlyEdit(file).then((flagged) => {
				if (flagged) this.decorateExplorer();
			});
			return;
		}
		this.pendingPush.add(file.path);
		this.sync.markDirty(file.path);
		this.decorateDebounced();
		this.flushDebounced();
	}

	private onDeleted(file: TAbstractFile): void {
		if (!settingsValid(this.settings)) return;
		if (!this.sync.isUnderWritable(file.path)) return;
		void this.sync
			.deleteRemote(file.path)
			.catch((e) => {
				const msg = e instanceof Error ? e.message : String(e);
				console.error("OpenLore: delete failed", e);
				this.showNotice(
					`OpenLore: failed to sync deletion of ${file.path} — ${msg}`
				);
			})
			.finally(() => this.decorateExplorer());
	}

	private onRenamed(file: TAbstractFile, oldPath: string): void {
		if (file instanceof TFolder) {
			// A mapped folder (or one containing one) moved; its Lorefile moved
			// with it, so just re-resolve mappings and re-badge.
			void this.rescanMappings().then(() => this.decorateExplorer());
			return;
		}
		if (!settingsValid(this.settings)) return;
		if (this.sync.isUnderWritable(oldPath)) {
			void this.sync.deleteRemote(oldPath).catch(() => {});
		}
		if (file instanceof TFile) this.onChanged(file);
	}

	private async flushPush(): Promise<void> {
		if (this.pendingPush.size === 0) return;
		const paths = Array.from(this.pendingPush);
		this.pendingPush.clear();
		let pushed = 0;
		const failures: { path: string; error: Error }[] = [];
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			try {
				await this.sync.pushFile(file);
				pushed++;
			} catch (e) {
				const error = e instanceof Error ? e : new Error(String(e));
				console.error(`OpenLore: push failed for ${path}`, error);
				this.sync.errorPaths.set(path, error.message);
				failures.push({ path, error });
			}
		}
		if (pushed > 0) console.log(`OpenLore: pushed ${pushed} file(s)`);
		if (failures.length === 1) {
			const { path, error } = failures[0];
			this.showNotice(`OpenLore: failed to sync ${path} — ${error.message}`);
		} else if (failures.length > 1) {
			this.showNotice(
				`OpenLore: failed to sync ${failures.length} files — ${failures[0].error.message}`
			);
		}
		this.decorateExplorer();
	}

	restartPullInterval(): void {
		this.stopPullInterval();
		const ms = Math.max(1, this.settings.pullIntervalMinutes) * 60 * 1000;
		this.pullIntervalId = this.registerInterval(
			window.setInterval(() => void this.sync.pullAll().catch(() => {}), ms)
		);
	}

	private stopPullInterval(): void {
		if (this.pullIntervalId !== null) {
			window.clearInterval(this.pullIntervalId);
			this.pullIntervalId = null;
		}
	}

	async syncNow(): Promise<void> {
		if (!this.settings.onboardingComplete) {
			this.openOnboarding();
			return;
		}
		if (!settingsValid(this.settings)) {
			this.showNotice("OpenLore: sign in to sync.");
			void this.activateSidebarView();
			return;
		}
		try {
			const { pulled, pushed } = await this.sync.syncNow();
			this.decorateExplorer();
			this.showNotice(`OpenLore: pulled ${pulled}, pushed ${pushed}.`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : "unknown error";
			this.showNotice(`OpenLore: sync failed — ${msg}`);
		}
	}

	async activateSidebarView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}
}
