import { _electron, expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('scrolling scene titles place, move and save dividers across the whole script', async () => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'lx-scene-setup-'));
  const env = { ...process.env, LX_DESKTOP_CORPUS: '', LX_DESKTOP_USER_DATA: userData, LX_DESKTOP_TEST_HIDE_WINDOWS: '1' };
  const app = await _electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1280, height: 900 }));
    await page.locator('.example-card').first().click();
    await expect(page.getByRole('heading', { name: 'Set up your script' })).toBeVisible({ timeout: 120000 });
    const preview = page.getByRole('region', { name: 'Script preview', exact: true });
    const sheets = preview.locator('.preview-page');
    const total = await sheets.count();
    expect(total).toBeGreaterThan(20);
    await expect(page.getByRole('button', { name: 'Previous', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Scene number', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Down page (%)')).toHaveCount(0);
    const lastSheet = sheets.last();
    await lastSheet.scrollIntoViewIfNeeded();
    await expect.poll(() => preview.evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
    await expect.poll(() => lastSheet.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(300);
    expect(await preview.locator('canvas').count()).toBeLessThan(8);

    // Keep a single suggested title, then place a second title ourselves.
    const titles = page.getByLabel('Scene title', { exact: true });
    while (await titles.count() > 1) await page.locator('.scene-title-row').last().getByRole('button').click();
    await titles.first().fill('Opening');
    await titles.first().click();
    async function place(pageIndex: number, fraction: number) {
      const sheet = sheets.nth(pageIndex);
      await sheet.scrollIntoViewIfNeeded();
      const size = await sheet.boundingBox();
      await sheet.click({ position: { x: size!.width / 2, y: size!.height * fraction } });
    }
    await place(0, 0.28);
    await page.getByRole('button', { name: 'Add scene', exact: true }).click();
    await expect(titles.last()).toBeFocused();
    await titles.last().fill('Second scene');
    await page.getByRole('button', { name: 'Create show', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Click the script to place');
    await place(1, 0.38);
    await expect(sheets.nth(1).locator('.preview-boundary.selected')).toContainText('Second scene');
    await expect.poll(() => sheets.nth(1).locator('.preview-boundary.selected').evaluate(element => parseFloat((element as HTMLElement).style.top))).toBeCloseTo(38, 0);
    await place(2, 0.56);
    await expect(sheets.nth(1).locator('.preview-boundary')).toHaveCount(0);
    await expect(sheets.nth(2).locator('.preview-boundary.selected')).toContainText('Second scene');

    // A selected title stays selected while the script scrolls and the window changes size.
    await titles.first().click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 850, height: 800 }));
    await place(0, 0.24);
    await expect(sheets.first().locator('.preview-boundary.selected')).toContainText('Opening');
    await expect(sheets.nth(2).locator('.preview-boundary')).toContainText('Second scene');
    await page.screenshot({ path: 'artifacts/scene-setup-scrolling.png' });
    await page.getByRole('button', { name: 'Create show', exact: true }).click();
    await expect(page.locator('.formatted-script').first()).toBeVisible();
    const state = await page.evaluate(async () => (await fetch('/api/sync/bootstrap').then(response => response.json())).state);
    expect(state.scenes).toHaveLength(2);
    expect(state.scenes.map((scene: { name: string; number: string; pageStart: number }) => [scene.name, scene.number, scene.pageStart])).toEqual([['Opening', '1', 1], ['Second scene', '2', 3]]);
    expect(state.scenes[0].startY).toBeCloseTo(0.24, 2);
    expect(state.scenes[1].startY).toBeCloseTo(0.56, 2);
    expect(state.scenes[0].pageEnd).toBe(3);
    const file = path.resolve('artifacts/scene-setup-test.lxshow');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
    await page.getByRole('button', { name: 'SHOW', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Save show as…', exact: true }).click();
    await expect.poll(async () => fs.stat(file).then(stat => stat.size).catch(() => 0)).toBeGreaterThan(10000);
    await page.evaluate(file => window.desktop.openShow(file), file);
    await page.reload();
    await expect(page.locator('.formatted-script').first()).toBeVisible();
    const restored = await page.evaluate(async () => (await fetch('/api/sync/bootstrap').then(response => response.json())).state.scenes);
    expect(restored).toEqual(state.scenes);
    expect(errors).toEqual([]);
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
