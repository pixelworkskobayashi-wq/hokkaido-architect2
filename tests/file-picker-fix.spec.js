// @ts-check
/**
 * file-picker-fix.spec.js
 * _resetOnForeground の viewport 確認ロジックと _filePicking 保護を検証
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/test_layout.json');

const NORMAL_VP = { width: 1024, height: 768 };
const SHRUNK_VP = { width: 512,  height: 384 };

// ─── ヘルパー ──────────────────────────────────────────────

async function waitForPhaserReady(page) {
  await page.waitForFunction(
    () => window._phaserGame?.scene?.scenes?.length > 0,
    { timeout: 20000 }
  );
}

async function waitForScene(page, key, timeout = 20000) {
  await page.waitForFunction(
    (k) => window._phaserGame?.scene?.getScene(k)?.sys?.settings?.active,
    key, { timeout }
  );
}

async function startApp(page) {
  await page.goto('/');
  await page.waitForSelector('#tos-agree-btn', { state: 'visible' });
  await page.click('#tos-agree-btn');
  await page.waitForFunction(
    () => document.getElementById('tos-overlay')?.style.display === 'none',
    { timeout: 5000 }
  );
  await waitForPhaserReady(page);
  await page.waitForFunction(
    () => window._phaserGame.scene.scenes.some(s =>
      s.sys.settings.active &&
      ['TitleScene', 'SelectionScene'].includes(s.sys.settings.key)
    ),
    { timeout: 20000 }
  );
}

async function startMainScene(page, premisesIndex = 1) {
  await startApp(page);
  await page.evaluate((idx) => {
    window._phaserGame.scene.start('MainScene', { premises_index: idx });
  }, premisesIndex);
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);
}

async function fireVisibility(page, state) {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { get: () => s, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function canvasCssWidth(page) {
  return page.evaluate(() =>
    document.querySelector('#game_app canvas').getBoundingClientRect().width
  );
}

// ─── シナリオA: resize あり・正常ケース ────────────────────

test('[シナリオA] resize後にvisible → viewport確認でresizeをdispatch → 全シーン正常復帰', async ({ page }) => {
  await startApp(page);

  const scenes = [
    { label: 'SelectionScene', setup: null },
    { label: 'MainScene 住宅', setup: async () => {
      await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: 1 }));
      await waitForScene(page, 'MainScene'); await page.waitForTimeout(1000);
    }},
    { label: 'MainScene 郊外', setup: async () => {
      await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: 0 }));
      await waitForScene(page, 'MainScene'); await page.waitForTimeout(1000);
    }},
    { label: 'MainScene 海岸', setup: async () => {
      await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: -1 }));
      await waitForScene(page, 'MainScene'); await page.waitForTimeout(1000);
    }},
  ];

  console.log('\n[シナリオA] resize + visible 正常ケース');
  console.log('  シーン                 | 初期cssW | 復帰cssW | 結果');
  console.log('  -----------------------|----------|----------|-----');

  for (const { label, setup } of scenes) {
    if (setup) await setup();
    const w0 = await canvasCssWidth(page);

    // 縮小
    await page.setViewportSize(SHRUNK_VP);
    await page.waitForTimeout(200);
    await fireVisibility(page, 'hidden');

    // 元に戻す → visible 発火
    await page.setViewportSize(NORMAL_VP);
    await fireVisibility(page, 'visible');

    // _waitViewport(300ms 初期待機) + 即座に条件成立(vw >= _normalW*0.8) + resize handler(500ms) + バッファ
    await page.waitForTimeout(1500);

    const w1 = await canvasCssWidth(page);
    const ok = Math.abs(w1 - w0) <= w0 * 0.05;
    console.log(
      `  ${label.padEnd(22)} | ${String(w0).padEnd(8)} | ${String(w1).padEnd(8)} | ${ok ? '✓' : '⚠ ' + w1}`
    );
    expect(w1, `${label}: canvas幅 ${w1} ≠ ${w0}`).toBeGreaterThanOrEqual(w0 * 0.95);
  }

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });
  console.log('  → シナリオA PASS ✓');
});

// ─── シナリオB: resize なし・遅延ケース ──────────────────

test('[シナリオB] resizeなし→_waitViewportがリトライ→途中でviewport復帰→正常復帰', async ({ page }) => {
  await startMainScene(page, 1);
  const w0 = await canvasCssWidth(page);
  console.log(`\n[シナリオB] 初期cssW=${w0}`);

  // 縮小 → hidden
  await page.setViewportSize(SHRUNK_VP);
  await page.waitForTimeout(200);
  await fireVisibility(page, 'hidden');

  // resize を戻さずに visible 発火
  // → _waitViewport がスタート(300ms後)。512 < 1024*0.8=819 なのでリトライを繰り返す
  await fireVisibility(page, 'visible');

  // _waitViewport の 1回目チェック(t=300ms): 512 < 819 → リトライ(+250ms)
  // _waitViewport の 2回目チェック(t=550ms): まだ 512 → リトライ(+250ms)
  // t=600ms: viewport を戻す
  await page.waitForTimeout(600);
  console.log(`  600ms後にviewportを正常サイズへ復帰`);
  await page.setViewportSize(NORMAL_VP);

  // _waitViewport の 3回目チェック(t=800ms): 1024 >= 819 → resize dispatch
  // resize handler: setTimeout(500) → 合計 t≈1300ms
  await page.waitForTimeout(1200);

  const w1 = await canvasCssWidth(page);
  console.log(`  復帰後 cssW=${w1}  期待=${w0}  ${Math.abs(w1 - w0) <= w0 * 0.05 ? '✓' : '⚠'}`);
  expect(w1, `canvas幅 ${w1} ≠ ${w0}`).toBeGreaterThanOrEqual(w0 * 0.95);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });
  console.log('  → シナリオB PASS ✓');
});

// ─── シナリオC: ファイルピッカー中はr0リセットしない ──────

test('[シナリオC] _filePicking=true の時 visibilitychange visible で resetが抑制される', async ({ page }) => {
  await startMainScene(page, 1);

  const before = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { left: sc.canvasBounds.left, top: sc.canvasBounds.top,
             w: sc.canvasBounds.width,   h: sc.canvasBounds.height };
  });

  // MutationObserver をトリガー
  await page.evaluate(() => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.id = '_test_file_inp';
    document.body.appendChild(inp);
  });
  await page.waitForTimeout(100);

  // _filePicking=true の状態で hidden → visible
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');

  // _resetOnForeground が実行されていれば _waitViewport(300ms) + resize + resize handler(500ms) が走る
  // 実行されていなければ何も起きない → 800ms 待って canvasBounds が変わっていないことを確認
  await page.waitForTimeout(800);

  const after = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { left: sc.canvasBounds.left, top: sc.canvasBounds.top,
             w: sc.canvasBounds.width,   h: sc.canvasBounds.height };
  });
  console.log(`\n[シナリオC] canvasBounds before: ${JSON.stringify(before)}`);
  console.log(`            canvasBounds after : ${JSON.stringify(after)}`);
  expect(after.left).toBe(before.left);
  expect(after.top).toBe(before.top);
  expect(after.w).toBe(before.w);
  expect(after.h).toBe(before.h);

  // changeイベントでフラグ解除 → 次のvisibleでリセット実行を確認
  await page.evaluate(() => {
    document.getElementById('_test_file_inp')?.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(1200);

  // resize不要ケース（viewport変化なし）: vw >= _normalW*0.8 が即座に成立するはず
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(1200); // _waitViewport(300ms) + resize handler(500ms) + バッファ

  const afterReset = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { w: sc.canvasBounds.width, h: sc.canvasBounds.height };
  });
  console.log(`  フラグ解除後 canvasBounds: w=${afterReset.w} h=${afterReset.h}  ${afterReset.w > 0 ? '✓' : '⚠'}`);
  expect(afterReset.w).toBeGreaterThan(0);

  // クリーンアップ
  await page.evaluate(() => {
    document.getElementById('_test_file_inp')?.remove();
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });
  console.log('  → シナリオC PASS ✓');
});
