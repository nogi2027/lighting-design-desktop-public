"use client";

import { useEffect, useRef, useState } from "react";
import { DiscussionCard, type DiscussionCardProps } from "./discussion-card";
import { CloseIcon, NoteIcon } from "./script-icons";
import type { Discussion } from "../lib/types";

export function ScriptNoteSheet({ notes, onDismiss, ...props }: Omit<DiscussionCardProps, "discussion" | "surface"> & { notes: Discussion[]; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(notes.length === 1 ? notes[0].id : null);
  const pill = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const wasExpanded = useRef(false);
  const replying = useRef(props.replyingToId);
  useEffect(() => { replying.current = props.replyingToId; }, [props.replyingToId]);
  const thread = notes.find(note => note.id === threadId);
  const preview = thread ?? notes[0];
  useEffect(() => {
    if (!expanded) {
      if (!wasExpanded.current) return;
      wasExpanded.current = false;
      const frame = requestAnimationFrame(() => pill.current?.focus({ preventScroll:true }));
      return () => cancelAnimationFrame(frame);
    }
    wasExpanded.current = true;
    sheet.current?.querySelector<HTMLButtonElement>(".note-sheet-done")?.focus({ preventScroll:true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || replying.current) return;
      event.preventDefault(); setExpanded(false); pill.current?.focus({ preventScroll:true });
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [expanded]);
  return <>
    {!expanded && <div className="phone-cue-pill script-note-pill"><button ref={pill} className="phone-cue-open" type="button" aria-haspopup="dialog" aria-label={`Open ${notes.length > 1 ? `${notes.length} notes` : "script note"}`} onClick={() => setExpanded(true)}><NoteIcon /><strong>{notes.length > 1 ? `${notes.length} notes` : "Note"}</strong><span>{preview.content}</span><small>{preview.replies.length} {preview.replies.length === 1 ? "reply" : "replies"}</small></button><button type="button" aria-label="Dismiss selected note" onClick={onDismiss}><CloseIcon /></button></div>}
    {expanded && <aside ref={sheet} className="script-note-sheet" role="dialog" aria-label="Script notes"><header><NoteIcon /><b>{thread ? "NOTE & REPLIES" : `${notes.length} NOTES`}</b>{notes.length > 1 && thread && <button type="button" onClick={() => setThreadId(null)}>All notes</button>}<button className="note-sheet-done" type="button" onClick={() => { setExpanded(false); pill.current?.focus({ preventScroll:true }); }}>Done</button></header><div className="script-note-sheet-body">{thread ? <DiscussionCard {...props} surface="panel" discussion={thread} focused onDismiss={undefined} /> : notes.map(note => <button type="button" className="script-note-list-item" key={note.id} onClick={() => { setThreadId(note.id); props.onOpen(note.id); }}><span>{note.content}</span><small>{note.resolved ? "Resolved" : "Open"} · {note.replies.length} {note.replies.length === 1 ? "reply" : "replies"}</small></button>)}</div></aside>}
  </>;
}
