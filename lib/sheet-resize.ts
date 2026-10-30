type PointerPoint = Event & { clientY: number };

export type SheetResizeOptions = {
  startY: number;
  startHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  onHeight: (height: number) => void;
  onTravel: (distance: number) => void;
};

export function startSheetResize(target: EventTarget, options: SheetResizeOptions): () => void {
  const { startY, startHeight, viewportWidth, viewportHeight, onHeight, onTravel } = options;
  const topAllowance = viewportWidth <= 1024 ? 110 : 70;
  const maxHeight = Math.max(240, viewportHeight - topAllowance);
  const collapsedHeight = Math.min(viewportWidth <= 1024 ? 360 : 330, viewportHeight * (viewportWidth <= 1024 ? .42 : .34));
  let currentHeight = startHeight;
  let stopped = false;

  const move = (event: Event) => {
    const { clientY } = event as PointerPoint;
    onTravel(Math.abs(startY - clientY));
    currentHeight = Math.max(240, Math.min(maxHeight, startHeight + startY - clientY));
    onHeight(currentHeight);
  };
  const finish = (event: Event) => {
    const travel = startY - (event as PointerPoint).clientY;
    const targetHeight = travel > 24 ? maxHeight : travel < -24 ? collapsedHeight : currentHeight > (collapsedHeight + maxHeight) / 2 ? maxHeight : collapsedHeight;
    onHeight(targetHeight);
    cleanup();
  };
  const cancel = () => {
    onTravel(Number.POSITIVE_INFINITY);
    onHeight(Math.max(240, Math.min(maxHeight, startHeight)));
    cleanup();
  };
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", finish);
    target.removeEventListener("pointercancel", cancel);
  };

  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", finish);
  target.addEventListener("pointercancel", cancel);
  return cleanup;
}
