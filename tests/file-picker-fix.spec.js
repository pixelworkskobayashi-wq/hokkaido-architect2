// @ts-check
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
}

async function startMainScene(page, premisesIndex = 1) {
  await startApp(page);
  await page.evaluate((idx) => {
    window._phaserGame.scene.start('MainScene', { premises_index: idx });
  }, premisesIndex);
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);
}

/** visibilityState を上書きしてイベント発火 */
async function fireVisibility(page, state) {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { get: () => s, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** canvasBounds スナップショット */
async function snapBounds(page) {
  return page.evaluate(() => {
    const sc = window._phaserGame.scale;
    const r  = document.querySelector('#game_app canvas').getBoundingClientRect();
    return { left: sc.canvasBounds.left, top: sc.canvasBounds.top,
             w: sc.canvasBounds.width,   h: sc.canvasBounds.height,
             cssW: r.width };
  });
}

// ─── シナリオA：アプリスイッチャーシミュレーション ─────────

test('[シナリオA] visibilitychange visible → _resetOnForeground が実行される', async ({ page }) => {
  await startMainScene(page);

  // scale.refresh スパイ設置
  await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    sc._refreshCount = 0;
    const orig = sc.refresh.bind(sc);
    sc.refresh = function(){ sc._refreshCount++; orig(); };
  });

  const before = await snapBounds(page);

  // hidden → visible（_filePicking=false の通常復帰）
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');

  // 500ms タイムアウト + バッファ
  await page.waitForTimeout(700);

  const refreshCount = await page.evaluate(() => window._phaserGame.scale._refreshCount);
  console.log(`\n[シナリオA] scale.refresh呼び出し回数: ${refreshCount}  ${refreshCount >= 1 ? '→ _resetOnForeground実行 ✓' : '→ 未実行 ⚠'}`);
  expect(refreshCount).toBeGreaterThanOrEqual(1);

  // canvasBoundsが存在すること（リセット後も正常値）
  const after = await snapBounds(page);
  console.log(`  canvasBounds after: left=${after.left} top=${after.top} w=${after.w} h=${after.h}`);
  expect(after.w).toBeGreaterThan(0);
  expect(after.h).toBeGreaterThan(0);

  // pointer座標ズレ確認（canvas中央タップ）
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
    return s?.input?.activePointer ? { x: s.input.activePointer.x, y: s.input.activePointer.y } : null;
  });
  if (ptr) {
    // 中央タップ → ゲーム座標は約(960, 540)
    const distX = Math.abs(ptr.x - 960);
    const distY = Math.abs(ptr.y - 540);
    console.log(`  中央タップ pointer: (${Math.round(ptr.x)}, ${Math.round(ptr.y)})  期待値: (960, 540)  dx=${distX.toFixed(1)} dy=${distY.toFixed(1)}`);
    expect(distX).toBeLessThanOrEqual(10);
    expect(distY).toBeLessThanOrEqual(10);
  }

  console.log('  → シナリオA PASS ✓');
});

// ─── シナリオB：ファイルピッカーシミュレーション ──────────

test('[シナリオB] MutationObserver検知→_filePicking=true→visibilitychangeでr0保護', async ({ page }) => {
  await startMainScene(page);

  // scale.refresh スパイ設置
  await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    sc._refreshCount = 0;
    const orig = sc.refresh.bind(sc);
    sc.refresh = function(){ sc._refreshCount++; orig(); };
  });

  const before = await snapBounds(page);

  // input[type=file] を動的に追加（MutationObserver がトリガー）
  await page.evaluate(() => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id = '_test_file_inp';
    document.body.appendChild(inp);
  });
  await page.waitForTimeout(100); // MutationObserver のコールバック待ち

  // _filePicking が true になったことを間接確認:
  // hidden → visible を発火しても _resetOnForeground が呼ばれないこと
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(700);

  const refreshAfterFilePicking = await page.evaluate(() => window._phaserGame.scale._refreshCount);
  console.log(`\n[シナリオB] ファイルピッカー中のrefresh呼び出し: ${refreshAfterFilePicking}  ${refreshAfterFilePicking === 0 ? '→ r0保護 ✓' : '→ 保護失敗 ⚠'}`);
  expect(refreshAfterFilePicking).toBe(0);

  const afterFilePick = await snapBounds(page);
  expect(afterFilePick.left).toBe(before.left);
  expect(afterFilePick.top).toBe(before.top);
  console.log(`  canvasBounds 変化なし ✓`);

  // changeイベントを発火 → 1秒後に _filePicking=false になることを確認
  // （_filePicking=falseになった後にvisibilitychangeを発火すると_resetOnForegroundが動く）
  await page.evaluate(() => {
    const inp = document.getElementById('_test_file_inp');
    if(inp) inp.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(1200); // 1000ms タイマー + バッファ

  // この時点で _filePicking は false のはず。visibilitychange を再発火。
  await page.evaluate(() => window._phaserGame.scale._refreshCount = 0);
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(700);

  const refreshAfterReset = await page.evaluate(() => window._phaserGame.scale._refreshCount);
  console.log(`  change後のrefresh呼び出し: ${refreshAfterReset}  ${refreshAfterReset >= 1 ? '→ フラグ解除確認 ✓' : '→ フラグ未解除 ⚠'}`);
  expect(refreshAfterReset).toBeGreaterThanOrEqual(1);

  // クリーンアップ
  await page.evaluate(() => {
    const inp = document.getElementById('_test_file_inp');
    if(inp) inp.remove();
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });

  console.log('  → シナリオB PASS ✓');
});

// ─── シナリオC：JSONロード後の壁建具タッチ操作 ───────────

test('[シナリオC] JSON読み込み後の4辺タッチでpointer座標ズレ10px以内', async ({ page }) => {
  await startMainScene(page);

  const jsonData = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  await page.evaluate((data) => {
    window._phaserGame.cache.json.add('load_json_data', data);
  }, jsonData);
  await page.evaluate(() => {
    window._phaserGame.scene.getScene('MainScene').scene.restart();
  });
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(2000);

  const partInfo = await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    if (!scene?.deploy_parts?.length) return null;
    const p = scene.deploy_parts[0];
    if (!p || !p.visible) return null;
    const edges = scene.image_edge_point(p);
    return {
      x: p.x, y: p.y, w: p.width, h: p.height,
      topMid:    { x: (edges[0].x + edges[1].x) / 2, y: (edges[0].y + edges[1].y) / 2 },
      rightMid:  { x: (edges[1].x + edges[2].x) / 2, y: (edges[1].y + edges[2].y) / 2 },
      bottomMid: { x: (edges[2].x + edges[3].x) / 2, y: (edges[2].y + edges[3].y) / 2 },
      leftMid:   { x: (edges[3].x + edges[0].x) / 2, y: (edges[3].y + edges[0].y) / 2 },
    };
  });
  expect(partInfo).not.toBeNull();
  console.log(`\n[シナリオC] パーツ: (${partInfo.x}, ${partInfo.y})  ${partInfo.w}x${partInfo.h}`);

  const st = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    const r  = document.querySelector('#game_app canvas').getBoundingClientRect();
    return { dsX: sc.displayScale.x, dsY: sc.displayScale.y, cssLeft: r.left, cssTop: r.top };
  });
  console.log(`  displayScale: (${st.dsX.toFixed(6)}, ${st.dsY.toFixed(6)})`);

  const sides = [
    ['上辺', partInfo.topMid],
    ['右辺', partInfo.rightMid],
    ['下辺', partInfo.bottomMid],
    ['左辺', partInfo.leftMid],
  ];
  console.log('\n  辺       | game座標       | pointer        | dist');
  console.log('  ---------|----------------|----------------|-----');

  for (const [name, eg] of sides) {
    const sx = Math.round(eg.x / st.dsX + st.cssLeft);
    const sy = Math.round(eg.y / st.dsY + st.cssTop);
    await page.touchscreen.tap(sx, sy);
    await page.waitForTimeout(150);
    const ptr = await page.evaluate(() => {
      const s = window._phaserGame.scene.getScene('MainScene');
      return s?.input?.activePointer ? { x: s.input.activePointer.x, y: s.input.activePointer.y } : null;
    });
    expect(ptr).not.toBeNull();
    const dist = Math.sqrt((ptr.x - eg.x) ** 2 + (ptr.y - eg.y) ** 2);
    console.log(
      `  ${name.padEnd(5)}   | (${eg.x.toFixed(0)}, ${eg.y.toFixed(0)})`.padEnd(32) +
      `| (${Math.round(ptr.x)}, ${Math.round(ptr.y)})`.padEnd(17) +
      `| ${dist.toFixed(1)}px ${dist <= 10 ? '✓' : '⚠'}`
    );
    expect(dist, `${name}: ${dist.toFixed(1)}px`).toBeLessThanOrEqual(10);
  }
  console.log('  → シナリオC PASS ✓');
});

// ─── シナリオD：visibilitychange復帰後の画面縮小なし確認 ──

test('[シナリオD] visibilitychange復帰後にcanvasが縮小されていない', async ({ page }) => {
  // SelectionScene での確認
  await startApp(page);

  const initialW = await page.evaluate(() =>
    document.querySelector('#game_app canvas').getBoundingClientRect().width
  );
  console.log(`\n[シナリオD] SelectionScene canvas幅: ${initialW}px`);
  expect(initialW).toBeGreaterThan(0);

  // hidden → visible → canvas幅が正常値を維持
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(700);

  const afterW = await page.evaluate(() =>
    document.querySelector('#game_app canvas').getBoundingClientRect().width
  );
  console.log(`  復帰後 canvas幅: ${afterW}px  ${afterW >= initialW * 0.95 ? '→ 縮小なし ✓' : '→ 縮小あり ⚠'}`);
  expect(afterW).toBeGreaterThanOrEqual(initialW * 0.95);

  // MainScene 全3エリアでも確認
  const areas = [
    ['住宅', 1],
    ['郊外', 0],
    ['海岸', -1],
  ];
  for (const [label, idx] of areas) {
    await page.evaluate((i) => {
      window._phaserGame.scene.start('MainScene', { premises_index: i });
    }, idx);
    await waitForScene(page, 'MainScene');
    await page.waitForTimeout(1000);

    const w0 = await page.evaluate(() =>
      document.querySelector('#game_app canvas').getBoundingClientRect().width
    );
    await fireVisibility(page, 'hidden');
    await page.waitForTimeout(50);
    await fireVisibility(page, 'visible');
    await page.waitForTimeout(700);

    const w1 = await page.evaluate(() =>
      document.querySelector('#game_app canvas').getBoundingClientRect().width
    );
    console.log(`  ${label} canvas: ${w0}px → ${w1}px  ${w1 >= w0 * 0.95 ? '✓' : '⚠'}`);
    expect(w1).toBeGreaterThanOrEqual(w0 * 0.95);
  }

  // visibilityState をリセット
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });

  console.log('  → シナリオD PASS ✓');
});
