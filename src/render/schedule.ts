export function createFrameScheduler(
  render: () => void,
  intervalMs: number,
): { request(): void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRender: number | null = null;

  const request = (): void => {
    if (timer !== null) return;
    const since = lastRender === null ? Number.POSITIVE_INFINITY : Date.now() - lastRender;
    const delay = Math.max(0, intervalMs - since);
    timer = setTimeout(() => {
      timer = null;
      lastRender = Date.now();
      render();
    }, delay);
  };

  const dispose = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { request, dispose };
}
