#!/usr/bin/env node
/**
 * measure-end-rail.mjs — قياس سلوك سكة النهاية بعد إعادة التصميم.
 * يُحذف بعد الاستخدام.
 */
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = process.env.DATABASE_PATH
  ?? path.join(os.homedir(), '.local/share/nassaj-dev/db.sqlite');
const BASE = 'http://127.0.0.1:3004';
const EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ?? path.join(os.homedir(), '.cache/ms-playwright/chromium-1187/chrome-linux/chrome');

function envValue(key) {
  const line = readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : null;
}

async function mintToken() {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB, { readonly: true });
  const user = db.prepare(
    "select id, username, role, password_changed_at from users where role='owner' order by id limit 1",
  ).get();
  db.close();
  const { default: jwt } = await import('jsonwebtoken');
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role, pwd_iat: user.password_changed_at ?? 0 },
    envValue('JWT_SECRET'),
    { expiresIn: '1h' },
  );
}

async function openPage(browser, token, width, height) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB, { readonly: true });
  const row = db.prepare('select session_id from sessions limit 1').get();
  db.close();
  const sessionId = row?.session_id ?? '';

  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.addInitScript(([t]) => localStorage.setItem('auth-token', t), [token]);
  await page.goto(`${BASE}/session/${sessionId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-session-end-rail]', { timeout: 15000 });
  return { page, ctx };
}

async function main() {
  const token = await mintToken();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });

  try {
    // ---- Desktop 1440×900 ----
    console.log('\n=== Desktop 1440×900 ===');
    {
      const { page, ctx } = await openPage(browser, token, 1440, 900);
      const pinSlot = page.locator('[data-session-pin-slot]').first();
      const avatarSlot = page.locator('[data-session-avatar-slot]').first();
      const overlay = page.locator('[data-session-actions-overlay]').first();

      const pinBoxRest = await pinSlot.boundingBox();
      console.log('pin boundingBox at rest:', JSON.stringify(pinBoxRest));

      // Hover avatar slot → overlay should appear
      await avatarSlot.hover();
      await page.waitForTimeout(250);
      const pinBoxOnAvatarHover = await pinSlot.boundingBox();
      console.log('pin boundingBox while avatars hovered:', JSON.stringify(pinBoxOnAvatarHover));
      const overlayVisibleAvatarHover = await overlay.isVisible();
      const overlayBtnCount = await page.locator('[data-session-actions-overlay] button').count();
      console.log('overlay visible while hovering avatars:', overlayVisibleAvatarHover);
      console.log('overlay button count while hovering avatars:', overlayBtnCount);

      // Hover pin slot → overlay should NOT appear
      await pinSlot.hover();
      await page.waitForTimeout(250);
      const overlayVisiblePinHover = await overlay.isVisible();
      console.log('overlay visible while hovering pin:', overlayVisiblePinHover);

      // Pin click: before → click → after → restore
      const pinBtn = pinSlot.locator('button').first();
      const beforePressed = await pinBtn.getAttribute('aria-pressed');
      console.log('pin aria-pressed before click:', beforePressed);
      await pinBtn.click();
      await page.waitForTimeout(150);
      const afterPressed = await page.locator('[data-session-pin-slot] button').first().getAttribute('aria-pressed');
      console.log('pin aria-pressed after click:', afterPressed);
      await page.locator('[data-session-pin-slot] button').first().click();
      await page.waitForTimeout(150);
      const restoredPressed = await page.locator('[data-session-pin-slot] button').first().getAttribute('aria-pressed');
      console.log('pin aria-pressed restored:', restoredPressed);

      const stable = JSON.stringify(pinBoxRest) === JSON.stringify(pinBoxOnAvatarHover);
      console.log('pin position stable rest==hovered:', stable);
      await ctx.close();
    }

    // ---- Mobile 412×915 ----
    console.log('\n=== Mobile 412×915 ===');
    {
      const { page, ctx } = await openPage(browser, token, 412, 915);
      const pinSlot = page.locator('[data-session-pin-slot]').first();
      const avatarSlot = page.locator('[data-session-avatar-slot]').first();

      const pinBoxRest = await pinSlot.boundingBox();
      console.log('pin boundingBox at rest:', JSON.stringify(pinBoxRest));

      // One tap on avatar slot
      const box = await avatarSlot.boundingBox();
      if (!box) { console.log('ERROR: avatar slot not found'); return; }
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(400);

      const overlayVisible = await page.locator('[data-session-actions-overlay]').first().isVisible();
      const overlayBtnCount = await page.locator('[data-session-actions-overlay] button').count();
      const pinBoxAfterTap = await pinSlot.boundingBox();
      const pinPressed = await page.locator('[data-session-pin-slot] button').first().getAttribute('aria-pressed');

      console.log('overlay visible after one tap on avatars:', overlayVisible);
      console.log('overlay button count:', overlayBtnCount);
      console.log('pin boundingBox after tap:', JSON.stringify(pinBoxAfterTap));
      console.log('pin aria-pressed after tap (must equal rest):', pinPressed);
      console.log('pin position stable rest==after-tap:',
        JSON.stringify(pinBoxRest) === JSON.stringify(pinBoxAfterTap));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
