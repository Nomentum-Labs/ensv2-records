/** Minimal counting semaphore. */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}

export const withTimeout = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
};
