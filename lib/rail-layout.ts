export type RailLayoutItem = {
  id: string;
  kind: "cue" | "scene";
  desiredTop: number;
  height: number;
  order?: number;
  /** Script position can differ from a raised marker's display position. */
  sortPosition?: number;
};

export type PositionedRailItem = RailLayoutItem & { top: number };

type RailLayoutBlock = { items: RailLayoutItem[]; top: number };

function itemOffsets(items: RailLayoutItem[], gap: number) {
  let offset = 0;
  return items.map((item) => {
    const current = offset;
    offset += item.height + gap;
    return current;
  });
}

function positionBlock(items: RailLayoutItem[], startTop: number, gap: number): RailLayoutBlock {
  const offsets = itemOffsets(items, gap);
  const scenePositions = items.flatMap((item, index) => item.kind === "scene" ? [item.desiredTop - offsets[index]] : []);
  const preferredPositions = scenePositions.length > 0
    ? scenePositions
    : items.map((item, index) => item.desiredTop - offsets[index]);
  const preferredTop = preferredPositions.reduce((total, position) => total + position, 0) / preferredPositions.length;
  return { items, top: Math.max(startTop, preferredTop) };
}

function blockBottom(block: RailLayoutBlock, gap: number) {
  return block.top + block.items.reduce((height, item) => height + item.height, 0) + gap * Math.max(0, block.items.length - 1);
}

export function layoutRailItems(items: RailLayoutItem[], startTop: number, gap = 5): PositionedRailItem[] {
  const sorted = [...items].sort((left, right) => {
    const positionDifference = (left.sortPosition ?? left.desiredTop) - (right.sortPosition ?? right.desiredTop);
    if (positionDifference) return positionDifference;
    if (left.kind !== right.kind) return left.kind === "scene" ? -1 : 1;
    const orderDifference = (left.order ?? 0) - (right.order ?? 0);
    if (orderDifference) return orderDifference;
    return left.id.localeCompare(right.id);
  });
  const blocks: RailLayoutBlock[] = [];
  sorted.forEach((item) => {
    blocks.push(positionBlock([item], startTop, gap));
    while (blocks.length > 1) {
      const current = blocks.at(-1)!;
      const previous = blocks.at(-2)!;
      if (current.top >= blockBottom(previous, gap) + gap) break;
      blocks.splice(-2, 2, positionBlock([...previous.items, ...current.items], startTop, gap));
    }
  });
  return blocks.flatMap((block) => {
    const offsets = itemOffsets(block.items, gap);
    return block.items.map((item, index) => ({ ...item, top: block.top + offsets[index] }));
  });
}

export function makeRoomBelowPinnedItem(
  layout: PositionedRailItem[],
  pinnedId: string | null,
  pinnedHeight: number,
  overlap: number,
  gap = 5,
): PositionedRailItem[] {
  if (!pinnedId) return layout;
  const pinnedIndex = layout.findIndex((item) => item.id === pinnedId);
  if (pinnedIndex < 0) return layout;

  const positioned = layout.map((item) => ({ ...item }));
  positioned[pinnedIndex].height = pinnedHeight;
  let nextTop = positioned[pinnedIndex].top + pinnedHeight - overlap;

  for (let index = pinnedIndex + 1; index < positioned.length; index += 1) {
    positioned[index].top = Math.max(positioned[index].top, nextTop);
    nextTop = positioned[index].top + positioned[index].height + gap;
  }
  return positioned;
}
