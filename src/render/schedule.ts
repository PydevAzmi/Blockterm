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

export function createRunningTicker(
  request: () => void,
  intervalMs = 1000,
): { sync(running: boolean): void; dispose(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;

  const sync = (running: boolean): void => {
    if (running && timer === null) timer = setInterval(request, intervalMs);
    else if (!running && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const dispose = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { sync, dispose };
}
