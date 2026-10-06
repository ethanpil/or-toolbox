// TEMPORARY diagnostics for the cross-browser CI runs (removed later). Logs only, never fails.
import { test } from '../../mock/index.ts';
import { mediaLoadProbe } from '../zz-probe-lib.ts';

test('probe: media loading (dev server, isolated)', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  await page.goto('privacy/');
  console.log(`PROBE media dev ${browserName}`, JSON.stringify(await mediaLoadProbe(page)));
});
