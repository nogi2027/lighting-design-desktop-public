// Multiple dialogs can hold the same background while one editor unmounts.
// Restore its original state only after the final holder has released it.
const held = new WeakMap<HTMLElement, { count:number; original:boolean }>();
export function holdInert(elements: HTMLElement[]) {
  for (const element of elements) {
    const state = held.get(element) ?? {count:0,original:element.inert};
    state.count++;held.set(element,state);element.inert=true;
  }
  let released=false;
  return () => {
    if (released) return;
    released=true;
    for (const element of elements) {
      const state=held.get(element);
      if (!state || --state.count>0) continue;
      element.inert=state.original;held.delete(element);
    }
  };
}
