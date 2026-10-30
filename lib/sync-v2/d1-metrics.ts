export type D1WorkMetrics = {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
  d1DurationMs: number;
};

type MetaResult = { meta?: { rows_read?: number; rows_written?: number; duration?: number }; results?: unknown[] };

function addResult(metrics: D1WorkMetrics, value: unknown) {
  const result = value as MetaResult;
  metrics.statements += 1;
  metrics.rowsRead += Number(result.meta?.rows_read ?? 0);
  metrics.rowsWritten += Number(result.meta?.rows_written ?? 0);
  metrics.d1DurationMs += Number(result.meta?.duration ?? 0);
}

/** Test-only wrapper that preserves D1 behavior while collecting the metadata
 * returned by every statement, including calls normally made through first(). */
export function measuredD1(database: D1Database, metrics: D1WorkMetrics): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const source = statement as unknown as {
      bind(...values: unknown[]): D1PreparedStatement;
      all(): Promise<D1Result<unknown>>;
      run(): Promise<D1Result<unknown>>;
      raw(options?: unknown): Promise<unknown[][]>;
    };
    const wrapper = {
      bind: (...values: unknown[]) => wrap(source.bind(...values)),
      all: async () => { const result = await source.all(); addResult(metrics, result); return result; },
      run: async () => { const result = await source.run(); addResult(metrics, result); return result; },
      first: async (column?: string) => {
        const result = await source.all();
        addResult(metrics, result);
        const row = (result.results?.[0] ?? null) as Record<string, unknown> | null;
        return column === undefined ? row : row?.[column] ?? null;
      },
      raw: (options?: unknown) => source.raw(options),
    } as unknown as D1PreparedStatement;
    originals.set(wrapper as object, statement);
    return wrapper;
  };
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (query: string) => wrap(target.prepare(query));
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await target.batch(statements.map((statement) => originals.get(statement as object) ?? statement));
        for (const item of result) addResult(metrics, item);
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}
