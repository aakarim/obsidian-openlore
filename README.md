# OpenLore for Obsidian

Collaborate on your **agent knowledge**. Two-way sync between your Obsidian
vault and a **shared OpenLore knowledge server**. Your team's folders show up in
your vault to read; your own notes sync back up. No approval queues — just read
and write.

## How it works

You sign in to the lore server (passkey, in your browser), then **choose which
docsets to sync** and **where each one lives** in your vault. Nothing syncs until
you map a folder.

```diagram
        Obsidian vault                          Shared lore server (docsets)
 ╭────────────────────────────╮         ╭──────────────────────────────╮
 │ Work/mine/     (writable) ─┼──push──▶│  home     (rw) ← your folder  │
 │ Refs/backend/ (read-only) ◀┼──pull───┤  backend  (r)                 │
 │ (frontend not mapped)      │    ✗     │  frontend (r)  ← not synced   │
 ╰────────────────────────────╯         ╰──────────────────────────────╯
```

Each mapped folder holds a hidden **Lorefile** (`.lore`) naming the docset it
maps to. Because the mapping lives *inside* the folder, you can **rename or move
the folder** freely and it keeps syncing. Mapped folders show a small badge in
the file explorer — hover it to see which docset (and read/write vs read-only)
it maps to.

- A **writable** docset (`rw`, e.g. your home) is pushed: edits/creates/deletes
  in its folder mirror up automatically (debounced).
- A **read-only** docset is pulled into its folder, refreshed on a timer and on
  demand. Writable folders are never overwritten by a pull.

Add a folder from the OpenLore panel (**+**) or the *Map an OpenLore folder*
command: pick a docset, pick a vault location, done.

All communication is over HTTPS to go-openlore's JSON API (`POST /api/shell`),
authenticated with a short-lived OAuth bearer token (auto-refreshed). File
operations run as scoped shell commands (`lore docsets`, `find`, `cat`,
`base64 -d`, `mkdir -p`, `rm`) as your identity — the server enforces access.

## Install

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/aakarim/obsidian-openlore/releases/latest).
2. Copy them into `<your-vault>/.obsidian/plugins/openlore/`.
3. Reload Obsidian and enable **OpenLore** in *Settings → Community plugins*.

### BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), *Add beta plugin*,
and enter this repository URL.

## Setup

1. Open the welcome wizard, enter your **Lore server URL** (e.g.
   `https://openlore.sh`), and click **Sign in with OpenLore**.
2. Your browser opens the server's passkey login. Authenticate there.
3. The server redirects back to Obsidian (`obsidian://openlore-auth`) with an
   authorization code, which the plugin exchanges (OAuth authorization-code +
   PKCE) for a short-lived bearer token and a refresh token.
4. The plugin runs `lore docsets` to discover the docsets you can access.
5. In the OpenLore panel, click **+** next to *Synced folders* to map a docset
   into a vault folder. Nothing syncs until you do.

Re-sign in or sign out any time from the OpenLore panel.

> **Desktop and mobile.** The plugin registers the
> `obsidian://openlore-auth` callback for the OAuth redirect. On mobile, sync
> runs while Obsidian is open; mobile operating systems may suspend it in the
> background.

> **Per-vault settings.** Sign-in and server settings are stored in device-local
> IndexedDB, namespaced by vault. They are not copied through Obsidian Sync, and
> different vaults can point at different lore servers.

## The OpenLore panel

Open it from the **brain** ribbon icon or the *Open OpenLore panel* command. It
is the plugin's control surface:

- Connection status, signed-in identity, and last-sync time.
- **Sync now** and **Sign in / Sign out** buttons.
- **Synced folders**: your folder→docset mappings, with **+** to add and an
  unlink button to remove one.
- Connection settings: server URL and sign-in.
- Sync settings: default base folder, auto-sync delay, pull interval.

## Develop

```bash
npm install
npm run dev     # watch build
npm run build   # type-check + production bundle
```

## Release

Bump `version` in `manifest.json` (and add it to `versions.json`), then push a
matching tag (no `v` prefix):

```bash
git tag 0.2.0
git push origin 0.2.0
```

The [release workflow](.github/workflows/release.yml) builds the bundle and
attaches `main.js`, `manifest.json`, `styles.css`, and `versions.json` to a
GitHub Release.
