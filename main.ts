import {
	Menu,
	Notice,
	Platform,
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
	homeStatus,
	homeStatusMessage,
	homeSyncActive,
	settingsValid,
	syncEnabled,
} from "./src/types";
import { HomeConsentModal } from "./src/home-consent";
import {
	KVStore,
	PENDING_AUTH_KEY,
	SETTINGS_KEY,
	Versioned,
} from "./src/store";
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
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Data-schema version of the persisted settings. Monotonically increasing; bump
 * it and add a step in `migrateSettings` whenever the stored shape changes.
 */
const SETTINGS_VERSION = 1;

/** Bring a stored settings payload up to the current shape. */
function migrateSettings(stored: Versioned<OpenLoreSettings>): OpenLoreSettings {
	// No shape migrations yet. Future: `if (stored.v < 2) { … }`.
	return stored.data;
}

interface PendingAuth {
	verifier: string;
	state: string;
	serverUrl: string;
	createdAt: number;
	resolve: () => void;
	reject: (e: Error) => void;
	timer: number;
}

type StoredPendingAuth = Pick<
	PendingAuth,
	"verifier" | "state" | "serverUrl" | "createdAt"
>;

export default class OpenLorePlugin extends Plugin {
	settings: OpenLoreSettings = DEFAULT_SETTINGS;
	api!: OpenLoreAPI;
	sync!: SyncEngine;
	/** Device-local key-value store (IndexedDB); never synced by any service. */
	store!: KVStore;
	/** Resolved folder→docset mappings, rebuilt from Lorefiles on demand. */
	mappings: ResolvedMapping[] = [];

	private pendingPush = new Set<string>();
	/**
	 * Folders currently being moved/renamed (oldPath→newPath). Obsidian fires a
	 * `rename` event for the folder and then one for each descendant file; we
	 * reconcile the whole subtree from the folder event and suppress the noisy
	 * per-child events while an entry is present.
	 */
	private renamingFolders = new Map<string, string>();
	/**
	 * Folders currently being deleted. Folder deletion is reconciled from the
	 * folder event (enumerating the server copies); any per-child `delete`
	 * events some Obsidian versions emit are suppressed while an entry is present.
	 */
	private deletingFolders = new Set<string>();
	private flushDebounced: () => void = () => {};
	/**
	 * Set true when the user explicitly saves (Cmd/Ctrl+S). The following
	 * `modify` event then pushes immediately instead of waiting out the
	 * auto-sync debounce, so a just-saved file's dirty dot clears at once.
	 */
	private saveRequested = false;
	private saveResetTimer: number | null = null;
	/** Restores the wrapped `editor:save-file` command callback on unload. */
	private restoreSaveCommand: (() => void) | null = null;
	private pullIntervalId: number | null = null;
	private pendingAuth: PendingAuth | null = null;
	private refreshInFlight: Promise<string | null> | null = null;
	private decorateDebounced: () => void = () => {};

	async onload(): Promise<void> {
		this.store = new KVStore(this.app);
		await this.loadSettings();
		this.rebuildApi();
		this.sync = new SyncEngine(this);
		await this.sync.loadState();
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
		this.hookSaveCommand();

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
		if (this.saveResetTimer !== null) {
			window.clearTimeout(this.saveResetTimer);
			this.saveResetTimer = null;
		}
		this.restoreSaveCommand?.();
		this.restoreSaveCommand = null;
		void this.sync.flushState().finally(() => this.store.close());
		this.clearExplorerBadges();
		if (this.pendingAuth) {
			window.clearTimeout(this.pendingAuth.timer);
			this.pendingAuth.reject(new Error("Plugin unloaded."));
			this.pendingAuth = null;
		}
	}

	/**
	 * Settings (including the access token) live in Obsidian's per-vault
	 * IndexedDB, not in `.obsidian/` or the plugin's `data.json`. IndexedDB is
	 * device-local and never synced, so the token can't propagate across devices
	 * via Obsidian Sync, and each vault stays isolated even when the plugin
	 * folder is symlinked across vaults during development.
	 */
	async loadSettings(): Promise<void> {
		let data: Partial<OpenLoreSettings> | null = null;
		try {
			const stored =
				await this.store.get<Versioned<OpenLoreSettings>>(SETTINGS_KEY);
			if (stored) {
				data = migrateSettings(stored);
			} else {
				data = await this.importLegacySettings();
			}
		} catch {
			data = null;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	}

	/**
	 * One-time import of pre-IndexedDB settings. Reads the old
	 * `.obsidian/openlore.json` (or the even older shared `data.json`), persists
	 * it into IndexedDB, and deletes the config-folder copy — so the access
	 * token no longer propagates across devices via Obsidian Sync's `.obsidian`.
	 */
	private async importLegacySettings(): Promise<Partial<OpenLoreSettings> | null> {
		const path = `${this.app.vault.configDir}/openlore.json`;
		let data: Partial<OpenLoreSettings> | null = null;
		try {
			if (await this.app.vault.adapter.exists(path)) {
				data = JSON.parse(await this.app.vault.adapter.read(path));
			}
		} catch {
			data = null;
		}
		if (!data) {
			data = (await this.loadData()) as Partial<OpenLoreSettings> | null;
		}
		if (data) {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
			await this.saveSettings();
			try {
				if (await this.app.vault.adapter.exists(path)) {
					await this.app.vault.adapter.remove(path);
				}
			} catch {
				// Leaving the old file is harmless; IndexedDB is now the source.
			}
		}
		return data;
	}

	async saveSettings(): Promise<void> {
		const payload: Versioned<OpenLoreSettings> = {
			v: SETTINGS_VERSION,
			data: this.settings,
		};
		await this.store.set(SETTINGS_KEY, payload);
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

	/**
	 * Whether Obsidian Sync is actively connected to a remote vault for this
	 * vault — not merely that the Sync core plugin is enabled (it's enabled by
	 * default, even with no remote vault). We only warn when there's a real
	 * remote vault, because that's when Sync and OpenLore could cover the same
	 * files ("double coverage" → conflicts/data loss).
	 *
	 * These are internal, reverse-engineered APIs, so every access is guarded and
	 * we check several connection indicators; if the shape drifts we fail closed
	 * (no warning) rather than nag when Sync isn't really on.
	 */
	isObsidianSyncActive(): boolean {
		try {
			const internal = (
				this.app as unknown as {
					internalPlugins?: {
						getPluginById?: (id: string) =>
							| { enabled?: boolean; instance?: Record<string, unknown> }
							| undefined;
					};
				}
			).internalPlugins;
			const plugin = internal?.getPluginById?.("sync");
			if (plugin?.enabled !== true) return false;
			const inst = plugin.instance;
			if (!inst) return false;
			return (
				!!inst.remoteVault ||
				typeof inst.vaultId === "string" ||
				typeof inst.remoteVaultId === "string"
			);
		} catch {
			return false;
		}
	}

	// ---- Folder mappings ----

	/**
	 * Rebuild the resolved mapping list from the vault's Lorefiles, plus the
	 * implicit whole-vault home mapping (root "") when home sync is active.
	 * Ownership is resolved most-specific-first, so mapped carve-out folders
	 * take precedence over the home root.
	 */
	async rescanMappings(): Promise<void> {
		const raw = await scanLorefiles(this.app.vault);
		const mappings: ResolvedMapping[] = raw.map((r) => {
			const d = this.settings.docsets.find((x) => x.name === r.docset);
			return {
				vaultPath: r.vaultPath,
				docset: r.docset,
				mount: d?.paths[0]?.replace(/\/+$/, "") ?? "",
				access: d?.access ?? "r",
			};
		});
		if (homeSyncActive(this.settings)) {
			mappings.push({
				vaultPath: "",
				docset: this.settings.homeDocset,
				mount: this.settings.homePath.replace(/\/+$/, ""),
				access: "rw",
				isHome: true,
			});
		}
		this.mappings = mappings;
	}

	/** Map a docset into a (possibly new) vault folder and pull it once. */
	async addMapping(docset: string, vaultPath: string): Promise<void> {
		await this.ensureVaultFolder(vaultPath);
		await writeLorefile(this.app.vault.adapter, vaultPath, docset);
		if (settingsValid(this.settings)) await this.refreshDocsets();
		await this.rescanMappings();
		const m = this.mappings.find((x) => x.vaultPath === vaultPath);
		if (m && m.mount && syncEnabled(this.settings)) {
			// Carving a folder out of home into a writable docset: move the local
			// notes into the new docset and drop the copies left behind in home.
			// (Read-only carve-outs keep their home copies — see reconcileCarveOut.)
			if (homeSyncActive(this.settings) && m.access === "rw" && !m.isHome) {
				await this.sync.reconcileCarveOut(vaultPath);
			}
			await this.sync.pullMapping(m);
		}
		this.decorateExplorer();
	}

	/** Unmap a folder (removes its Lorefile; leaves the files in place). */
	async removeMapping(vaultPath: string): Promise<void> {
		// The whole-vault home mapping (root path) is not `.lore`-backed and must
		// stay connected — it can only be changed via home selection, not unmapped.
		if (vaultPath === "") return;
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
		if (!syncEnabled(this.settings)) {
			this.showNotice(
				settingsValid(this.settings)
					? `OpenLore: ${homeStatusMessage(homeStatus(this.settings))}`
					: "OpenLore: sign in before mapping folders."
			);
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
					if (Platform.isDesktopApp) {
						menu.addItem((item) =>
							item
								.setTitle("Open console")
								.setIcon("terminal")
								.onClick(() => this.openConsole())
						);
					}
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
		const createdAt = Date.now();
		const stored: StoredPendingAuth = { verifier, state, serverUrl: url, createdAt };
		await this.store.set<Versioned<StoredPendingAuth>>(PENDING_AUTH_KEY, {
			v: 1,
			data: stored,
		});

		const done = new Promise<void>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				if (this.pendingAuth) {
					this.pendingAuth = null;
					void this.store.delete(PENDING_AUTH_KEY);
					reject(new Error("Sign-in timed out."));
				}
			}, AUTH_TIMEOUT_MS);
			this.pendingAuth = { ...stored, resolve, reject, timer };
		});

		window.open(buildAuthorizeUrl(url, state, challenge), "_blank");
		return done;
	}

	private async handleAuthCallback(
		params: Record<string, string>
	): Promise<void> {
		const live = this.pendingAuth;
		this.pendingAuth = null;
		if (live) window.clearTimeout(live.timer);

		try {
			const stored = live
				? live
				: (
						await this.store.get<Versioned<StoredPendingAuth>>(
							PENDING_AUTH_KEY
						)
					)?.data;
			await this.store.delete(PENDING_AUTH_KEY);
			if (!stored || Date.now() - stored.createdAt > AUTH_TIMEOUT_MS) {
				throw new Error("Sign-in expired. Start sign-in again.");
			}
			if (params.error) {
				throw new Error(params.error_description || params.error);
			}
			if (!params.code) throw new Error("No authorization code returned.");
			if (params.state !== stored.state) {
				throw new Error("State mismatch — sign-in was not initiated here.");
			}

			const session = await exchangeCode(
				stored.serverUrl,
				params.code,
				stored.verifier
			);
			this.settings.serverUrl = stored.serverUrl;
			this.settings.accessToken = session.accessToken;
			this.settings.refreshToken = session.refreshToken;
			this.settings.tokenExpiresAt = session.expiresAt;
			this.settings.identity = session.identity;
			this.settings.onboardingComplete = true;
			await this.saveSettings();

			await this.refreshDocsets();
			this.showNotice(`OpenLore: signed in as ${this.settings.identity}`);
			live?.resolve();
			await this.afterOnboarding();
		} catch (e) {
			const msg = e instanceof Error ? e.message : "sign-in failed";
			this.showNotice(`OpenLore: ${msg}`);
			live?.reject(e instanceof Error ? e : new Error(msg));
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

	/** Fetch `lore docsets`, refresh the selected home's mount, re-resolve maps. */
	async refreshDocsets(): Promise<void> {
		const docsets = await this.api.listDocsets();
		this.settings.docsets = docsets;
		// Keep the user's selected home; refresh its mount (cleared if it vanished
		// or lost write access — surfaced as an error by homeStatus).
		const home = docsets.find((d) => d.name === this.settings.homeDocset);
		this.settings.homePath = home?.paths[0] ?? "";
		await this.saveSettings();
		await this.rescanMappings();
	}

	/**
	 * Select a docset as the home folder. Must be one of the user's writable
	 * docsets. Changing the home docset clears prior consent, so the whole-vault
	 * push into a new home always requires a fresh confirmation.
	 */
	async selectHome(docsetName: string): Promise<void> {
		const changed = docsetName !== this.settings.homeDocset;
		this.settings.homeDocset = docsetName;
		const d = this.settings.docsets.find((x) => x.name === docsetName);
		this.settings.homePath = d?.paths[0] ?? "";
		if (changed) this.settings.homeSyncConsentedFor = "";
		await this.saveSettings();
		await this.rescanMappings();
		if (homeSyncActive(this.settings)) {
			await this.afterOnboarding();
		} else if (homeStatus(this.settings).ok) {
			this.promptHomeConsent();
		}
	}

	/** Ask the user to confirm the first whole-vault push into home. */
	promptHomeConsent(): void {
		new HomeConsentModal(this.app, this, () =>
			void this.confirmHomeSync()
		).open();
	}

	/** Record consent for the current home docset and start syncing the vault. */
	async confirmHomeSync(): Promise<void> {
		this.settings.homeSyncConsentedFor = this.settings.homeDocset;
		await this.saveSettings();
		await this.rescanMappings();
		await this.afterOnboarding();
	}

	signOut(): void {
		this.settings.accessToken = "";
		this.settings.refreshToken = "";
		this.settings.tokenExpiresAt = 0;
		this.settings.identity = "";
		this.settings.homeDocset = "";
		this.settings.homePath = "";
		this.settings.homeSyncConsentedFor = "";
		this.settings.docsets = [];
		void this.saveSettings();
		this.stopPullInterval();
	}

	/**
	 * Called after a successful sign-in or on load when already set up. Syncs the
	 * currently active mappings directly (no consent prompt here — the automatic
	 * on-load path must never nag; whole-vault home is only included once the
	 * user has consented, i.e. when its mapping is synthesized).
	 */
	async afterOnboarding(): Promise<void> {
		if (!syncEnabled(this.settings)) return;
		await this.rescanMappings();
		this.restartPullInterval();
		try {
			await this.sync.syncNow();
			this.decorateExplorer();
		} catch (e) {
			console.error("OpenLore: sync failed", e);
		}
	}

	private openOnboarding(): void {
		new OnboardingModal(this.app, this, () => {
			void this.activateSidebarView();
		}).open();
	}

	private onChanged(file: TAbstractFile): void {
		if (!syncEnabled(this.settings)) return;
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
		if (this.saveRequested) {
			// Explicit save — push now so the dirty dot clears immediately
			// instead of lingering for the auto-sync debounce window.
			this.saveRequested = false;
			if (this.saveResetTimer !== null) {
				window.clearTimeout(this.saveResetTimer);
				this.saveResetTimer = null;
			}
			void this.flushPush();
		} else {
			this.flushDebounced();
		}
	}

	/**
	 * Obsidian's `modify` event fires for both its own periodic auto-save and
	 * an explicit Cmd/Ctrl+S, so it can't distinguish them. Wrap the
	 * `editor:save-file` command to flag the next `modify` as an explicit save
	 * so it pushes right away. Restored on unload.
	 */
	private hookSaveCommand(): void {
		const commands = (
			this.app as unknown as {
				commands?: {
					commands?: Record<
						string,
						{
							callback?: () => unknown;
							checkCallback?: (checking: boolean) => unknown;
						}
					>;
				};
			}
		).commands?.commands;
		const cmd = commands?.["editor:save-file"];
		if (!cmd) return;

		const onSave = (): void => {
			this.saveRequested = true;
			// Clear the flag if no modify follows (e.g. nothing changed) so a
			// later unrelated background write isn't mistaken for a save.
			if (this.saveResetTimer !== null) {
				window.clearTimeout(this.saveResetTimer);
			}
			this.saveResetTimer = window.setTimeout(() => {
				this.saveRequested = false;
				this.saveResetTimer = null;
			}, 1000);
		};

		if (cmd.checkCallback) {
			const orig = cmd.checkCallback.bind(cmd);
			cmd.checkCallback = (checking: boolean) => {
				if (!checking) onSave();
				return orig(checking);
			};
			this.restoreSaveCommand = () => {
				cmd.checkCallback = orig;
			};
		} else if (cmd.callback) {
			const orig = cmd.callback.bind(cmd);
			cmd.callback = () => {
				onSave();
				return orig();
			};
			this.restoreSaveCommand = () => {
				cmd.callback = orig;
			};
		}
	}

	private onDeleted(file: TAbstractFile): void {
		if (!syncEnabled(this.settings)) return;
		if (file instanceof TFolder) {
			// Set the guard before any await so per-child delete events (emitted
			// by some Obsidian versions) are suppressed while we reconcile.
			this.deletingFolders.add(file.path);
			void this.onFolderDeleted(file.path);
			return;
		}
		if (!(file instanceof TFile)) return;
		if (this.isUnderDeletingFolder(file.path)) return;
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
			// Guard synchronously before the follow-up child rename events fire,
			// then reconcile the whole subtree from this one event.
			this.renamingFolders.set(oldPath, file.path);
			void this.onFolderRenamed(oldPath, file.path);
			return;
		}
		if (!(file instanceof TFile)) return;
		// A descendant event from a folder move — the folder handler reconciles
		// the subtree as a batch, so ignore the per-child event here.
		if (this.isUnderRenamingFolder(oldPath)) return;
		if (!syncEnabled(this.settings)) return;
		if (this.sync.isUnderWritable(oldPath)) {
			void this.sync.deleteRemote(oldPath).catch(() => {});
		}
		this.onChanged(file);
	}

	/** Is a path inside a folder whose rename we're currently reconciling? */
	private isUnderRenamingFolder(path: string): boolean {
		for (const from of this.renamingFolders.keys()) {
			if (path === from || path.startsWith(from + "/")) return true;
		}
		return false;
	}

	/** Is a path inside a folder whose deletion we're currently reconciling? */
	private isUnderDeletingFolder(path: string): boolean {
		for (const from of this.deletingFolders) {
			if (path === from || path.startsWith(from + "/")) return true;
		}
		return false;
	}

	/**
	 * Reconcile a folder move. Files carried home-owned notes need their stale
	 * copies removed from the old home path and fresh copies pushed at the new
	 * path; carve-out folders take their `.lore` with them, so their remote
	 * paths are unchanged and only need re-resolving.
	 */
	private async onFolderRenamed(oldPath: string, newPath: string): Promise<void> {
		try {
			await this.rescanMappings();
			if (syncEnabled(this.settings)) {
				await this.sync.renameFolder(oldPath, newPath);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("OpenLore: folder rename sync failed", e);
			this.showNotice(
				`OpenLore: failed to sync move of ${oldPath} — ${msg}`
			);
		} finally {
			this.renamingFolders.delete(oldPath);
			this.decorateExplorer();
		}
	}

	/**
	 * Reconcile a folder deletion. For a home-owned folder (or a subfolder of a
	 * writable carve-out) we delete the server copies under it. Deleting a
	 * carve-out root only unmaps it locally — a shared docset is never wiped by
	 * removing its local mirror.
	 */
	private async onFolderDeleted(folderPath: string): Promise<void> {
		try {
			const owner = this.sync.mappingFor(folderPath);
			const isCarveOutRoot =
				!!owner && !owner.isHome && owner.vaultPath === folderPath;
			if (!isCarveOutRoot) {
				const n = await this.sync.deleteRemoteFolder(folderPath);
				if (n > 0) {
					console.log(
						`OpenLore: deleted ${n} remote file(s) under ${folderPath}`
					);
				}
			}
			await this.rescanMappings();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("OpenLore: folder delete sync failed", e);
			this.showNotice(
				`OpenLore: failed to sync deletion of ${folderPath} — ${msg}`
			);
		} finally {
			this.deletingFolders.delete(folderPath);
			this.decorateExplorer();
		}
	}

	private async flushPush(): Promise<void> {
		if (!syncEnabled(this.settings)) {
			this.pendingPush.clear();
			return;
		}
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
		if (!syncEnabled(this.settings)) {
			this.showNotice(
				settingsValid(this.settings)
					? `OpenLore: ${homeStatusMessage(homeStatus(this.settings))}`
					: "OpenLore: sign in to sync."
			);
			void this.activateSidebarView();
			return;
		}
		// Home is selected and writable but the whole-vault upload hasn't been
		// confirmed yet — ask before pushing anything.
		if (!homeSyncActive(this.settings)) {
			this.promptHomeConsent();
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
