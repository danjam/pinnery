import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { failureCounter } from '../../src/auth/core.ts';

const WINDOW = 15 * 60 * 1000;

describe('failure counter', () => {
  beforeEach(() => mock.timers.enable({ apis: ['Date'], now: 0 }));
  afterEach(() => mock.timers.reset());

  it('drops keys whose window has passed, once a window', () => {
    const c = failureCounter(10, WINDOW);
    for (let i = 0; i < 50; i++) c.record(`10.0.0.${i}`);
    assert.equal(c.size, 50);
    mock.timers.tick(WINDOW);
    c.record('10.0.1.1');
    assert.equal(c.size, 1);
  });

  it('keeps keys with events inside the window', () => {
    const c = failureCounter(3, WINDOW);
    c.record('old');
    mock.timers.tick(WINDOW / 2);
    c.record('recent');
    c.record('recent');
    mock.timers.tick(WINDOW / 2);
    c.record('recent');
    assert.equal(c.size, 1);
    assert.equal(c.throttled('recent'), true);
    assert.equal(c.throttled('old'), false);
  });

  it('forgive takes back one event and drops an emptied key', () => {
    const c = failureCounter(2, WINDOW);
    c.record('k');
    c.record('k');
    assert.equal(c.throttled('k'), true);
    c.forgive('k');
    assert.equal(c.throttled('k'), false);
    c.forgive('k');
    assert.equal(c.size, 0);
    c.forgive('k');
    assert.equal(c.size, 0);
  });

  it('sweeps from throttled() too', () => {
    const c = failureCounter(10, WINDOW);
    for (let i = 0; i < 5; i++) c.record(`k${i}`);
    mock.timers.tick(WINDOW);
    c.throttled('other');
    assert.equal(c.size, 0);
  });
});
