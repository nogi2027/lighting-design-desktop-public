"use client";

import { formatCueNumber } from "../lib/cue-numbering";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SyncV2Client } from "../lib/sync-v2/client";
import type { SyncRecoveryItem, TextValues } from "../lib/sync-v2/client-store";
import { TEXT_FIELDS } from "../lib/sync-v2/text-recovery";
import { scriptPageNumber } from "../lib/script-page-number";
import type { WorkspaceState } from "../lib/types";

type Preview = NonNullable<Awaited<ReturnType<SyncV2Client["textRecoveryPreview"]>>>;
type Field = typeof TEXT_FIELDS[number];
type Choices = Record<Field, string>;
type Group = { key: string; items: SyncRecoveryItem[]; fingerprint: string };
type Review = { fingerprint: string; preview: Preview | null; choices: Choices; loading: boolean; error: string | null };
const fieldLabels: Record<Field, string> = { title: "Title", description: "Lighting intention", technicalNotes: "Technical notes" };
const serverChoices = (): Choices => ({ title: "server", description: "server", technicalNotes: "server" });

function describeRecovery(item: SyncRecoveryItem, state: WorkspaceState) {
  const action = item.envelope?.action;
  const cue = item.targetId ? state.cues.find((candidate) => candidate.id === item.targetId) : undefined;
  const cloud = (value: number | null | undefined) => formatCueNumber(value, "unassigned");
  if (item.textFallback) {
    const fields = TEXT_FIELDS.filter((field) => item.textFallback!.before[field] !== item.textFallback!.after[field]);
    return `Unsaved ${fields.length ? fields.map((field) => fieldLabels[field].toLowerCase()).join(", ") : "cue text"} edit. Choose which text to keep below.`;
  }
  if (!action) {
    if (item.kind === "volatile-unsaved-text") return "Unsaved cue text is held only in this tab.";
    if (item.kind === "composition-fragment") return "An unfinished text edit stayed on this device. The cloud kept its previous text.";
    if (item.kind === "text-history-missing") return "A cue text edit is missing the history needed to save it. The cloud kept its previous text.";
    if (item.kind === "protected-draft") return "An unsent draft stayed on this device. The cloud kept its previous values.";
    if (item.kind === "legacy-workspace-recovery") return "An older unsaved workspace edit stayed on this device. The cloud kept its previous values.";
    return "A saved device change could not reach the cloud.";
  }
  switch (action.type) {
    case "setBlackout": return `Tried to turn blackout ${action.blackout ? "on" : "off"}. The cloud still has it ${cue ? cue.blackout ? "on" : "off" : "at its previous setting"}.`;
    case "setCueMode": return `Tried to set cue status to ${action.mode}. The cloud still has ${cue?.mode ?? "its previous status"}.`;
    case "setCueNumber": return `Tried to set the cue number to ${action.number}. The cloud still has ${cloud(cue?.number)}.${item.result?.message ? ` ${item.result.message}` : ""}`;
    case "unassignCue": return `Tried to remove the cue number. The cloud still has ${cloud(cue?.number)}.`;
    case "assignNextNumber": return `Tried to assign the next cue number. The cloud still has ${cloud(cue?.number)}.`;
    case "assignCueNumbers": {
      const failed = state.cues.find((candidate) => candidate.id === item.result?.outcome?.cueId);
      const target = failed ? ` Blocked by “${failed.title || failed.id}” on page ${scriptPageNumber(failed.page)}.` : "";
      return `Tried to assign numbers to ${action.cues.length} cues. Their cloud numbers were not changed by this edit.${target}${item.result?.message ? ` ${item.result.message}` : ""}`;
    }
    case "moveCue": return `Tried to move the cue to ${state.scenes.find((scene) => scene.id === action.position.sceneId)?.name ?? "another scene"}, page ${scriptPageNumber(action.position.page)}. The cloud still has it on page ${cue ? scriptPageNumber(cue.page) : "its previous page"}.`;
    case "setSceneOwners": return `Tried to change ownership for ${action.scenes.map((change) => state.scenes.find((scene) => scene.id === change.sceneId)?.name ?? "a scene").slice(0, 3).join(", ")}${action.scenes.length > 3 ? ` and ${action.scenes.length - 3} more` : ""}. The cloud still has the previous owners.`;
    case "createCue": return `Tried to create cue “${action.cue.title}”. The cloud does not have this new cue.`;
    case "deleteCue": return `Tried to delete this cue. ${cue ? "The cloud still has it." : "The cloud currently has no active copy."}`;
    case "restoreCue": return "Tried to restore this cue. The cloud still has it in Recently deleted.";
    case "addNote": return `Tried to add a note: “${action.discussion.content.slice(0, 140)}${action.discussion.content.length > 140 ? "…" : ""}”. The cloud does not have this note.`;
    case "addReply": return `Tried to add a reply: “${action.reply.content.slice(0, 140)}${action.reply.content.length > 140 ? "…" : ""}”. The cloud does not have this reply.`;
    case "setDiscussionResolved": return `Tried to ${action.resolved ? "resolve" : "reopen"} a note. The cloud still has its previous status.`;
    case "createOrUpdateProfile": return `Tried to update ${action.profile.name}'s profile. The cloud still has its previous values.`;
    case "setInboxRead": return `Tried to ${action.read ? "dismiss" : "return"} ${action.eventIds.length} inbox update${action.eventIds.length === 1 ? "" : "s"}. The cloud still has the previous inbox state.`;
    case "setInboxPinned": return `Tried to ${action.pinned ? "pin" : "unpin"} ${action.eventIds.length} inbox update${action.eventIds.length === 1 ? "" : "s"}. The cloud still has the previous inbox state.`;
    case "restoreTextVersion": return `Tried to restore text version ${action.historyRevision}. The cloud still has the current text.`;
    case "acknowledgeNotice": return "Tried to clear a notice. The cloud still has it.";
    case "applyTextUpdate": return "Unsaved cue text edit. Choose which text to keep below.";
  }
}

export function SyncRecoveryInbox({ getClient, items, cueNames, state, actorId, onDownload, onDiscard, onDiscardAll, onCancelDiscard, discardId }: {
  getClient: () => SyncV2Client | null;
  items: SyncRecoveryItem[];
  cueNames: Record<string, string>;
  state: WorkspaceState;
  actorId: string;
  onDownload: (ids?: string[]) => void;
  onDiscard: (item: SyncRecoveryItem) => Promise<void>;
  onDiscardAll: (ids: string[]) => Promise<void>;
  onCancelDiscard: () => void;
  discardId: string | null;
}) {
  const groups = useMemo(() => {
    const byTarget = new Map<string, SyncRecoveryItem[]>();
    for (const item of items) {
      const key = item.targetId ?? `other:${item.id}`;
      byTarget.set(key, [...byTarget.get(key) ?? [], item]);
    }
    return [...byTarget].map(([key, groupItems]) => ({ key, items: groupItems, fingerprint: groupItems.map((item) => item.id).join("|") }));
  }, [items]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [discardAllFingerprint, setDiscardAllFingerprint] = useState<string | null>(null);
  const currentFingerprint = items.map((item) => item.id).join("|");
  const reviewFor = useCallback((group: Group) => reviews[group.key]?.fingerprint === group.fingerprint ? reviews[group.key] : undefined, [reviews]);

  const load = useCallback(async (group: Group, force = false) => {
    if (group.key.startsWith("other:") || !group.items.some((item) => item.kind === "text-history-missing" || item.envelope?.action.type === "applyTextUpdate" || !!item.textFallback) || !force && (reviewFor(group)?.loading || reviewFor(group)?.preview)) return;
    const client = getClient();
    if (!client) { setMessage("Recovery is unavailable. Your saved copy is still on this device."); return; }
    setReviews((current) => ({ ...current, [group.key]: { fingerprint: group.fingerprint, preview: null, choices: serverChoices(), loading: true, error: null } }));
    try {
      const preview = await client.textRecoveryPreview(group.key);
      const choices = serverChoices();
      if (preview?.plan) for (const field of TEXT_FIELDS) {
        if (!preview.plan.conflicts.includes(field) && preview.plan.suggested[field] !== preview.server[field] && preview.plan.choices[field].length === 1) choices[field] = preview.plan.choices[field][0].itemId;
      }
      setReviews((current) => current[group.key]?.fingerprint === group.fingerprint ? { ...current, [group.key]: { fingerprint: group.fingerprint, preview, choices, loading: false, error: null } } : current);
    } catch (error) {
      setReviews((current) => current[group.key]?.fingerprint === group.fingerprint ? { ...current, [group.key]: { fingerprint: group.fingerprint, preview: null, choices: serverChoices(), loading: false, error: error instanceof Error ? error.message : "The latest text could not be loaded." } } : current);
    }
  }, [getClient, reviewFor]);
  useEffect(() => {
    if (!open) return;
    for (const group of groups) {
      if (expanded.has(group.key) && !reviewFor(group)) void load(group);
    }
  }, [expanded, groups, load, open, reviewFor]);
  const toggleGroup = (group: Group) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
      return next;
    });
  };
  const expandAll = () => {
    setExpanded(new Set(groups.map((group) => group.key)));
  };
  const changeChoice = (group: Group, field: Field, choice: string) => {
    setReviews((current) => {
      const review = current[group.key];
      if (!review || review.fingerprint !== group.fingerprint) return current;
      return { ...current, [group.key]: { ...review, choices: { ...review.choices, [field]: choice } } };
    });
  };
  const applyGroup = async (group: Group) => {
    const review = reviewFor(group);
    const client = getClient();
    if (!client || !review?.preview?.plan) return false;
    const preview = review.preview;
    const desired = Object.fromEntries(TEXT_FIELDS.map((field) => [field, preview.plan!.choices[field].find((choice) => choice.itemId === review.choices[field])?.value ?? preview.server[field]])) as TextValues;
    try {
      const outcome = await client.applyTextRecovery(group.key, preview.revision, desired, preview.itemIds, actorId);
      if (outcome === "applied") return true;
      if (outcome === "stale") {
        await load(group, true);
        setMessage(`${cueNames[group.key] ?? group.key} changed while you reviewed it. Check the latest text before saving.`);
      } else setMessage("The selected text was not saved. Your local copy is still here.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The selected text was not saved. Your local copy is still here."); }
    return false;
  };
  const saveOne = async (group: Group) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try { onDownload(group.items.map((item) => item.id)); }
    catch { setMessage("The original copies could not be downloaded. Nothing was saved or cleared."); setBusy(false); return; }
    const saved = await applyGroup(group);
    if (saved) setMessage("Your selected text was saved.");
    setBusy(false);
  };
  const discardOne = async (item: SyncRecoveryItem) => {
    if (busy) return;
    setMessage(null);
    if (discardId !== item.id) {
      await onDiscard(item);
      return;
    }
    setBusy(true);
    try { await onDiscard(item); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The copy could not be discarded. It is still saved on this device."); }
    finally { setBusy(false); }
  };
  const show = () => {
    setOpen((value) => !value);
  };
  const discardAll = async () => {
    if (busy) return;
    if (discardAllFingerprint !== currentFingerprint) {
      setDiscardAllFingerprint(currentFingerprint);
      setMessage(null);
      return;
    }
    setBusy(true);
    setDiscardAllFingerprint(null);
    try { await onDiscardAll(items.map((item) => item.id)); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Some copies could not be discarded. Review the remaining copies."); }
    finally { setBusy(false); }
  };

  return <div className={`inbox-stack-shell recovery-stack ${open ? "expanded" : ""}`} id="inbox-recovery-card" tabIndex={-1}>
    <article className="inbox-event recovery unread action-required pinned">
      <button className="inbox-event-open" aria-label={open ? "Collapse recovery changes" : "Expand recovery changes"} aria-expanded={open} aria-controls="inbox-recovery-details" onClick={show} />
      <span className="unread-dot" aria-label="Needs recovery" />
      <div className="activity-kind">RECOVERY</div>
      <span className="recovery-device-mark" aria-hidden="true">!</span>
      <div className="activity-copy"><div className="activity-requirement action">ACTION REQUIRED · SAVED ON THIS DEVICE</div><p><strong>{items.length} saved change{items.length === 1 ? "" : "s"}</strong> need{items.length === 1 ? "s" : ""} review.</p><span>Discard keeps the current cloud values. Open to review each change.</span></div>
      <span className="inbox-open-label grouped recovery-accordion-label" aria-hidden="true">{open ? "HIDE" : "SHOW"} {items.length} {items.length === 1 ? "CHANGE" : "CHANGES"} {open ? "↑" : "↓"}</span>
    </article>
    {open && <div className="inbox-stack-details recovery-details" id="inbox-recovery-details">
      {message && <p role="status" className="sync-recovery-message">{message}</p>}
      <div className="recovery-bulk-actions">{groups.length > 1 && <button type="button" onClick={expandAll}>Expand all</button>}<button type="button" className="recovery-discard-all" disabled={busy} onClick={() => void discardAll()}>{discardAllFingerprint === currentFingerprint ? `Confirm discard all ${items.length} ${items.length === 1 ? "copy" : "copies"}` : "Discard all"}</button>{discardAllFingerprint === currentFingerprint && <><button type="button" onClick={() => setDiscardAllFingerprint(null)}>Keep copies</button><small>These device copies will be removed. Download them from each card’s Technical details first if needed.</small></>}</div>
      {groups.map((group) => {
        const expandedGroup = expanded.has(group.key);
        const review = reviewFor(group);
        const hasOtherCopies = !!review?.preview?.plan && group.items.some((item) => !review.preview?.itemIds.includes(item.id));
        const mayHaveText = group.items.some((item) => item.kind === "text-history-missing" || item.envelope?.action.type === "applyTextUpdate" || !!item.textFallback);
        const actionLabel = review?.preview?.plan ? "Review and save" : mayHaveText && (!review || review.loading) ? "Checking save options" : "Review before discard";
        return <section className="recovery-group" key={group.key}>
          <button type="button" className="recovery-group-toggle" aria-expanded={expandedGroup} onClick={() => toggleGroup(group)}><span className="recovery-group-main"><strong>{cueNames[group.key] ?? "Other saved change"}</strong><em>{describeRecovery(group.items[0], state)}</em></span><small>{actionLabel} · {group.items.length} change{group.items.length === 1 ? "" : "s"}</small><span>{expandedGroup ? "−" : "+"}</span></button>
          {expandedGroup && <div className="recovery-group-body">
            <div className="recovery-action-summary">{group.items.map((item) => <p key={item.id}>{describeRecovery(item, state)}</p>)}<small>Discard removes the device copy and keeps the current cloud values.</small></div>
            {review?.loading && <p role="status">Loading the latest text…</p>}
            {review?.error && <p role="alert">{review.error} <button type="button" onClick={() => void load(group)}>Retry</button></p>}
            {review?.preview?.plan ? <><p>Choose the text to keep for each field. Save choices downloads the original device copies with their authors before clearing them.</p>
              {TEXT_FIELDS.map((field) => <section className="sync-recovery-field" key={field}><h4>{fieldLabels[field]}</h4><div className="sync-recovery-versions">
                <label><input type="radio" name={`recovery-${group.key}-${field}`} checked={review.choices[field] === "server"} onChange={() => changeChoice(group, field, "server")} /><span>Current server text</span><pre>{review.preview!.server[field] || "(empty)"}</pre></label>
                {review.preview!.plan!.choices[field].map((choice) => <label key={choice.itemId}><input type="radio" name={`recovery-${group.key}-${field}`} checked={review.choices[field] === choice.itemId} onChange={() => changeChoice(group, field, choice.itemId)} /><span>Saved by {state.profiles.find((profile) => profile.id === choice.actorId)?.name ?? (choice.actorId || "unknown editor")}</span><pre>{choice.value || "(empty)"}</pre></label>)}
              </div></section>)}
              {hasOtherCopies && <p>This cue has another saved copy. Save choices handles the text shown here; review the other copy separately.</p>}
            </> : !review?.loading && <p>{mayHaveText ? "This change has no readable text comparison. Review or download the copy before discarding it." : "This change cannot be saved from here. Review or download its copy before discarding it."}</p>}
            <div className="recovery-group-actions">{review?.preview?.plan && <button type="button" className="inbox-resolve" disabled={busy} onClick={() => void saveOne(group)}>Save choices</button>}{group.items.map((item, index) => <span className="recovery-discard-choice" key={item.id}>{discardId === item.id && <button type="button" onClick={onCancelDiscard}>Keep copy</button>}<button type="button" className={discardId === item.id ? "confirm-delete" : ""} disabled={busy} onClick={() => void discardOne(item)}>{discardId === item.id ? `Confirm discard${group.items.length > 1 ? ` ${index + 1}` : ""}` : `Discard copy${group.items.length > 1 ? ` ${index + 1}` : ""}`}</button></span>)}</div>
            <details><summary>Technical details</summary><button type="button" className="recovery-download" onClick={() => onDownload(group.items.map((item) => item.id))}>Download copy</button>{group.items.map((item) => <pre key={item.id}>{item.raw ?? JSON.stringify({ envelope: item.envelope, textFallback: item.textFallback, createdAt: item.createdAt, result: item.result }, null, 2)}</pre>)}</details>
          </div>}
        </section>;
      })}
    </div>}
  </div>;
}
