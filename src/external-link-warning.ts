import { StateEffect } from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import {
	EventRef,
	TFile,
	editorInfoField,
	editorLivePreviewField,
	setIcon,
} from "obsidian";
import type OpenLorePlugin from "../main";

const metadataChanged = StateEffect.define<void>();

class ExternalLinkWarningWidget extends WidgetType {
	toDOM(view: EditorView): HTMLElement {
		const el = view.dom.ownerDocument.createElement("span");
		el.addClass("openlore-external-link-warning");
		el.setAttribute("aria-label", "Link points outside this OpenLore folder");
		el.title =
			"This link points outside the synced OpenLore folder and may open a different docset or be unavailable to collaborators.";
		setIcon(el, "file-warning");
		return el;
	}
}

/**
 * Mark links that Obsidian resolves outside the source note's mapped docset.
 * This deliberately mirrors Relay's warning-only behavior: link destinations
 * and synced Markdown are never rewritten.
 */
export function createExternalLinkWarningExtension(plugin: OpenLorePlugin) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet = Decoration.none;
			private metadataRef: EventRef;
			private resolveRef: EventRef;
			private sourcePath: string | null = null;
			private livePreview = false;

			constructor(private view: EditorView) {
				this.metadataRef = plugin.app.metadataCache.on("changed", (file) => {
					if (file === this.file()) this.refresh();
				});
				this.resolveRef = plugin.app.metadataCache.on("resolve", (file) => {
					if (file === this.file()) this.refresh();
				});
				this.rebuild();
			}

			private file(): TFile | null {
				return this.view.state.field(editorInfoField).file;
			}

			private refresh(): void {
				this.view.dispatch({ effects: metadataChanged.of() });
			}

			private rebuild(): void {
				this.decorations = Decoration.none;
				const file = this.file();
				this.sourcePath = file?.path ?? null;
				this.livePreview = this.view.state.field(editorLivePreviewField);
				if (!this.livePreview) return;
				if (!file) return;
				const mapping = plugin.sync.mappingFor(file.path);
				// The home docset is mounted at the vault root, so Obsidian's normal
				// root-relative link semantics are already correct there.
				if (!mapping || mapping.isHome) return;

				const cache = plugin.app.metadataCache.getFileCache(file);
				const references = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
				const widgets = references.flatMap((reference) => {
					const destination = plugin.app.metadataCache.getFirstLinkpathDest(
						reference.link,
						file.path
					);
					if (!destination || plugin.sync.mappingFor(destination.path) === mapping) {
						return [];
					}

					const anchor = reference.position.end.offset;
					if (anchor > this.view.state.doc.length) return [];
					return [
						Decoration.widget({
							widget: new ExternalLinkWarningWidget(),
							side: 1,
						}).range(anchor),
					];
				});
				this.decorations = Decoration.set(widgets, true);
			}

			update(update: ViewUpdate): void {
				const metadataUpdated = update.transactions.some((transaction) =>
					transaction.effects.some((effect) => effect.is(metadataChanged))
				);
				const contextChanged =
					this.file()?.path !== this.sourcePath ||
					this.view.state.field(editorLivePreviewField) !== this.livePreview;
				if (
					update.docChanged ||
					update.viewportChanged ||
					metadataUpdated ||
					contextChanged
				) {
					this.rebuild();
				}
			}

			destroy(): void {
				plugin.app.metadataCache.offref(this.metadataRef);
				plugin.app.metadataCache.offref(this.resolveRef);
			}
		},
		{ decorations: (value) => value.decorations }
	);
}
