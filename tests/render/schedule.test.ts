import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createFrameScheduler, createRunningTicker } from '../../src/render/schedule.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('coalesces a burst of requests into one render', () => {
  const render = vi.fn();
  const scheduler = createFrameScheduler(render, 16);

  for (let i = 0; i < 1000; i += 1) scheduler.request();
  expect(render).not.toHaveBeenCalled();

  vi.advanceTimersByTime(16);
  expect(render).toHaveBeenCalledTimes(1);

  scheduler.dispose();
});

test('a request just after a render waits out the interval', () => {
  const render = vi.fn();
  const scheduler = createFrameScheduler(render, 16);

  scheduler.request();
  vi.advanceTimersByTime(1);
  expect(render).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(4);
  scheduler.request();
  expect(render).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(10);
  expect(render).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(1);
  expect(render).toHaveBeenCalledTimes(2);

  scheduler.dispose();
});

test('dispose clears a pending render', () => {
  const render = vi.fn();
  const scheduler = createFrameScheduler(render, 16);

  scheduler.request();
  scheduler.dispose();
  vi.advanceTimersByTime(100);

  expect(render).not.toHaveBeenCalled();
});

test('running ticker: one interval per second while running, cleared when stopped and disposed', () => {
  const render = vi.fn();
  const ticker = createRunningTicker(render, 1000);

  ticker.sync(true);
  ticker.sync(true);
  vi.advanceTimersByTime(999);
  expect(render).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  expect(render).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(1000);
  expect(render).toHaveBeenCalledTimes(2);

  ticker.sync(false);
  vi.advanceTimersByTime(3000);
  expect(render).toHaveBeenCalledTimes(2);

  ticker.sync(true);
  vi.advanceTimersByTime(1000);
  expect(render).toHaveBeenCalledTimes(3);

  ticker.dispose();
  vi.advanceTimersByTime(3000);
  expect(render).toHaveBeenCalledTimes(3);
});
