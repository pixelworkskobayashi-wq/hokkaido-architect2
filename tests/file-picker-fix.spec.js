// @ts-check
/**
 * file-picker-fix.spec.js
 * _resetOnForeground (resize dispatch) の動作と _filePicking 保護を検証
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

// ─── シナリオA: viewport縮小→復帰後に canvas が正しくリフィット ──

test('[シナリオA] setViewportSize縮小→復帰+visible → 全シーンcanvas幅1024に戻る', async ({ page }) => {
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

  console.log('\n[シナリオA] setViewportSize縮小→復帰 + visibilitychange');
  console.log('  シーン                 | 初期cssW | 復帰cssW | 結果');
  console.log('  -----------------------|----------|----------|-----');

  for (const { label, setup } of scenes) {
    if (setup) await setup();
    const w0 = await canvasCssWidth(page);

    // 縮小 → hidden
    await page.setViewportSize(SHRUNK_VP);
    await page.waitForTimeout(200);
    await fireVisibility(page, 'hidden');

    // 元サイズに戻す → visible 発火
    // _resetOnForeground: zm=1 → setTimeout(500ms) → resize dispatch
    // resize handler: setTimeout(300ms) → _saveR0 + _apply
    // 合計 800ms + バッファ = 1200ms
    await page.setViewportSize(NORMAL_VP);
    await fireVisibility(page, 'visible');
    await page.waitForTimeout(1200);

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

// ─── シナリオB: ズーム→等倍後の pointer 座標 (全3エリア×3サイクル) ──

test('[シナリオB] iPad等倍→拡大→縮小3サイクル pointer座標ズレ5px以内', async ({ page }) => {
  await startApp(page);

  const areas = [['住宅', 1], ['郊外', 0], ['海岸', -1]];
  console.log('\n[シナリオB] ズームサイクル pointer精度');

  for (const [label, idx] of areas) {
    await page.evaluate((i) => {
      window._phaserGame.scene.start('MainScene', { premises_index: i });
    }, idx);
    await waitForScene(page, 'MainScene');
    await page.waitForTimeout(1000);

    // canvas 中央の CSS 座標を取得
    const info = await page.evaluate(() => {
      const r = document.querySelector('#game_app canvas').getBoundingClientRect();
      return { left: r.left, top: r.top, w: r.width, h: r.height };
    });
    const tapX = Math.round(info.left + info.w / 2);
    const tapY = Math.round(info.top  + info.h / 2);

    for (let cycle = 1; cycle <= 3; cycle++) {
      // ズームイン（10ホイール）
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(200);

      // ズームアウト（10ホイール）
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(200);

      // タップして pointer を確認
      await page.touchscreen.tap(tapX, tapY);
      await page.waitForTimeout(150);

      const ptr = await page.evaluate(() => {
        const s = window._phaserGame.scene.getScene('MainScene');
        return s?.input?.activePointer
          ? { x: s.input.activePointer.x, y: s.input.activePointer.y }
          : null;
      });

      expect(ptr).not.toBeNull();
      const dx = Math.abs(ptr.x - 960);
      const dy = Math.abs(ptr.y - 540);
      console.log(`  ${label} サイクル${cycle}: pointer(${Math.round(ptr.x)},${Math.round(ptr.y)}) dx=${dx.toFixed(1)} dy=${dy.toFixed(1)} ${dx<=5&&dy<=5?'✓':'⚠'}`);
      expect(dx, `${label} cycle${cycle} dx`).toBeLessThanOrEqual(5);
      expect(dy, `${label} cycle${cycle} dy`).toBeLessThanOrEqual(5);
    }
  }
  console.log('  → シナリオB PASS ✓');
});

// ─── シナリオC: visibilitychange後の pointer 座標 ──────────

test('[シナリオC] visibilitychange復帰後のpointer座標 ±10px以内', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => {
    window._phaserGame.scene.start('MainScene', { premises_index: 1 });
  });
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  // シナリオA と同様の縮小→復帰サイクル
  await page.setViewportSize(SHRUNK_VP);
  await page.waitForTimeout(200);
  await fireVisibility(page, 'hidden');
  await page.setViewportSize(NORMAL_VP);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(1200);

  // canvas 中央をタップ
  const ds = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    const r  = document.querySelector('#game_app canvas').getBoundingClientRect();
    return { dsX: sc.displayScale.x, dsY: sc.displayScale.y,
             cssLeft: r.left, cssTop: r.top, cssW: r.width, cssH: r.height };
  });
  const tapX = Math.round(ds.cssLeft + ds.cssW / 2);
  const tapY = Math.round(ds.cssTop  + ds.cssH / 2);
  await page.touchscreen.tap(tapX, tapY);
  await page.waitForTimeout(150);

  const ptr = await page.evaluate(() => {
    const s = window._phaserGame.scene.getScene('MainScene');
    return s?.input?.activePointer
      ? { x: s.input.activePointer.x, y: s.input.activePointer.y }
      : null;
  });
  expect(ptr).not.toBeNull();
  const dx = Math.abs(ptr.x - 960);
  const dy = Math.abs(ptr.y - 540);
  console.log(`\n[シナリオC] 中央タップ pointer: (${Math.round(ptr.x)}, ${Math.round(ptr.y)})  dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
  expect(dx, `dx=${dx.toFixed(1)}`).toBeLessThanOrEqual(10);
  expect(dy, `dy=${dy.toFixed(1)}`).toBeLessThanOrEqual(10);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });
  console.log('  → シナリオC PASS ✓');
});

// ─── シナリオD: ファイルピッカー中はリセットしない ──────

test('[シナリオD] _filePicking=true の時 visibilitychange でreset抑制', async ({ page }) => {
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

  // resize が dispatch されたとしても resize handler(300ms) + バッファ = 600ms 待機
  await page.waitForTimeout(800);

  const after = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { left: sc.canvasBounds.left, top: sc.canvasBounds.top,
             w: sc.canvasBounds.width,   h: sc.canvasBounds.height };
  });
  console.log(`\n[シナリオD] before: ${JSON.stringify(before)}`);
  console.log(`            after : ${JSON.stringify(after)}`);
  expect(after.left).toBe(before.left);
  expect(after.top).toBe(before.top);
  expect(after.w).toBe(before.w);
  expect(after.h).toBe(before.h);

  // changeイベントでフラグ解除確認
  await page.evaluate(() => {
    document.getElementById('_test_file_inp')?.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(1200);

  // フラグ解除後は visible で resize が dispatch される
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(900);

  const afterReset = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { w: sc.canvasBounds.width, h: sc.canvasBounds.height };
  });
  console.log(`  フラグ解除後: w=${afterReset.w} h=${afterReset.h}  ${afterReset.w > 0 ? '✓' : '⚠'}`);
  expect(afterReset.w).toBeGreaterThan(0);

  await page.evaluate(() => {
    document.getElementById('_test_file_inp')?.remove();
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });
  console.log('  → シナリオD PASS ✓');
});
