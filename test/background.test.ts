import test from 'node:test';
import assert from 'node:assert/strict';
import { runInBackground, setBackgroundContext } from '../src/background.ts';

// NOTE: the no-context test must run first — module state is shared and there
// is no unset API (in production the context is set once at apply() and never
// changes).
const settle = () => new Promise((r) => setTimeout(r, 10));

test('runInBackground: without a context it is a safe no-op', async () => {
    let called = false;
    runInBackground(() => { called = true; });
    await settle();
    assert.equal(called, false);
});

test('runInBackground: fn runs on a later macrotask with the plugin ctx', async () => {
    const ctx: any = { logger: { error: () => { } } };
    setBackgroundContext(ctx);
    let ranWith: unknown = null;
    let syncDone = false;
    runInBackground((c) => { ranWith = c; syncDone = true; });
    assert.equal(syncDone, false); // not synchronous
    await settle();
    assert.equal(syncDone, true);
    assert.equal(ranWith, ctx); // receives the long-lived context
});

test('runInBackground: sync throw is logged, never propagated', async () => {
    const errors: unknown[] = [];
    setBackgroundContext({ logger: { error: (e: unknown) => errors.push(e) } } as any);
    runInBackground(() => { throw new Error('boom'); });
    await settle();
    assert.equal(errors.length, 1);
});

test('runInBackground: async rejection is logged, never propagated', async () => {
    const errors: unknown[] = [];
    setBackgroundContext({ logger: { error: (e: unknown) => errors.push(e) } } as any);
    runInBackground(async () => Promise.reject(new Error('async boom')));
    await settle();
    assert.equal(errors.length, 1);
});
