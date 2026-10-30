import type { SVGProps } from "react";

export const noteIconMarkup = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 3h14v12l-6 6H5z"/><path d="M13 21v-6h6M8 7h8M8 11h6"/></svg>';

export function NoteIcon(props: SVGProps<SVGSVGElement>) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}><path d="M5 3h14v12l-6 6H5z" /><path d="M13 21v-6h6M8 7h8M8 11h6" /></svg>;
}

export function CueIcon(props: SVGProps<SVGSVGElement>) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M18.6 12a7.1 7.1 0 1 1-2.4-5.3A7.1 7.1 0 0 1 18.6 12Z" /><path d="M13.5 15.4c1.5 0 2.1 4.6 6.1 4.6" /></svg>;
}

export function MoreIcon() {
  return <svg aria-hidden="true" viewBox="0 0 18 18" fill="currentColor"><circle cx="4" cy="9" r="1.2" /><circle cx="9" cy="9" r="1.2" /><circle cx="14" cy="9" r="1.2" /></svg>;
}

export function ArrowIcon({ direction, ...props }: SVGProps<SVGSVGElement> & { direction: "left" | "right" | "down" }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}><path d={direction === "down" ? "M12 4v16m-6-6 6 6 6-6" : direction === "left" ? "M21 12H3m6-6-6 6 6 6" : "M3 12h18m-6-6 6 6-6 6"} /></svg>;
}

export function CloseIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m7 7 10 10M17 7 7 17" /></svg>;
}

export function ReplyIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m8 5-5 5 5 5M3 10h11a6 6 0 0 1 6 6v3" /></svg>;
}

export function CheckIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>;
}
