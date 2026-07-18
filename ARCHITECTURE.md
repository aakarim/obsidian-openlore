# OpenLore Obsidian Plugin Architecture

This document describes the synchronization architecture of the OpenLore
Obsidian plugin. It distinguishes the behavior implemented today from the
target reconciliation model the plugin should adopt as synchronization becomes
more collaborative and supports longer offline periods.

## System Boundary

The plugin synchronizes Markdown files between an Obsidian vault and OpenLore
docsets exposed through the server's virtual filesystem (VFS).

Each folder mapping connects one vault path to one server mount:

```diagram
┌──────────────────────────┐          ┌──────────────────────────┐
│ Obsidian vault folder    │◀────────▶│ OpenLore docset mount    │
│ OpenLore/zeb             │          │ /agent/zeb               │
└──────────────────────────┘          └──────────────────────────┘
```

Mappings are either:

- **Read/write:** local and server changes can flow in both directions.
- **Read-only:** server changes are pulled, but local changes are never
  published to that docset.

The plugin communicates with the server through `POST /api/shell`. It uses
commands such as `find`, `stat`, `cat`, `mkdir`, `base64 -d`, and `rm` to
operate on files within the authenticated identity's VFS permissions.

## Sync Entry Points

Synchronization can begin from several places:

- A manual **Sync now** action.
- The configured automatic sync interval.
- Debounced Obsidian create and modify events.
- An explicit save, which pushes immediately.
- Local delete and rename events.
- Initial plugin setup or resuming after a pause.

**Target invariant:** all entry points must use the same per-path reconciliation
policy. Scheduling and UI may differ, but conflict and overwrite behavior must
not depend on how synchronization started.

Automatic synchronization can be paused from the sidebar. A pause is persisted
as an expiry timestamp, stops scheduled and event-driven synchronization, and
expires automatically after 24 hours. Manual **Sync now** remains available.

## Current Reconciliation Model

The current implementation stores a content hash for each server path. The hash
represents the content most recently synchronized for that path and acts as a
lightweight baseline.

```diagram
                         last synced hash
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          current local content    current server content
```

A full sync currently:

1. Lists remote Markdown files for every mapping.
2. Fetches remote modification times.
3. Uses matching modification times to avoid unnecessary content reads.
4. Pulls remote content when the local copy has not changed since the baseline.
5. Mirrors safe server deletions and prunes directories made empty by them.
6. Runs a separate push pass over writable mappings.

This supports ordinary one-sided edits, but it is not yet a complete
multi-writer synchronization protocol:

- A divergent local and server edit can be recognized during pull, but the
  later push pass can still resolve it implicitly as local-wins.
- Event-driven pushes do not condition the server write on the remote content
  observed during reconciliation.
- The stored hash is currently a small djb2 change detector rather than a
  collision-resistant content identity.
- The remote mtime has one-second precision and is not a safe source of
  ordering or causality.
- Renames are represented as path-level creates and deletes rather than moves
  of a stable file identity.

These limitations motivate an explicit baseline-driven algorithm.

## Target Algorithm: Baseline-Based Bidirectional Sync

OpenLore should use baseline-based bidirectional reconciliation:

> One-sided changes synchronize automatically. Divergent concurrent changes
> become explicit conflicts. Timestamps optimize scanning but never choose a
> winner.

For every path, define:

- `B`: the last content known to exist on both sides (baseline hash).
- `L`: the current local content hash, or `∅` when locally absent.
- `R`: the current remote content hash, or `∅` when remotely absent.

### Known Baseline

| Local state | Remote state | Decision |
|---|---|---|
| `L = B` | `R = B` | No change. |
| `L = B` | `R ≠ B` | Pull the remote change. |
| `L ≠ B` | `R = B` | Conditionally push the local change. |
| `L = R`, both differ from `B` | Same resulting content | Record the new baseline. |
| `L ≠ B` | `R ≠ B` and `L ≠ R` | Conflict; change neither side automatically. |

Absence is a value in this table, not a separate special case. This gives
deletions predictable semantics:

| Local state | Remote state | Decision |
|---|---|---|
| Unchanged | Deleted | Delete locally. |
| Deleted | Unchanged | Conditionally delete remotely. |
| Edited | Deleted | Conflict. |
| Deleted | Edited | Conflict. |

### No Baseline

Sync state is device-local and may be missing after a new installation or state
loss. Without a baseline, the plugin cannot safely infer which side changed.

| Local state | Remote state | Decision |
|---|---|---|
| `L = R` | Same content | Record a baseline. |
| Only remote exists | Local absent | Pull as a remote creation. |
| Only local exists | Remote absent, writable mapping | Push using create-only conditional semantics. |
| Only local exists | Remote absent, read-only mapping | Preserve locally and flag it as outside the mirror. |
| Both exist and differ | Unknown history | Conflict; do not choose a winner. |
| Both absent | No content | Ignore. |

The no-baseline policy must remain non-destructive. Existing content alone is
not evidence that the other side should be overwritten or deleted.

## Reconciliation Invariants

The target implementation must preserve these invariants:

1. **A baseline means agreement.** It represents exact content known to have
   existed on both local and remote sides.
2. **State advances only after commit.** Update the baseline only after the
   destination write or deletion succeeds.
3. **Only one-sided changes apply automatically.** Divergent changes never have
   an implicit winner.
4. **Absence participates in comparison.** Edits, creations, and deletions use
   the same state machine.
5. **Missing state is non-destructive.** A missing baseline cannot authorize an
   overwrite or deletion of existing content.
6. **Remote mutations are conditional.** A write or delete must fail if the
   remote content changed after it was observed.
7. **All entry points share one reconciler.** Manual, scheduled, save-triggered,
   delete, and rename flows use identical decision rules.
8. **Per-path reconciliation is serialized.** Pull and push operations cannot
   concurrently mutate the same path.
9. **Modification time is advisory only.** Content hashes or server revisions
   determine correctness.
10. **Conflicts are durable and visible.** A conflicted path is blocked from
    automatic mutation until explicitly resolved.
11. **A failed or partial remote listing cannot imply deletion.** Remote absence
    is trusted only after a complete successful listing.

## Conflict Handling

A writable-path conflict must leave both canonical versions unchanged and block
future automatic mutation of that path.

Persisted conflict metadata should include:

- Baseline hash.
- Observed local hash or absence.
- Observed remote hash or absence.
- Detection time.
- Remote revision or snapshot when available.

The sidebar should expose these explicit resolutions:

- **Keep local:** conditionally publish the local version against the observed
  remote hash or revision.
- **Keep OpenLore:** verify that local content has not changed again, then apply
  the current remote version.
- **Keep both:** preserve one version under a unique conflict-note path and
  reconcile the two resulting paths independently.
- **Resolve manually:** let the user combine both versions, then conditionally
  publish the result.

If either side changes after conflict detection, resolution must reconcile
again rather than applying a stale choice.

For read-only mappings, OpenLore is canonical, but unique local bytes should not
be silently discarded. A locally modified version should be preserved in a
clearly identified, sync-excluded conflict area before restoring the canonical
server copy.

## Why Other Algorithms Are Not the Default

| Algorithm | Benefit | Reason not to use as the default |
|---|---|---|
| Timestamp winner | Very simple | Clock skew, coarse mtimes, copied mtimes, and same-second edits cause silent loss. |
| Server-authoritative | Predictable mirror | Destroys offline work in writable mappings. Appropriate only for explicitly read-only content. |
| Local-authoritative | Simple upload behavior | Overwrites collaborators' server edits and recreates intentional remote deletions. |
| Full three-way merge | Automatically merges independent text edits | Requires storing baseline content and still needs explicit conflict handling. |
| CRDT | Supports real-time concurrent editing | Unnecessary complexity for whole-file, periodic Markdown synchronization. |
| Revision and tombstone protocol | Strong offline, delete, and rename semantics | Correct long-term direction, but requires server protocol support. |

## Transport Requirements

Correct multi-writer synchronization requires compare-and-swap behavior at the
server boundary. A future API should support operations equivalent to:

```text
write(path, newContent, expectedRemoteHash | expectedAbsent)
delete(path, expectedRemoteHash)
```

The server should reject a mutation when its current hash or revision differs
from the expectation and return the current state for reconciliation. A read
immediately before the existing shell write narrows the race but cannot remove
it because another writer may commit between those operations.

A remote manifest should eventually provide, per path:

- SHA-256 content hash.
- Size.
- Modification time as an optimization.
- Monotonic revision when available.

Exact-byte SHA-256 should replace djb2 as synchronization state. Line endings
and trailing newlines must either remain byte-preserving through transport or
have one documented canonical representation.

## Deletions and Renames

Keep a baseline after a failed or offline local deletion. On the next sync,
`L = ∅` and `R = B` correctly retries the remote deletion. Remove path state
only after both sides are confirmed absent.

Near term, represent rename as:

1. Conditionally create the destination.
2. Conditionally delete the source only after destination creation succeeds.

Do not infer renames solely from matching content hashes because copying files
is common in Markdown vaults. Robust remote and concurrent rename handling
ultimately requires stable file IDs so the same file can be recognized across
path changes.

## Evolution Plan

### Phase 1: Complete Baseline Reconciliation

- Replace djb2 with SHA-256.
- Implement the `B/L/R` decision table for every path.
- Persist and display conflicts.
- Prevent conflicted paths from entering the later push pass.
- Route event-driven writes and deletes through the same reconciler.
- Treat deletion as absence in the shared state machine.
- Advance baseline state only after successful local or remote commit.

### Phase 2: Add Conditional Server Mutations

- Expose expected-hash or expected-revision writes and deletes.
- Return the committed hash or revision from each successful mutation.
- Reconcile again when a conditional mutation fails.

### Phase 3: Add Conservative Markdown Merging

- Store compressed baseline content locally in addition to its hash.
- Use a three-way text merge for non-overlapping edits.
- Validate YAML frontmatter after merging.
- Keep overlapping edits and edit/delete combinations as explicit conflicts.
- Never automatically publish Git-style conflict markers.

### Phase 4: Add Revisions, Tombstones, and Stable IDs

- Assign stable file IDs and monotonic server revisions.
- Retain deletion tombstones long enough for supported offline periods.
- Represent moves using stable IDs rather than inferred delete/create pairs.
- Add a durable change cursor or feed as an optimization.
- Retain full reconciliation as recovery when a cursor expires or state is lost.

Central server revisions plus conservative text merging are sufficient for this
architecture. Vector clocks are only necessary if independent servers must
accept writes while disconnected from one another.

## Open Questions

- How long must clients remain safely offline? This determines tombstone and
  change-log retention.
- How should conflict snapshots be stored, displayed, and garbage-collected?
- Is storing compressed baseline Markdown in device-local IndexedDB acceptable
  for expected vault sizes and privacy requirements?
- Should selected docsets support an explicit server-authoritative policy in
  addition to read-only mappings?
- How should simultaneous renames to different paths be presented?
- What canonical byte representation, if any, should apply to line endings and
  trailing newlines?

Obsidian Sync and OpenLore must not independently synchronize the same files.
No OpenLore reconciliation algorithm can guarantee correctness when another
synchronization system concurrently mutates the same local paths.
