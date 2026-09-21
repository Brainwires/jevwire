/**
 * Two dependency-free helpers that both the MCP tools and the hook side use.
 *
 * They live here, apart from `src/tools/shared.ts`, because `shared.ts` also
 * holds the zod schemas: anything that imports it drags zod into the bundle it
 * lands in, and `verify-core.ts` (reused by the Stop hook) must stay out of the
 * dependency-free `hook.mjs`. So the zod-free utilities are their own module.
 */

/**
 * Map over items with at most `limit` promises in flight. Results keep input
 * order. The first rejection wins; in-flight work is left to settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** Sum token usage across several requests. */
export function sumUsage(parts: readonly { input_tokens: number; output_tokens: number }[]): {
  input_tokens: number;
  output_tokens: number;
} {
  return parts.reduce(
    (acc, part) => ({
      input_tokens: acc.input_tokens + part.input_tokens,
      output_tokens: acc.output_tokens + part.output_tokens,
    }),
    { input_tokens: 0, output_tokens: 0 },
  );
}
