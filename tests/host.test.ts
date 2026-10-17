import { expect, test } from 'vitest';

import { ENTER_HOST, LEAVE_HOST } from '../src/host.js';

test('ENTER_HOST turns alternate scroll off', () => {
  expect(ENTER_HOST).toContain('\x1b[?1007l');
});

test('ENTER_HOST enters the alt screen and enables the host modes', () => {
  expect(ENTER_HOST).toContain('\x1b[?1049h');
  expect(ENTER_HOST).toContain('\x1b[?1006h');
  expect(ENTER_HOST).toContain('\x1b[?2004h');
  expect(ENTER_HOST).toContain('\x1b[?1004h');
});

test('LEAVE_HOST leaves the alt screen', () => {
  expect(LEAVE_HOST).toContain('\x1b[?1049l');
});
