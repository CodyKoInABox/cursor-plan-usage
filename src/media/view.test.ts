import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

// Bundle view.js the same way esbuild.js ships it, then run it in a fresh
// jsdom window per test so message listeners from one render stay out of the next.
const VIEW_JS = buildSync({
  entryPoints: [join(__dirname, 'view.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  write: false,
}).outputFiles![0].text;
const DAY_MS = 24 * 60 * 60 * 1000;

const windows: JSDOM[] = [];

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

function mount() {
  const dom = new JSDOM('<!DOCTYPE html><div id="app"></div>', {
    runScripts: 'outside-only',
  });
  windows.push(dom);
  const posted: unknown[] = [];
  const w = dom.window as unknown as Record<string, unknown>;
  w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
  dom.window.eval(VIEW_JS);
  return {
    dom,
    posted,
    send(data: unknown) {
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', { data })
      );
    },
    app() {
      return dom.window.document.getElementById('app')!;
    },
  };
}

function usage(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    planName: 'Pro',
    autoPercentUsed: 28.5,
    apiPercentUsed: 40,
    billingCycleStart: new Date(now - 15 * DAY_MS).toISOString(),
    billingCycleEnd: new Date(now + 15 * DAY_MS).toISOString(),
    refreshedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

/** 14 consecutive days ending Nov 1 2026. Index 5 is a gap (no cm/om). */
function history() {
  const end = Date.UTC(2026, 10, 1);
  return Array.from({ length: 14 }, (_, i) => {
    const day = new Date(end - (13 - i) * DAY_MS).toISOString().slice(0, 10);
    if (i === 5) return { day };
    return { day, cm: i + 1, om: (i + 1) / 2 };
  });
}

describe('view.js rendering', () => {
  it('posts ready on load and shows loading state', () => {
    const view = mount();
    expect(view.posted[0]).toEqual({ type: 'ready' });

    view.send({ type: 'loading' });
    expect(view.app().querySelector('.state-loading')?.textContent).toContain(
      'Loading plan usage'
    );
  });

  it('renders meters and the plan title', () => {
    const view = mount();
    view.send({ type: 'usageData', data: usage() });

    const h1 = view.app().querySelector('h1');
    expect(h1?.textContent).toBe('Pro Plan usage');
    expect(view.app().textContent).toContain('28.5% used');
    expect(view.app().textContent).toContain('40% used');
  });

  it('shows the cycle-end projection once 1% of the cycle has passed', () => {
    const view = mount();
    // used 30% at 50% of the cycle -> 60% at cycle end
    view.send({
      type: 'usageData',
      data: usage({ autoPercentUsed: 30 }),
    });

    expect(view.app().textContent).toContain('~60% by cycle end');
  });

  it('hides the cycle-end projection very early in the cycle', () => {
    const view = mount();
    const now = Date.now();
    view.send({
      type: 'usageData',
      data: usage({
        billingCycleStart: new Date(now - 60 * 60 * 1000).toISOString(),
        billingCycleEnd: new Date(now + 1000 * 60 * 60 * 1000).toISOString(),
      }),
    });

    expect(view.app().textContent).not.toContain('by cycle end');
  });

  it('shows the reset countdown next to the cycle end', () => {
    const view = mount();
    // 3d 4h 30m out; 30m of slack keeps the floored value at 3d 4h.
    const end = Date.now() + (3 * 24 + 4) * 60 * 60 * 1000 + 30 * 60 * 1000;
    view.send({
      type: 'usageData',
      data: usage({ billingCycleEnd: new Date(end).toISOString() }),
    });

    expect(view.app().querySelector('#reset-countdown')?.textContent).toBe(
      '· resets in 3d 4h'
    );
  });

  it('escapes plan name HTML', () => {
    const view = mount();
    view.send({
      type: 'usageData',
      data: usage({ planName: '<img src=x onerror=alert(1)>' }),
    });

    expect(view.app().querySelector('img')).toBeNull();
    expect(view.app().querySelector('h1')?.textContent).toContain('<img src=x');
  });

  it('renders the history chart collapsed, with gaps marked', () => {
    const view = mount();
    view.send({ type: 'usageData', data: usage({ history: history() }) });

    const details = view.app().querySelector('details#history');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toBe(
      'History (last 14 days)'
    );
    expect(details?.querySelectorAll('.history-bar-cm').length).toBe(13);
    expect(details?.querySelectorAll('.history-bar-om').length).toBe(13);
    expect(details?.querySelectorAll('.history-gap').length).toBe(1);
  });

  it('shows a hint instead of a chart when no day has data', () => {
    const view = mount();
    const days = history().map((d) => ({ day: d.day }));
    view.send({ type: 'usageData', data: usage({ history: days }) });

    const details = view.app().querySelector('details#history');
    expect(details?.textContent).toContain('History fills in as days pass');
    expect(details?.querySelector('svg')).toBeNull();
  });

  it('omits the history block when there is no history array', () => {
    const view = mount();
    view.send({ type: 'usageData', data: usage() });

    expect(view.app().querySelector('details#history')).toBeNull();
  });

  it('keeps the history open state across re-renders', () => {
    const view = mount();
    view.send({ type: 'usageData', data: usage({ history: history() }) });

    const first = view.app().querySelector('details#history')! as Element & { open: boolean };
    first.open = true;
    first.dispatchEvent(new view.dom.window.Event('toggle'));

    view.send({ type: 'usageData', data: usage({ history: history() }) });

    const second = view.app().querySelector('details#history');
    expect(second?.hasAttribute('open')).toBe(true);
  });

  it('shows the error hint and a Refresh button that posts a refresh', () => {
    const view = mount();
    view.send({
      type: 'error',
      error: {
        kind: 'no_token',
        title: 'No token found',
        message: 'Sign in to Cursor',
        hint: 'Run Plan Usage: Set Session Token',
      },
    });

    const err = view.app().querySelector('.state-error')!;
    expect(err.getAttribute('data-kind')).toBe('no_token');
    expect(
      view.app().querySelector('.state-error-hint')?.textContent
    ).toContain('Set Session Token');

    const btn = view.app().querySelector('#btn-refresh')! as Element & {
      click(): void;
      disabled: boolean;
    };
    btn.click();
    expect(btn.disabled).toBe(true);
    expect(view.posted).toContainEqual({ type: 'refresh' });
  });
});
