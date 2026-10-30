import type { Scene } from "./types";

export type SceneGroup = {
  id: string;
  scenes: Scene[];
  number: string;
  name: string;
  pageStart: number;
  startY: number;
  pageEnd: number;
};

export function sceneStartPosition(scene: Pick<Scene, "pageStart" | "startY">) {
  return scene.pageStart - 1 + Math.max(0, Math.min(1, scene.startY ?? 0));
}

export function sceneAtPosition(scenes: Scene[], page: number, anchorY = 0) {
  const position = page - 1 + Math.max(0, Math.min(1, anchorY));
  return [...scenes]
    .sort((a, b) => sceneStartPosition(a) - sceneStartPosition(b))
    .findLast((scene) => sceneStartPosition(scene) <= position);
}

/** Sort once for callers resolving many cue positions in the same snapshot. */
export function createSceneLocator(scenes: Scene[]) {
  const ordered = [...scenes].sort((a, b) => sceneStartPosition(a) - sceneStartPosition(b));
  const starts = ordered.map(sceneStartPosition);
  return (page: number, anchorY = 0) => {
    const position = page - 1 + Math.max(0, Math.min(1, anchorY));
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= position) low = middle + 1;
      else high = middle;
    }
    return ordered[low - 1];
  };
}

export function buildSceneGroups(scenes: Scene[], totalPages: number, minimumPages = 5): SceneGroup[] {
  const ordered = [...scenes].sort((a, b) => sceneStartPosition(a) - sceneStartPosition(b));
  const grouped: Scene[][] = [];
  let current: Scene[] = [];

  ordered.forEach((scene, index) => {
    current.push(scene);
    const next = ordered[index + 1];
    const currentStart = current[0].pageStart;
    const nextStart = next ? next.pageStart : totalPages + 1;
    if (nextStart - currentStart >= minimumPages) {
      grouped.push(current);
      current = [];
    }
  });

  if (current.length > 0) {
    if (grouped.length > 0) grouped[grouped.length - 1].push(...current);
    else grouped.push(current);
  }

  return grouped.map((items, index) => {
    const first = items[0];
    const last = items.at(-1)!;
    const nextFirst = grouped[index + 1]?.[0];
    return {
      id: `scene-group-${first.id}-${last.id}`,
      scenes: items,
      number: first.id === last.id ? first.number : `${first.number}–${last.number}`,
      name: first.id === last.id ? first.name : `${first.name} + ${items.length - 1} more`,
      pageStart: first.pageStart,
      startY: first.startY,
      pageEnd: nextFirst?.pageStart ?? totalPages,
    };
  });
}
