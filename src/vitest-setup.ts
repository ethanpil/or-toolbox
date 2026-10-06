/**
 * Runs in every Vitest file (`setupFiles` in vitest.config.ts). Bootstrap ends a show or hide with a fallback
 * timer (`transitionend` after the transition's duration + 5 ms); one started by a file's last test can fire after
 * that file's jsdom is torn down, which fails the whole run with an unhandled error (seen on CI in several files).
 * Let such timers land while the page still exists. Node's own timer, because a file may leave the global
 * `setTimeout` faked or spied on.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll } from 'vitest';

afterAll(async () => {
  if (typeof window !== 'undefined') await sleep(50);
});
