/**
 * Background work scheduler immune to cordis request-scope disposal.
 *
 * The HTTP framework forks a fresh cordis plugin scope for EVERY request
 * (`await using sub = forkContextWithScope(...)` in @hydrooj/framework) and
 * disposes it when the response completes. hydrooj routes ctx.setImmediate
 * through ctx.effect(), and disposal CLEARS every pending immediate of that
 * context (context.ts: `T(setImmediate, clearImmediate)`). A callback
 * scheduled on a handler's ctx therefore dies before it fires — a manual
 * "Scan now" would leave its report in "waiting" forever (the
 * "stuck in queue" bug).
 *
 * runInBackground() instead schedules with the GLOBAL setTimeout (never
 * cancelled by any context disposal) and hands the callback the long-lived
 * plugin context captured at apply() time, whose services (setting, logger)
 * stay valid for the whole process lifetime.
 */

import type { Context } from 'hydrooj';

let bgCtx: Context | null = null;

/** Called once from apply() — the context lives as long as the plugin. */
export function setBackgroundContext(ctx: Context) {
    bgCtx = ctx;
}

/**
 * Run fn on a later macrotask with the plugin context. Sync throws and async
 * rejections are logged, never propagated to the caller.
 */
export function runInBackground(fn: (ctx: Context) => Promise<void> | void) {
    const ctx = bgCtx;
    setTimeout(() => {
        if (!ctx) return; // plugin not applied (unit tests) — nothing to run on
        try {
            Promise.resolve(fn(ctx)).catch((e) => ctx.logger.error(e));
        } catch (e) {
            ctx.logger.error(e);
        }
    }, 0);
}
