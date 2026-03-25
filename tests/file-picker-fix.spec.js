// @ts-check
/**
 * file-picker-fix.spec.js
 * _resetOnForeground の updateScale リトライと _filePicking 保護を検証
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/test_layout.json');

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
  // canvas 検出後 setTimeout(800ms) で ready=true になるのを待つ
  await page.waitForTimeout(1200);
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

// ─── シナリオA: canvas 強制縮小 → _forceRefit が正常サイズに戻す ──

test('[シナリオA] canvas強制縮小後にvisibleを発火 → _forceRefitで全シーン正常復帰', async ({ page }) => {
  await startApp(page);

  const scenes = [
    {
      label: 'SelectionScene',
      setup: null,
    },
    {
      label: 'MainScene 住宅',
      setup: async () => {
        await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: 1 }));
        await waitForScene(page, 'MainScene');
        await page.waitForTimeout(1000);
      },
    },
    {
      label: 'MainScene 郊外',
      setup: async () => {
        await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: 0 }));
        await waitForScene(page, 'MainScene');
        await page.waitForTimeout(1000);
      },
    },
    {
      label: 'MainScene 海岸',
      setup: async () => {
        await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: -1 }));
        await waitForScene(page, 'MainScene');
        await page.waitForTimeout(1000);
      },
    },
  ];

  console.log('\n[シナリオA] canvas強制縮小 → _forceRefit リトライ検証');
  console.log('  シーン                 | 初期cssW | 縮小後  | 復帰後  | 結果');
  console.log('  -----------------------|----------|---------|---------|-----');

  for (const { label, setup } of scenes) {
    if (setup) await setup();

    const w0 = await canvasCssWidth(page);

    // canvas CSS を強制的に 600px に縮小（アプリスイッチャー縮小を模擬）
    await page.evaluate(() => {
      const c = document.querySelector('#game_app canvas');
      c.style.width  = '600px';
      c.style.height = '338px';
    });
    const wShrunk = await canvasCssWidth(page);

    // visibilitychange visible 発火 → _forceRefit が 300ms ごとに最大6回試行
    await fireVisibility(page, 'hidden');
    await page.waitForTimeout(50);
    await fireVisibility(page, 'visible');

    // 最大 1800ms（6回 × 300ms）+ バッファ 300ms
    await page.waitForTimeout(2100);

    const w1 = await canvasCssWidth(page);
    const ok = Math.abs(w1 - w0) <= w0 * 0.05;
    console.log(
      `  ${label.padEnd(22)} | ${String(w0).padEnd(8)} | ${String(wShrunk).padEnd(7)} | ${String(w1).padEnd(7)} | ${ok ? '✓' : '⚠ 復帰失敗'}`
    );
    expect(w1, `${label}: canvas幅 ${w1} ≠ ${w0}`).toBeGreaterThanOrEqual(w0 * 0.95);
  }

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });
  console.log('  → シナリオA PASS ✓');
});

// ─── シナリオB: ファイルピッカー中はリセットしない ──────

test('[シナリオB] _filePicking=true の時 visibilitychange visible でreset抑制', async ({ page }) => {
  await startMainScene(page, 1);

  const before = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return {
      left: sc.canvasBounds.left, top: sc.canvasBounds.top,
      w:    sc.canvasBounds.width, h:  sc.canvasBounds.height,
    };
  });

  // MutationObserver をトリガー: input[type=file] を body に追加
  await page.evaluate(() => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id   = '_test_file_inp';
    document.body.appendChild(inp);
  });
  await page.waitForTimeout(100);

  // _filePicking=true の状態で hidden → visible
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');

  // _forceRefit が走った場合の最大待機時間より長く待機
  await page.waitForTimeout(2200);

  const after = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return {
      left: sc.canvasBounds.left, top: sc.canvasBounds.top,
      w:    sc.canvasBounds.width, h:  sc.canvasBounds.height,
    };
  });
  console.log(`\n[シナリオB] canvasBounds before: ${JSON.stringify(before)}`);
  console.log(`            canvasBounds after : ${JSON.stringify(after)}`);
  expect(after.left).toBe(before.left);
  expect(after.top).toBe(before.top);
  expect(after.w).toBe(before.w);
  expect(after.h).toBe(before.h);

  // changeイベントでフラグ解除 → 次の visible では _resetOnForeground が動く
  await page.evaluate(() => {
    document.getElementById('_test_file_inp')?.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(1200); // changeタイマー1秒 + バッファ

  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  // _forceRefit: vw=1024 >= 1024*0.8 なので初回で完了（300ms + バッファ）
  await page.waitForTimeout(700);

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
  console.log('  → シナリオB PASS ✓');
});
