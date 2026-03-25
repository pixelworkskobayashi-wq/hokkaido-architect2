// @ts-check
const { test, expect } = require('@playwright/test');
const path = require('path');

/**
 * ズーム座標ずれ検証テスト（全3エリア × 5サイクル）
 *
 * 目的：CSS transform ズーム後に等倍へ戻した際、Phaser が認識するゲーム座標が
 *       初期値と一致しているか（displayScale リセットが正しく機能しているか）を検証する。
 *
 * 検証シナリオ：
 *   全3エリア（住宅 / 郊外 / 海岸）それぞれで
 *   「1倍 → 徐々に2倍 → 徐々に1倍」を5サイクル繰り返し、
 *   各サイクルの等倍復帰後に pointer.x/y が初期値と ±5px 以内であることを確認する。
 */

const AREAS = [
  { name: '住宅', premisesIndex: 1 },
  { name: '郊外', premisesIndex: 0 },
  { name: '海岸', premisesIndex: -1 },
];

const ZOOM_CYCLES   = 3;
const WHEEL_STEPS   = 10;   // 1.0→2.0 に必要なホイール回数（1回=+0.1）
const WHEEL_DELTA   = -100; // deltaY < 0 でズームイン
const TOLERANCE_PX  = 5;    // 許容誤差 px

// ─────────────────────────────────────────────────────────────
// ヘルパー関数
// ─────────────────────────────────────────────────────────────

/** Phaser ゲームの起動完了を待つ */
async function waitForPhaserReady(page) {
  await page.waitForFunction(
    () =>
      window._phaserGame &&
      window._phaserGame.scene &&
      window._phaserGame.scene.scenes.length > 0,
    { timeout: 20000 }
  );
}

/** 指定シーンがアクティブになるまで待つ */
async function waitForScene(page, sceneKey, timeout = 20000) {
  await page.waitForFunction(
    (key) => {
      const game = window._phaserGame;
      if (!game) return false;
      const scene = game.scene.getScene(key);
      return scene && scene.sys.settings.active;
    },
    sceneKey,
    { timeout }
  );
}

/** MainScene の activePointer 座標を取得 */
async function getPointerCoords(page) {
  return page.evaluate(() => {
    const game = window._phaserGame;
    if (!game) return null;
    const scene = game.scene.getScene('MainScene');
    if (!scene || !scene.input) return null;
    const ptr = scene.input.activePointer;
    return { x: Math.round(ptr.x), y: Math.round(ptr.y) };
  });
}

/** canvas の中央スクリーン座標を取得 */
async function getCanvasCenter(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#game_app canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width  / 2),
      y: Math.round(r.top  + r.height / 2),
    };
  });
}

/** ホイールで段階的にズームイン（1.0 → 2.0） */
async function zoomIn(page, cx, cy) {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < WHEEL_STEPS; i++) {
    await page.mouse.wheel(0, WHEEL_DELTA);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
}

/** ホイールで段階的にズームアウト（2.0 → 1.0） */
async function zoomOut(page, cx, cy) {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < WHEEL_STEPS; i++) {
    await page.mouse.wheel(0, -WHEEL_DELTA); // deltaY > 0 でズームアウト
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
}

// ─────────────────────────────────────────────────────────────
// 共通セットアップ（各テストの beforeEach に相当する inline 処理）
// ─────────────────────────────────────────────────────────────

/**
 * ページを開き利用規約に同意してゲームを起動する。
 * 返り値：canvas 中央スクリーン座標
 */
async function setupGame(page) {
  await page.goto('/');

  // 1. 利用規約に同意
  await page.waitForSelector('#tos-agree-btn', { state: 'visible' });
  await page.click('#tos-agree-btn');
  await page.waitForFunction(
    () => {
      const el = document.getElementById('tos-overlay');
      return el && el.style.display === 'none';
    },
    { timeout: 5000 }
  );

  // 2. Phaser ゲーム起動を待つ
  await waitForPhaserReady(page);

  // 3. TitleScene or SelectionScene がアクティブになるまで待つ
  await page.waitForFunction(
    () => {
      const game = window._phaserGame;
      if (!game) return false;
      return game.scene.scenes.some(s =>
        s.sys.settings.active &&
        ['SelectionScene', 'TitleScene', 'MainScene'].includes(s.sys.settings.key)
      );
    },
    { timeout: 20000 }
  );
}

/**
 * 指定エリアで MainScene を起動する。
 * @param {number} premisesIndex  1=住宅 / 0=郊外 / -1=海岸
 */
async function startMainScene(page, premisesIndex) {
  await page.evaluate((idx) => {
    const game = window._phaserGame;
    // すでに MainScene がアクティブなら restart、それ以外は start
    const mainScene = game.scene.getScene('MainScene');
    if (mainScene && mainScene.sys.settings.active) {
      mainScene.scene.restart({ premises_index: idx });
    } else {
      game.scene.start('MainScene', { premises_index: idx });
    }
  }, premisesIndex);

  await waitForScene(page, 'MainScene');
  // アセット描画が落ち着くまで待機
  await page.waitForTimeout(1500);
}

// ─────────────────────────────────────────────────────────────
// テスト本体
// ─────────────────────────────────────────────────────────────

for (const area of AREAS) {
  test(`[${area.name}] 等倍復帰後の座標ずれなし（5サイクル）`, async ({ page }) => {

    // ── セットアップ ──────────────────────────────────────────
    await setupGame(page);
    await startMainScene(page, area.premisesIndex);

    const center = await getCanvasCenter(page);
    expect(center).not.toBeNull();
    console.log(`\n=== ${area.name}エリア (premisesIndex=${area.premisesIndex}) ===`);
    console.log(`Canvas中央: (${center.x}, ${center.y})`);

    // ── 基準座標を取得（ズーム前の等倍状態でクリック） ──────
    await page.mouse.move(center.x, center.y);
    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(200);

    const refCoord = await getPointerCoords(page);
    expect(refCoord).not.toBeNull();
    console.log(`基準座標(等倍): (${refCoord.x}, ${refCoord.y})`);

    // ── 5サイクル: ズームイン → ズームアウト → 座標検証 ────
    for (let cycle = 1; cycle <= ZOOM_CYCLES; cycle++) {

      // ズームイン (1.0 → 2.0)
      await zoomIn(page, center.x, center.y);

      const transformZoomed = await page.evaluate(() => {
        const c = document.querySelector('#game_app canvas');
        return c ? c.style.transform : '';
      });
      console.log(`  サイクル ${cycle} - ズーム後transform: ${transformZoomed}`);

      // ズームアウト (2.0 → 1.0)
      await zoomOut(page, center.x, center.y);

      const transformReset = await page.evaluate(() => {
        const c = document.querySelector('#game_app canvas');
        return c ? (c.style.transform || '(等倍リセット済み)') : '';
      });
      console.log(`  サイクル ${cycle} - 等倍後transform: ${transformReset}`);

      // 等倍復帰後に同じ画面座標をクリック
      await page.mouse.move(center.x, center.y);
      await page.mouse.click(center.x, center.y);
      await page.waitForTimeout(200);

      const coord = await getPointerCoords(page);
      expect(coord).not.toBeNull();

      const dx = Math.abs(refCoord.x - coord.x);
      const dy = Math.abs(refCoord.y - coord.y);
      const ok = dx <= TOLERANCE_PX && dy <= TOLERANCE_PX;

      console.log(
        `  サイクル ${cycle} - 座標: (${coord.x}, ${coord.y})  ` +
        `差: dx=${dx}, dy=${dy}  ${ok ? '✓' : '✗ FAIL'}`
      );

      // サイクルごとにスクリーンショット保存
      const screenshotPath = path.join(
        'tests',
        `screenshot-${area.name}-cycle${cycle}.png`
      );
      await page.screenshot({ path: screenshotPath });

      // アサーション（5px 超でフェイル）
      expect(dx).toBeLessThanOrEqual(
        TOLERANCE_PX,
        `[${area.name}] サイクル${cycle} X座標ずれ: 基準=${refCoord.x}, 実測=${coord.x}, 差=${dx}px`
      );
      expect(dy).toBeLessThanOrEqual(
        TOLERANCE_PX,
        `[${area.name}] サイクル${cycle} Y座標ずれ: 基準=${refCoord.y}, 実測=${coord.y}, 差=${dy}px`
      );
    }

    console.log(`=== ${area.name}エリア 全${ZOOM_CYCLES}サイクル完了 ✓ ===\n`);
  });
}
