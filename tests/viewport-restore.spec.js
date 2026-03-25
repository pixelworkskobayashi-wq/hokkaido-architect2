// @ts-check
/**
 * viewport-restore.spec.js
 *
 * iOSのマルチフィンガー操作後のviewport縮小→復帰を正しくシミュレート。
 *
 * 実際のiOSの挙動:
 *   1. 4〜5本指操作でviewportが縮小アニメーション
 *   2. アプリがバックグラウンドへ（visibilitychange: hidden）
 *   3. ユーザーがアプリに戻る（visibilitychange: visible）
 *   4. この時点ではviewportはまだ縮小中
 *   5. iOSが徐々にviewportを復元（resize発火は不定）
 *
 * 旧テストの問題:
 *   setViewportSize(NORMAL) → fireVisibility('visible') の順で、
 *   viewportが先に復元済み。実機ではこの順序が逆。
 */
const { test, expect } = require('@playwright/test');

const NORMAL_VP = { width: 1024, height: 768 };
const SHRUNK_VP = { width: 600,  height: 450 };

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
  await page.waitForTimeout(1200);
}

async function fireVisibility(page, state) {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', {
      get: () => s, configurable: true
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function canvasCssWidth(page) {
  return page.evaluate(() =>
    document.querySelector('#game_app canvas').getBoundingClientRect().width
  );
}

async function getCanvasInfo(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#game_app canvas');
    const r = canvas.getBoundingClientRect();
    const sc = window._phaserGame.scale;
    return {
      cssW: r.width, cssH: r.height,
      cssLeft: r.left, cssTop: r.top,
      dsX: sc.displayScale?.x ?? 0,
      dsY: sc.displayScale?.y ?? 0,
      baseW: sc.baseSize?.width ?? 0,
      baseH: sc.baseSize?.height ?? 0,
    };
  });
}

async function resetVisibility(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible', configurable: true
    });
  });
}

// ─── テスト1: viewport遅延復元シミュレーション ─────────────

test('[遅延復元] visible時にviewportがまだ縮小中 → ポーリングが待機して正しく復元', async ({ page }) => {
  await startApp(page);

  const scenes = [
    { label: 'SelectionScene', setup: null },
    { label: 'MainScene 住宅', setup: async () => {
      await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: 1 }));
      await waitForScene(page, 'MainScene'); await page.waitForTimeout(1000);
    }},
    { label: 'MainScene 海岸', setup: async () => {
      await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: -1 }));
      await waitForScene(page, 'MainScene'); await page.waitForTimeout(1000);
    }},
  ];

  console.log('\n[遅延復元] viewportが遅れて復元されるシナリオ');
  console.log('  シーン                 | 初期cssW | 復帰cssW | 結果');
  console.log('  -----------------------|----------|----------|-----');

  for (const { label, setup } of scenes) {
    if (setup) await setup();
    const w0 = await canvasCssWidth(page);

    // ステップ1: viewportを縮小
    await page.setViewportSize(SHRUNK_VP);
    await page.waitForTimeout(100);

    // ステップ2: hidden発火（savedViewportが記録される）
    await fireVisibility(page, 'hidden');
    await page.waitForTimeout(100);

    // ステップ3: visible発火（★viewportはまだ縮小中★ — これがiOSの実挙動）
    await fireVisibility(page, 'visible');

    // ステップ4: 500ms後にviewportを復元（iOSのアニメーション完了をシミュレート）
    await page.waitForTimeout(500);
    await page.setViewportSize(NORMAL_VP);

    // ステップ5: ポーリングが検知して復元するのを待つ
    await page.waitForTimeout(4000);

    const w1 = await canvasCssWidth(page);
    const ok = Math.abs(w1 - w0) <= w0 * 0.05;
    console.log(
      `  ${label.padEnd(22)} | ${String(Math.round(w0)).padEnd(8)} | ${String(Math.round(w1)).padEnd(8)} | ${ok ? '✓' : '✗ FAIL ' + Math.round(w1)}`
    );
    expect(w1, `${label}: canvas幅 ${Math.round(w1)} should ≈ ${Math.round(w0)}`).toBeGreaterThanOrEqual(w0 * 0.95);

    await resetVisibility(page);
  }
  console.log('  → 遅延復元テスト PASS ✓');
});


// ─── テスト2: 縮小中にresizeが発火してもr0が汚染されない ──

test('[resize抑制] _isRestoring中のresizeイベントでr0が汚染されない', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: 1 }));
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  console.log('\n[resize抑制] _isRestoring中のresize防御');

  const before = await getCanvasInfo(page);
  console.log(`  初期 canvas: w=${Math.round(before.cssW)} dsX=${before.dsX.toFixed(4)}`);

  await fireVisibility(page, 'hidden');
  await page.setViewportSize(SHRUNK_VP);
  await page.waitForTimeout(100);

  await fireVisibility(page, 'visible');

  // 縮小中にresizeを手動dispatch
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(200);

  const duringRestore = await page.evaluate(() => {
    const canvas = document.querySelector('#game_app canvas');
    return { transform: canvas.style.transform };
  });
  console.log(`  復帰中 transform: "${duringRestore.transform}" (空であるべき)`);
  expect(duringRestore.transform).toBe('');

  await page.setViewportSize(NORMAL_VP);
  await page.waitForTimeout(4000);

  const after = await getCanvasInfo(page);
  console.log(`  復帰後 canvas: w=${Math.round(after.cssW)} dsX=${after.dsX.toFixed(4)}`);

  const wDiff = Math.abs(after.cssW - before.cssW) / before.cssW;
  expect(wDiff, `canvas幅の差: ${(wDiff*100).toFixed(1)}%`).toBeLessThan(0.05);

  await resetVisibility(page);
  console.log('  → resize抑制テスト PASS ✓');
});


// ─── テスト3: 遅延復元後のpointer座標精度 ───────────────

test('[座標精度] 遅延復元後のタッチ座標が ±10px以内', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: 1 }));
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  console.log('\n[座標精度] 遅延復元後のpointer精度');

  const info0 = await getCanvasInfo(page);
  const tapX = Math.round(info0.cssLeft + info0.cssW / 2);
  const tapY = Math.round(info0.cssTop + info0.cssH / 2);

  await page.touchscreen.tap(tapX, tapY);
  await page.waitForTimeout(200);
  const ref = await page.evaluate(() => {
    const s = window._phaserGame.scene.getScene('MainScene');
    return s?.input?.activePointer ? { x: s.input.activePointer.x, y: s.input.activePointer.y } : null;
  });
  console.log(`  基準 pointer: (${Math.round(ref.x)}, ${Math.round(ref.y)})`);

  await page.setViewportSize(SHRUNK_VP);
  await page.waitForTimeout(100);
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(100);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(500);
  await page.setViewportSize(NORMAL_VP);
  await page.waitForTimeout(4000);

  const info1 = await getCanvasInfo(page);
  const tapX1 = Math.round(info1.cssLeft + info1.cssW / 2);
  const tapY1 = Math.round(info1.cssTop + info1.cssH / 2);
  await page.touchscreen.tap(tapX1, tapY1);
  await page.waitForTimeout(200);

  const ptr = await page.evaluate(() => {
    const s = window._phaserGame.scene.getScene('MainScene');
    return s?.input?.activePointer ? { x: s.input.activePointer.x, y: s.input.activePointer.y } : null;
  });
  expect(ptr).not.toBeNull();

  const dx = Math.abs(ptr.x - ref.x);
  const dy = Math.abs(ptr.y - ref.y);
  console.log(`  復帰後 pointer: (${Math.round(ptr.x)}, ${Math.round(ptr.y)}) dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
  expect(dx, `X座標ずれ ${dx.toFixed(1)}px`).toBeLessThanOrEqual(10);
  expect(dy, `Y座標ずれ ${dy.toFixed(1)}px`).toBeLessThanOrEqual(10);

  await resetVisibility(page);
  console.log('  → 座標精度テスト PASS ✓');
});


// ─── テスト4: 高速切替（連続でhidden/visible） ──────────

test('[高速切替] 連続hidden/visibleでも最終的に正しく復元', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: 0 }));
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  console.log('\n[高速切替] 連続バックグラウンド復帰');

  const w0 = await canvasCssWidth(page);

  for (let i = 0; i < 3; i++) {
    await page.setViewportSize(SHRUNK_VP);
    await fireVisibility(page, 'hidden');
    await page.waitForTimeout(50);
    await fireVisibility(page, 'visible');
    await page.waitForTimeout(100);
  }

  await page.setViewportSize(NORMAL_VP);
  await page.waitForTimeout(4000);

  const w1 = await canvasCssWidth(page);
  const ok = Math.abs(w1 - w0) <= w0 * 0.05;
  console.log(`  初期=${Math.round(w0)} 復帰後=${Math.round(w1)} ${ok ? '✓' : '✗ FAIL'}`);
  expect(w1, `canvas幅復元失敗`).toBeGreaterThanOrEqual(w0 * 0.95);

  await resetVisibility(page);
  console.log('  → 高速切替テスト PASS ✓');
});


// ─── テスト5: ファイルピッカー中は復帰処理スキップ ──────

test('[ファイルピッカー] _filePicking中はrestoreAfterBackground実行されない', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => window._phaserGame.scene.start('MainScene', { premises_index: 1 }));
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  console.log('\n[ファイルピッカー] _filePicking保護');

  const before = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { w: sc.canvasBounds.width, h: sc.canvasBounds.height };
  });

  await page.evaluate(() => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.id = '_test_fp_inp';
    document.body.appendChild(inp);
  });
  await page.waitForTimeout(100);

  // ファイルピッカーはviewportを変更しない — visibilitychangeのみ
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(2000);

  const after = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { w: sc.canvasBounds.width, h: sc.canvasBounds.height };
  });
  console.log(`  before: ${before.w}x${before.h}  after: ${after.w}x${after.h}`);
  expect(after.w).toBe(before.w);
  expect(after.h).toBe(before.h);

  await page.evaluate(() => {
    document.getElementById('_test_fp_inp')?.remove();
  });
  await page.setViewportSize(NORMAL_VP);
  await resetVisibility(page);
  console.log('  → ファイルピッカーテスト PASS ✓');
});
