# Sync v2: notifications and recovery UI

Revision 2, 2026-09-09. Companion to the [core contract](sync-v2-implementation-spec.md). N identifiers are stable test references. These UI requirements are delivered by milestone, not all prerequisite to the first isolated sync test.

## 8. User notifications and recovery actions

### 8.1 Presentation rules

- Use one persistent connection/save indicator in the existing top bar. Use a compact persistent banner only when editing is unavailable or work needs attention.
- Put validation beside the affected field. Put changed-result notices beside the affected record and in history. Reserve red for data at risk or a failed required action; use neutral/amber for stale viewing and automatic adjustments.
- Ordinary successful typing updates the status quietly. Do not show a success toast on every keystroke or a notice for harmless duplicate delivery.
- Use a 5-second toast for a completed recovery or changed result, with a durable history entry for details. Never rely on the toast alone to explain an adjustment.
- A blocked state or an unconfirmed recovery issue stays visible until its condition clears. Dismissing a toast never discards work or changes the underlying record.
- Group repeated notices by connection incident or operation/record. Do not produce one notice per retry or remote keystroke.
- Use `role=status`/polite live announcements for routine transitions. Use `role=alert` once for local persistence failure or a user-triggered permanent failure. Keep controls keyboard accessible and preserve focus.
- Use “your” only for the current session/actor's work. Team-wide notices use the actual recorded profile or “another editor” if attribution is unavailable.
- Values in messages must come from the receipt/current state. Do not guess who edited, whether work is safe, or whether a device is offline when the server may simply be unavailable.
- “Saved locally” requires a completed local transaction. “Saved to server” requires an `applied`, `adjusted`, or `unchanged` receipt for the corresponding work; an adjusted result also needs its specific notice. A terminal `not_applied` receipt proves only that the request and outcome were recorded, not that its requested change was saved. “Synced” additionally requires no known event gap or unapplied response; it does not promise every other device has received the update.

### 8.2 Message catalogue

Placeholders such as `{cue}`, `{number}`, `{count}`, and `{time}` must be escaped as text. Singular/plural messages must agree with the actual counts.

| ID | Trigger | Exact default copy | Placement and actions | Clear condition |
| --- | --- | --- | --- | --- |
| N01 | Initial connection check | “Checking connection. Editing is paused.” | Status/banner; cached content remains readable. | Successful catch-up or another known state. |
| N02 | Browser reports offline; no pending shared work | “Offline. You can view the saved workspace. Reconnect to edit.” | Persistent banner, last synced time, Retry connection. | Recovery completes. |
| N03 | Server unreachable/freshness expired | “Connection lost. Editing is paused. Showing the workspace saved at {time}.” | Persistent banner; Retry connection. Avoid claiming the whole device is offline. | Recovery completes. |
| N04 | Connection lost with locally durable pending work | “Editing is paused. {count} changes are saved on this device and waiting to reach the server.” | Persistent banner; Retry connection, Download recovery copy. | Receipts settle these IDs. |
| N05 | Connection restored; recovery running | “Reconnected. Checking saved changes before editing resumes.” | Persistent status; no editable controls yet. | Catch-up and recovery barrier passes. |
| N06 | All pending changes confirmed applied/unchanged | “Reconnected. Your pending changes are saved to the server.” | One toast; ordinary saved status resumes. | Toast timeout; evidence stays in history. |
| N07 | Normal admitted edit, local transaction pending | “Saving on this device…” | Quiet status. | Local commit or failure. |
| N08 | Locally committed shared edit awaiting receipt | “Saved on this device. Sending…” | Quiet status; after a prolonged wait show N04/N09 as applicable. | Terminal receipt. |
| N09 | Save response lost/outcome unknown | “Checking whether your last change was saved. Editing is paused.” | Persistent status/banner; Retry connection. | Receipt lookup or same-ID retry settles result. |
| N10 | Shared edits applied/adjusted/unchanged, view caught up, no unresolved recovery items | “Saved to server” | Quiet top-bar status with last checked time in details; retain notices for adjustments. | Next edit, gap, or loss of freshness. |
| N11 | Local storage write fails | “This change could not be saved on this device. Keep this tab open and copy or download your text. Editing is paused.” | Persistent alert; Copy text, Download recovery copy, Retry storage. | Export does not clear it; a verified storage recovery does. |
| N12 | Unposted draft committed locally | “Draft saved on this device. Not posted.” | Beside draft. | Posted receipt or deliberate draft removal while online. |
| N13 | Requested number was occupied | “{requested} was already in use. {cue} was assigned {assigned}.” | Record notice + toast + history; View cue, View history. | Toast expires; record notice remains discoverable. |
| N14 | Allocator cannot find a valid number | “A number could not be assigned. {cue} is still unassigned.” | Persistent record notice; Edit number once connected. | Successful explicit assignment. |
| N15 | Structured replacement loses to a newer value | “{field} changed before your update arrived. Kept {current}. Your request is saved in history.” | Record notice; View history. A new edit uses current versions. | Seen/acknowledged; original request remains retained. |
| N16 | Cue deleted while open | “{cue} was moved to Recently deleted. Editing this cue is paused.” | Cue-panel banner; View deleted cue. | Leave panel or explicit restore succeeds. |
| N17 | Late text/reply stored in deleted cue | “Your change was saved with {cue} in Recently deleted.” | Quiet receipt/history detail in Recently deleted; no alert because no action is required. | Content stays retained. |
| N18 | Restoration needs another number | “{cue} was restored as {assigned}; {requested} is already in use.” | Record notice + history. | Normal notice lifecycle. |
| N19 | Move cannot replace a newer anchor | “This cue moved before your change arrived. Kept its current position. Your requested move is saved in history.” | Cue notice; View current position, View history. | Acknowledgement or a new explicit move. |
| N20 | Field also changes remotely during editing | “This field also changed elsewhere. View history.” | Small field indicator, at most once per field/edit session. | Blur/seen; history persists. |
| N21 | Concurrent text exceeds authoring limit | “This field is {count} characters over the limit after combining edits. All text was kept. Shorten it to add more.” | Inline warning; allow copy and shortening while connected. | Text returns within limit. |
| N22 | Local paste exceeds a hard authoring bound | “This paste is too long for {field}. It was kept as a draft.” | Inline message; View draft, Copy draft. | Deliberate correction; do not silently clear draft. |
| N23 | Validation fails for an action | “This change could not be applied: {specificReason}. Your draft was kept.” | Inline/permanent issue; Edit draft or View recovery. | A new valid action succeeds or user explicitly discards retained draft. |
| N24 | Protocol/epoch changes | “An update is required before editing can resume. Your pending work will be kept.” | Persistent banner; Review pending work, Reload when protected. | New compatible client completes recovery. |
| N25 | Maintenance/write pause | “Editing is temporarily paused for an update. You can keep viewing the workspace.” | Persistent banner; Retry connection. | Server resumes and client catches up. |
| N26 | Cache/PDF incomplete | “Some content is not saved on this device. Reconnect to load {content}.” | At missing content; no endless loading spinner. | Verified cache download. |
| N27 | No offline cache | “Connect to load this workspace. No saved copy is available on this device.” | Read-only empty state; Retry connection. | Bootstrap succeeds. |
| N28 | Recovery contains a permanent/dependency problem | “{count} saved changes need attention. They have not been discarded.” | Persistent recovery panel; Show details, Download recovery copy. | Explicitly resolved/exported and safely separated; never silent acknowledgement. |
| N29 | Server throttled or busy | “The server is busy. Your saved changes will retry automatically.” | Quiet top-bar save status; if freshness expires, also show paused editing. | Successful contact/recovery. |
| N30 | Hosting access unavailable | “Access to the server is unavailable. Editing is paused; pending changes remain on this device.” | Banner; existing sign-in/access flow if supplied by hosting, otherwise Retry connection. | Verified access and recovery. |
| N31 | History preview became stale | “This field changed while you were reviewing the old version. Review the latest preview before restoring.” | Restore preview; Refresh preview. | New deliberate Restore against refreshed state. |
| N32 | Remote changes found after reconnect, no pending work | “Reconnected. The latest team changes are loaded.” | One toast. | Timeout. |
| N33 | One cue has unresolved recovery while unrelated targets can reopen | “A change to {cue} was not saved. Review it before using that control again.” | Small message beside the affected control; recovery details stay in Settings. | Cue dependency/recovery chain settles. |
| N34 | Bulk numbering succeeds with unchanged targets | “Assigned numbers to {count} cues. {unchangedCount} already had numbers and were kept.” | Action result/history only; no alert because no action is required. | Normal history lifecycle. |
| N35 | Atomic bulk numbering cannot apply | “No new numbers were assigned. {specificReason}. Review the selected cues and try again.” | Bulk action notice; View affected cues. | New deliberate bulk request; original request remains in history. |
| N36 | Backup preparing, incomplete, or interrupted | “Backup is not complete yet. {completed} of {total} parts are verified.” | Export panel; Resume download. Do not show a successful-backup badge. | Manifest, all parts, and PDF verify. |
| N37 | Target exceeds measured safe processing/storage budget | “Editing {cue} is paused because its saved history could not be processed safely. Your pending work was kept.” | Target recovery panel; Copy/export. Use N11 if local work is not durable. | Validated repair/migration; never silent history deletion. |

For N04/N06/N08/N11/N23/N24/N28/N30, choose wording according to evidence. If local persistence failed, never say pending changes “remain on this device” in a durable sense; show N11 instead. If an action was not applied or adjusted, do not use N06 as the only message. Show the operation-specific outcome.

### 8.3 Recovery panel behavior

Each item shows its cue/target, actor, original text or requested action, local creation time, server outcome if known, and current protection state. Offer copy/export without requiring connection. Applying a recovered draft is an edit and requires the edit gate to be open.

Retry is available only for retryable items and retains the original operation ID. A corrected/reapplied request gets a new ID linked to the original item. Exporting does not mark an unknown server outcome as failed or remove its pending operation. Destructive discard of recovery data requires a specific user action and must never be bundled into Reload.
