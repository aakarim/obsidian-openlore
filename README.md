# OpenLore for Obsidian

Publish notes from your Obsidian vault into your OpenLore knowledge base and
review the facts the backend extracts — without leaving Obsidian.

Obsidian is a thin acting surface. The plugin never extracts facts locally: it
ships raw markdown to the knowledge-backend, which runs extraction and stages
the resulting assertions for your review.

## How it works

```diagram
╭───────────────╮  publish note   ╭──────────────────────╮
│   Obsidian    │ ───────────────▶│  POST /ingest/transcript │
│    vault      │                 ╰───────────┬──────────╯
╰───────────────╯                             │ trigger
        ▲                                      ▼
        │ accept / reject       ╭──────────────────────────╮
        │                       │ POST /process/transcripts │
        │                       ╰───────────┬──────────────╯
   ╭────┴───────╮  staged facts             ▼
   │  sidebar   │◀──────────  GET /ontology/proposals
   ╰────────────╯  approve ─▶ POST /ontology/proposals/{id}/approve
                   reject  ─▶ POST /ontology/proposals/{id}/reject
```

## Install

### BRAT (recommended for now)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community
   plugin.
2. BRAT → *Add beta plugin* → enter this repository URL.
3. Enable **OpenLore** in *Settings → Community plugins*.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/aakarim/obsidian-openlore/releases/latest).
2. Copy them into `<your-vault>/.obsidian/plugins/openlore/`.
3. Reload Obsidian and enable **OpenLore** in *Settings → Community plugins*.

## Configure

Open *Settings → OpenLore* and set:

| Setting | Notes |
|---|---|
| **Server URL** | Your knowledge-backend URL. Defaults to `https://openlore.sh`. |
| **API Token** | Bearer token. Leave blank when the backend runs in demo mode (`OIYA_DEMO_MODE=1`). |
| **Agent ID** | Provenance recorded on every write. Defaults to `obsidian-openlore`. |
| **Auto-publish on change** | Publishes notes automatically as you edit them (on by default). |
| **Auto-publish delay** | Seconds of quiet after edits before a batch is published (default 5). Multiple rapid edits coalesce into one publish + one extraction run. |
| **Sync whole vault on startup** | Publishes every eligible note once when the vault opens (off by default). |
| **Watched / excluded folders, excluded tags** | Scope which notes are eligible. |

## Use

With **Auto-publish on change** enabled (the default), editing or creating any
eligible note publishes it automatically after a short delay — no manual step.
For a one-time bulk push, enable **Sync whole vault on startup** or run the
command below.

Commands and controls:

- **Publish current note** — command palette, sends the active note now.
- **Publish all notes** — publishes every eligible note in the vault now.
- **Open review sidebar** — ribbon brain icon or command; lists staged facts to
  accept or reject.

## Develop

```bash
npm install
npm run dev     # watch build
npm run build   # type-check + production bundle
```

## Release

Bump `version` in `manifest.json` (and add it to `versions.json`), then push a
matching tag (Obsidian convention: the tag equals the version, no `v` prefix):

```bash
git tag 0.1.0
git push origin 0.1.0
```

The [release workflow](.github/workflows/release.yml) builds the bundle and
attaches `main.js`, `manifest.json`, `styles.css`, and `versions.json` to a
GitHub Release.
