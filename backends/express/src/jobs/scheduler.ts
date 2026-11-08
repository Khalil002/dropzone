/** Runs fn every intervalMs without overlapping runs; errors are logged, not fatal. */
export function every(name: string, intervalMs: number, fn: () => Promise<unknown>): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const loop = async () => {
    try { await fn(); } catch (err) { console.error(`[${name}]`, (err as Error).message); }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };
  timer = setTimeout(loop, intervalMs);
  return () => { stopped = true; clearTimeout(timer); };
}
