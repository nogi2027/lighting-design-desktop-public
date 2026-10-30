"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { replyParticipationLabel } from "../lib/discussion-ui";
import { FIELD_LIMITS } from "../lib/field-limits";
import type { Discussion, Profile } from "../lib/types";
import { CheckIcon, ReplyIcon } from "./script-icons";
import { useRailHover } from "./use-rail-hover";
import { useHoverInput, isHoverPointer } from "./use-hover-input";

export type DiscussionCardProps = {
  discussion: Discussion;
  profiles: Profile[];
  surface: "rail" | "panel";
  focused?: boolean;
  contextPinned?: boolean;
  busy?: boolean;
  onOpen: (id: string) => void;
  onDismiss?: () => void;
  onStartReply: (id: string) => void;
  onCancelReply: () => void;
  onPostReply: (id: string) => void;
  onToggleResolved: (discussion: Discussion) => void;
  replyingToId: string | null;
  replyText: string;
  setReplyText: (value: string) => void;
};

const noteDateFormatter = new Intl.DateTimeFormat(undefined, { month:"short", day:"numeric" });

function AuthorAvatar({ profile }: { profile?: Profile }) {
  return <span className="discussion-avatar" role="img" title={profile?.name ?? "Unknown author"} aria-label={profile?.name ?? "Unknown author"} style={{ "--discussion-profile": profile?.color ?? "var(--amber)" } as CSSProperties}>{profile?.initials || "?"}</span>;
}

export const DiscussionCard = memo(function DiscussionCard({ discussion, profiles, surface, focused = false, contextPinned = false, busy = false, onOpen, onDismiss, onStartReply, onCancelReply, onPostReply, onToggleResolved, replyingToId, replyText, setReplyText }: DiscussionCardProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [hoverSuppressed, setHoverSuppressed] = useState(false);
  const hoverCapable = useHoverInput();
  const [railHeight, setRailHeight] = useState(54);
  const [compactContent, setCompactContent] = useState(false);
  const replying = replyingToId === discussion.id;
  const hasReplies = discussion.replies.length > 0;
  // Classify by the measured layout at this rail width, rather than text length.
  // Short notes use a 38px action column; taller text and threads keep the
  // roomier column and the delayed close.
  const compact = surface === "rail" && !hasReplies && !replying && compactContent;
  const updateHover = useCallback((id: string | null) => setHovered(id !== null), []);
  const { enter: enterHover, leave: leaveHover, clear: clearHover } = useRailHover(updateHover, compact ? "compact-note" : "note");
  const [revealedReplyId, setRevealedReplyId] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const motionFrameRef = useRef<number | null>(null);
  const editingReply = replying && replyText.length > 0;
  const expanded = surface === "panel" || editingReply || (!hoverSuppressed && (localExpanded || focused || contextPinned || focusWithin || (hoverCapable && hovered)));
  const author = profiles.find((profile) => profile.id === discussion.authorId);
  const authorName = author?.name ?? "Unknown";
  const detailsId = `discussion-details-${surface}-${discussion.id}`;
  const replyLabel = replyParticipationLabel(discussion, profiles);
  const dateLabel = useMemo(() => noteDateFormatter.format(new Date(discussion.createdAt)), [discussion.createdAt]);
  const previousExpanded = useRef(expanded);
  const returningFocusAfterClose = useRef(false);

  const settleMotion = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    delete card.dataset.motion;
    card.dispatchEvent(new Event("rail-layout-settled", { bubbles:true }));
  }, []);

  const checkMotion = useCallback(() => {
    if (motionFrameRef.current !== null) window.cancelAnimationFrame(motionFrameRef.current);
    motionFrameRef.current = window.requestAnimationFrame(() => {
      motionFrameRef.current = null;
      if (slotRef.current?.dataset.motion !== "changing" && !viewportRef.current?.getAnimations().some(animation => ["running", "paused"].includes(animation.playState))) settleMotion();
    });
  }, [settleMotion]);

  useLayoutEffect(() => {
    if (surface !== "rail" || !bodyRef.current) return;
    const body = bodyRef.current;
    const main = body.querySelector<HTMLElement>(".discussion-card-main");
    const measure = () => {
      const height = body.getBoundingClientRect().height;
      setRailHeight(current => Math.abs(current - height) < .25 ? current : height);
      setCompactContent(Boolean(main && main.getBoundingClientRect().height <= 38.25));
    };
    // Initial observer deliveries share one layout after every card mounts.
    // Synchronous measurement here flushed the full script once per note.
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    if (main) observer.observe(main);
    return () => observer.disconnect();
  }, [surface]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (surface !== "rail" || !slot) return;
    const transition = (event: TransitionEvent) => {
      if (event.target !== slot || event.propertyName !== "height") return;
      if (event.type === "transitionrun" && cardRef.current) cardRef.current.dataset.motion = "changing";
      else if (event.type === "transitionend") settleMotion();
      else if (event.type === "transitioncancel") checkMotion();
    };
    const settled = (event: Event) => { if (event.target === slot) settleMotion(); };
    slot.addEventListener("rail-layout-settled",settled);
    for (const name of ["transitionrun", "transitionend", "transitioncancel"]) slot.addEventListener(name, transition as EventListener);
    return () => {
      slot.removeEventListener("rail-layout-settled",settled);
      for (const name of ["transitionrun", "transitionend", "transitioncancel"]) slot.removeEventListener(name, transition as EventListener);
    };
  }, [checkMotion, settleMotion, surface]);

  useLayoutEffect(() => {
    if (surface !== "rail" || previousExpanded.current === expanded) return;
    previousExpanded.current = expanded;
    if (cardRef.current) cardRef.current.dataset.motion = "changing";
    slotRef.current?.dispatchEvent(new Event("rail-hover-motion-change", { bubbles:true }));
    checkMotion();
  }, [checkMotion, expanded, surface]);

  useEffect(() => () => {
    if (motionFrameRef.current !== null) window.cancelAnimationFrame(motionFrameRef.current);
  }, []);

  const closeCard = useCallback(() => {
    if (editingReply) return;
    clearHover();
    if (replying) onCancelReply();
    setLocalExpanded(false);
    setFocusWithin(false);
    setRevealedReplyId(null);
    setHoverSuppressed(true);
    onDismiss?.();
  }, [clearHover, editingReply, onCancelReply, onDismiss, replying]);

  const toggleExpanded = () => {
    if (localExpanded || focused) closeCard();
    else {
      setHoverSuppressed(false);
      setLocalExpanded(true);
      onOpen(discussion.id);
    }
  };

  const beginReply = () => {
    setHoverSuppressed(false);
    setLocalExpanded(true);
    onOpen(discussion.id);
    onStartReply(discussion.id);
  };


  useEffect(() => {
    if (!replying) return;
    const frame = window.requestAnimationFrame(() => {
      replyRef.current?.focus({ preventScroll: true });
      replyRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [replying]);

  useEffect(() => {
    if (surface !== "rail" || !expanded) return;
    const pointerDown = (event: PointerEvent) => {
      if (cardRef.current?.contains(event.target as Node)) return;
      closeCard();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || editingReply) return;
      event.preventDefault();
      closeCard();
      returningFocusAfterClose.current = true;
      try { expandRef.current?.focus({ preventScroll: true }); }
      finally { returningFocusAfterClose.current = false; }
    };
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
    };
  }, [closeCard, editingReply, expanded, surface]);

  const actions = !replying && <footer className="discussion-actions" inert={surface === "rail" && !expanded} aria-hidden={surface === "rail" && !expanded}><button type="button" className="discussion-reply-button" disabled={busy} aria-label="Reply" title="Reply" onClick={beginReply}><ReplyIcon /></button><button type="button" className="discussion-resolve-button" disabled={busy} aria-pressed={discussion.resolved} aria-label={`${discussion.resolved ? "Reopen" : "Resolve"} note by ${authorName}`} title={discussion.resolved ? "Reopen note" : "Resolve note"} onClick={() => onToggleResolved(discussion)}><CheckIcon /></button></footer>;

  const card = <article ref={cardRef} data-discussion-id={discussion.id} className={`discussion-card ${surface} ${discussion.resolved ? "resolved" : ""} ${hasReplies ? "has-replies" : ""} ${expanded ? "expanded" : "collapsed"} ${contextPinned ? "context-pinned" : ""}`} onPointerEnter={event => { if (surface === "rail" && isHoverPointer(event)) enterHover(discussion.id); setHoverSuppressed(false); }} onPointerMove={event=>{if(surface==="rail" && !hovered && isHoverPointer(event))enterHover(discussion.id);}} onPointerLeave={() => { leaveHover(discussion.id); setFocusWithin(false); setHoverSuppressed(false); }} onClickCapture={(event) => { if ((event.target as Element).closest(".discussion-expand-trigger")) return; setLocalExpanded(true); setHoverSuppressed(false); }} onFocusCapture={() => { setFocusWithin(true); if (!returningFocusAfterClose.current) setHoverSuppressed(false); }} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setFocusWithin(false); setHoverSuppressed(false); } }}>
    {hasReplies && <span className="discussion-stack" aria-hidden="true"><i /><i /></span>}
    <div ref={viewportRef} className="discussion-card-viewport" style={surface === "rail" ? { "--discussion-height": `${railHeight}px` } as CSSProperties : undefined}><div ref={bodyRef} className="discussion-card-body">
    <div className="discussion-card-main">
      {surface === "rail" && <button ref={expandRef} type="button" className="discussion-expand-trigger" aria-expanded={expanded} aria-controls={detailsId} aria-label={`${expanded ? "Hide" : "Show"} note by ${authorName}: ${discussion.content}. ${replyLabel}`} onClick={toggleExpanded} />}
      <div className="discussion-profile"><AuthorAvatar profile={author} /><time suppressHydrationWarning dateTime={discussion.createdAt} title={discussion.createdAt}>{dateLabel}</time></div><span className="discussion-colon" aria-hidden="true">:</span>
      <span className="discussion-content" data-preview={surface === "rail" ? discussion.content : undefined}>{discussion.content}</span>
    </div>
    <section id={detailsId} className="discussion-details" inert={!expanded} aria-hidden={!expanded}><div className="discussion-details-inner">
      <div className="discussion-conversation">
      {hasReplies && <section className="discussion-replies" aria-label={`${discussion.replies.length} ${discussion.replies.length === 1 ? "reply" : "replies"}`}><div className="discussion-replies-inner">
        {discussion.replies.map((reply) => {
          const replyAuthor = profiles.find((profile) => profile.id === reply.authorId);
          return <div className="discussion-reply" key={reply.id}><button type="button" className={`discussion-reply-preview ${revealedReplyId === reply.id ? "revealed" : ""}`} aria-expanded={revealedReplyId === reply.id} aria-label={`${revealedReplyId === reply.id ? "Shorten" : "Read"} reply by ${replyAuthor?.name ?? reply.authorId}: ${reply.content}`} onClick={() => setRevealedReplyId((current) => current === reply.id ? null : reply.id)}><AuthorAvatar profile={replyAuthor} /><span className="discussion-colon" aria-hidden="true">:</span><span className="discussion-reply-copy">{reply.content}</span></button></div>;
        })}
      </div></section>}
      </div>
      {replying && <div className="discussion-reply-composer">
        <textarea ref={replyRef} aria-label="Reply to note" maxLength={FIELD_LIMITS.reply} value={replyText} onChange={(event) => setReplyText(event.target.value)} placeholder="Write a reply…" onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); if (!busy && replyText.trim() && replyText.length <= FIELD_LIMITS.reply) { onPostReply(discussion.id); setLocalExpanded(true); } }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancelReply(); }
        }} />
        <small className={`composer-limit ${replyText.length > FIELD_LIMITS.reply ? "over" : ""}`}>{replyText.length > FIELD_LIMITS.reply ? `Shorten by ${(replyText.length - FIELD_LIMITS.reply).toLocaleString()} characters` : `${replyText.length.toLocaleString()} / ${FIELD_LIMITS.reply.toLocaleString()}`}</small>
        <div><button type="button" onClick={onCancelReply}>Cancel</button><button type="button" className="submit-reply" disabled={busy || !replyText.trim() || replyText.length > FIELD_LIMITS.reply} onClick={() => { onPostReply(discussion.id); setLocalExpanded(true); }}>Post reply</button></div>
      </div>}
    </div></section>
    {actions}
    </div></div>
  </article>;
  return surface === "rail" ? <div ref={slotRef} data-compact={compact || undefined} className={`rail-note-slot ${expanded ? "expanded" : "collapsed"} ${hasReplies ? "has-replies" : ""}`} style={{ "--discussion-height": `${railHeight}px` } as CSSProperties}>{card}</div> : card;
});
