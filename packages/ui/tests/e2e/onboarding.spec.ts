import { test, expect, type Page } from '@playwright/test';

/**
 * Issue #28 — Onboarding: example gallery + first-run experience (e2e).
 *
 * Runs against the REAL app (Playwright webServer = `vite` on :5180; the app
 * runs in VITE_ENGINE=local, so the whole flow is backend-off). These tests
 * encode the PRD acceptance criteria and are written to FAIL against a stub:
 *   • a hardcoded-cards gallery (no data-driven cards, no real thumbnails),
 *   • a fixed-placeholder thumbnail (two cards would look identical),
 *   • a tour that repeats every load (would still show after reload),
 *   • a Fix-me card that never reaches repair or hard-crashes keyless.
 *
 * ── Stated selector/contract assumptions (builder matches these) ──
 *   Landing gallery:  [data-testid="example-gallery"]
 *   Card:             [data-testid="gallery-card"] with
 *                       data-kind="working"|"fixme",
 *                       data-difficulty="beginner"|"intermediate"|"advanced",
 *                       data-design-id="<gallery.json entry id>"
 *                     and an INLINE <svg> thumbnail (the air-ts toSchematicSvg
 *                     render — not an <img>), a title, a one-line description.
 *   Gallery data:     served at /gallery.json; example XML bundled as static
 *                     assets at each entry's sourcePath.
 *   First-run tour:   [data-testid="tour-overlay"], dismiss
 *                     [data-testid="tour-dismiss"], Help re-launch
 *                     [data-testid="tour-help"]; suppressed by the localStorage
 *                     flag `airspice.onboarding.tourSeen.v1` (versioned).
 *   Reused app hooks: engine-mode, .toolbar button[title="Run Simulation"],
 *                     .waveform-viewer, repair-panel, repair-run,
 *                     repair-outcome[data-reason], Settings button, BYOK vault
 *                     key prefix `airspice.byok.`.
 */

// Must EXACTLY match the app's real, versioned localStorage flag
// (packages/ui/src/onboarding/tourState.ts → TOUR_STORAGE_KEY). A mismatch
// means suppressTour writes a key the app ignores, the first-run tour is NOT
// suppressed, and its overlay intercepts clicks in the workspace.
const TOUR_KEY = 'airspice.onboarding.tourSeen.v1';
const GALLERY = '[data-testid="example-gallery"]';
const CARD = '[data-testid="gallery-card"]';

/** Fresh browser profile: land, wipe storage, reload so boot sees a clean slate. */
async function freshProfile(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

/** Suppress the first-run tour so it does not occlude non-tour flows. */
async function suppressTour(page: Page) {
  await page.addInitScript((key) => {
    localStorage.setItem(key, '1');
  }, TOUR_KEY);
}

/** Remove every BYOK vault key so the agent/repair provider is unconfigured. */
async function goKeyless(page: Page) {
  await page.evaluate(() => {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('airspice.byok.')) localStorage.removeItem(k);
    }
  });
}

async function dismissTourIfPresent(page: Page) {
  const overlay = page.getByTestId('tour-overlay');
  if (await overlay.isVisible().catch(() => false)) {
    const dismiss = page.getByTestId('tour-dismiss');
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    await overlay.waitFor({ state: 'hidden' }).catch(() => undefined);
  }
}

test.describe('Onboarding — example gallery + first run', () => {
  test('fresh profile: Landing shows a gallery grid with cards, real thumbnails, and both rows', async ({ page }) => {
    await suppressTour(page);
    await page.goto('/');
    await dismissTourIfPresent(page);

    await expect(page.locator(GALLERY)).toBeVisible();

    const cards = page.locator(CARD);
    await expect(cards.first()).toBeVisible();
    expect(await cards.count(), 'gallery renders a curated set of cards').toBeGreaterThanOrEqual(4);

    // Both curated rows are present (data-driven kinds).
    await expect(page.locator(`${CARD}[data-kind="working"]`).first()).toBeVisible();
    await expect(page.locator(`${CARD}[data-kind="fixme"]`).first()).toBeVisible();

    // A card carries its difficulty tag + an inline <svg> thumbnail.
    const first = cards.first();
    await expect(first).toHaveAttribute('data-difficulty', /beginner|intermediate|advanced/);
    await expect(first.locator('svg').first()).toBeVisible();

    // Thumbnails are REAL, design-derived renders: two different cards' inline
    // SVGs DIFFER (a fixed placeholder / stock art would be identical) and carry
    // schematic <text> (component ids / net labels), i.e. air-ts toSchematicSvg.
    const svgA = await cards.nth(0).locator('svg').first().innerHTML();
    const svgB = await cards.nth(1).locator('svg').first().innerHTML();
    expect(svgA.length, 'thumbnail A is a non-trivial svg').toBeGreaterThan(40);
    expect(svgA, 'thumbnail is a schematic render (has <text>)').toContain('<text');
    expect(svgA, 'two different designs render distinct thumbnails').not.toBe(svgB);
  });

  test('clicking a working example opens a new project and Run Simulation yields waveforms (backend off)', async ({ page }) => {
    await suppressTour(page);
    await page.goto('/');
    await dismissTourIfPresent(page);

    // Target a simulate-able, DISTINCT working example from the data
    // (analog_primitives has V_IN/LOAD_A, absent from the default esp32 design),
    // so the assertion proves the CLICKED design actually loaded. Identify it by
    // DESIGN IDENTITY (id / title / sourcePath), never by a repo path segment —
    // bundled assets are served from the app's own paths (e.g. /gallery/*).
    const target = await page.evaluate(async () => {
      const res = await fetch('/gallery.json');
      const data = await res.json();
      const entries = Array.isArray(data) ? data : (data.entries ?? data.examples ?? data.gallery);
      const hit = entries.find((e: { kind: string; id?: string; title?: string; sourcePath?: string }) =>
        e.kind === 'working' &&
        /analog[_\- ]?primitives/i.test(`${e.id ?? ''} ${e.title ?? ''} ${e.sourcePath ?? ''}`),
      );
      return hit ? hit.id : null;
    });
    expect(target, 'gallery must include a working analog_primitives entry').not.toBeNull();

    await page.locator(`${CARD}[data-design-id="${target}"]`).click();

    await expect(page).toHaveURL(/\/project/);
    await expect(page.getByTestId('engine-mode')).toHaveText('Local engine'); // backend off

    // The clicked design loaded: V_IN is unique to analog_primitives — a stub
    // that always opens the default esp32 design would never show it.
    await expect(page.getByText('V_IN', { exact: false }).first()).toBeVisible({ timeout: 15000 });

    await dismissTourIfPresent(page);
    await page.locator('.toolbar button[title="Run Simulation"]').click();

    // Waveforms render with ZERO backend (the panel only mounts the viewer when
    // real traces exist).
    await expect(page.getByTestId('waveform-viewer')).toBeVisible({ timeout: 60000 });
  });

  test('first-run tour appears once on a fresh profile, not on reload, and re-launches from Help', async ({ page }) => {
    await freshProfile(page); // genuinely fresh: no tour-seen flag

    const overlay = page.getByTestId('tour-overlay');

    // The tour may greet on Landing OR on first entry into a project; accept
    // either. If it is not on Landing, open the first working example.
    let shownOnLanding = false;
    try {
      await overlay.waitFor({ state: 'visible', timeout: 2500 });
      shownOnLanding = true;
    } catch {
      shownOnLanding = false;
    }
    if (!shownOnLanding) {
      await page.locator(`${CARD}[data-kind="working"]`).first().click();
      await expect(page).toHaveURL(/\/project/);
    }
    await expect(overlay, 'tour shows once for a fresh profile').toBeVisible();

    // Dismiss.
    await page.getByTestId('tour-dismiss').click();
    await expect(overlay).toBeHidden();

    // Reload the SAME view — the tour must NOT auto-repeat (persisted flag).
    await page.reload();
    await expect(overlay, 'tour must not re-appear on reload').toBeHidden();

    // Re-arm from the Help affordance — the tour shows again.
    await page.getByTestId('tour-help').click();
    await expect(overlay, 'Help re-launches the tour').toBeVisible();
  });

  test('a Fix-me card opens the failing design and reaches the repair panel (keyless → BYOK pointer, no crash)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await suppressTour(page);
    await page.goto('/');
    await dismissTourIfPresent(page);

    // Confirm the data has a Fix-me entry. Fix-me designs are bundled under the
    // app's own static assets (sourcePath like "gallery/*.xml"), so we identify
    // them by kind ONLY — never by a repo path string. Their "genuinely broken"
    // nature is enforced semantically (air-ts validate) in the unit metadata
    // test, and here by actually reaching the repair panel below.
    const fixmeCount = await page.evaluate(async () => {
      const res = await fetch('/gallery.json');
      const data = await res.json();
      const entries = Array.isArray(data) ? data : (data.entries ?? data.examples ?? data.gallery);
      return entries.filter((e: { kind: string }) => e.kind === 'fixme').length;
    });
    expect(fixmeCount, 'gallery has at least one Fix-me entry').toBeGreaterThanOrEqual(1);

    const fixme = page.locator(`${CARD}[data-kind="fixme"]`).first();
    await expect(fixme).toBeVisible();
    await fixme.click();

    await expect(page).toHaveURL(/\/project/);
    // The Fix-me card ROUTES INTO the repair panel (primed for the repair loop).
    await expect(page.getByTestId('repair-panel')).toBeVisible({ timeout: 15000 });

    // Keyless: remove any stored provider key AFTER boot, then run repair.
    await goKeyless(page);
    await page.getByTestId('repair-run').click();

    // Keyless → an actionable BYOK pointer, NOT a hard failure.
    const outcome = page.getByTestId('repair-outcome');
    await expect(outcome).toBeVisible();
    await expect(outcome).toHaveAttribute('data-reason', 'provider_error');
    await expect(outcome).toContainText('Add one in Settings.');
    // The pointer to BYOK setup is reachable.
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled();

    // No uncaught page error anywhere in the flow.
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toHaveLength(0);
  });
});
