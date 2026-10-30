/** Share a costly resource across short-lived views, then free it when idle. */
export function retainedResource<T>(load: () => Promise<T>, dispose: (value: T) => void, idleMs: number) {
  let current: { promise: Promise<T>; users: number; timer?: ReturnType<typeof setTimeout> } | undefined;
  return () => {
    if (!current) {
      const entry = { promise: Promise.resolve().then(load), users: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      current = entry;
      void entry.promise.catch(() => { if (current === entry) current = undefined; });
    }
    const entry = current;
    clearTimeout(entry.timer);
    entry.users++;
    let released = false;
    return {
      promise: entry.promise,
      release() {
        if (released) return;
        released = true;
        if (--entry.users) return;
        entry.timer = setTimeout(() => {
          if (current === entry) current = undefined;
          void entry.promise.then(dispose, () => {});
        }, idleMs);
      },
    };
  };
}
