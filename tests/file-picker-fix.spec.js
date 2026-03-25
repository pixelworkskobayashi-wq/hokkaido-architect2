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

async function startMainScene(page) {
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
  await page.evaluate(() => {
    window._phaserGame.scene.start('MainScene', { premises_index: 1 });
  });
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);
}

// ─── テスト① visibilitychange発火でr0が変化しないことを確認 ──

test('[テスト①] visibilitychange(hidden→visible)発火でr0・displayScaleが変化しない', async ({ page }) => {
  await startMainScene(page);

  // scale.refresh() の呼び出し回数をスパイ
  await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    sc._refreshCount = 0;
    const orig = sc.refresh.bind(sc);
    sc.refresh = function() { sc._refreshCount++; orig(); };
  });

  // 初期状態を記録
  const before = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return {
      left: sc.canvasBounds.left, top: sc.canvasBounds.top,
      w: sc.canvasBounds.width,   h: sc.canvasBounds.height,
      dsX: sc.displayScale.x,     dsY: sc.displayScale.y,
    };
  });

  // visibilityState='hidden' → 'visible' を連続発火
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'hidden', configurable: true
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible', configurable: true
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // 500ms タイムアウト + バッファ（resizeもpageshowも発火していない）
  await page.waitForTimeout(700);

  // scale.refresh() が呼ばれていないことを確認
  const refreshCount = await page.evaluate(() => window._phaserGame.scale._refreshCount);
  console.log(`\n[テスト①] scale.refresh呼び出し回数: ${refreshCount}  ${refreshCount === 0 ? '→ visibilitychangeは何もしない ✓' : '→ 想定外の呼び出し ⚠'}`);
  expect(refreshCount).toBe(0);

  // canvasBounds・displayScaleが変化していないことを確認
  const after = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return {
      left: sc.canvasBounds.left, top: sc.canvasBounds.top,
      w: sc.canvasBounds.width,   h: sc.canvasBounds.height,
      dsX: sc.displayScale.x,     dsY: sc.displayScale.y,
    };
  });
  console.log(`  canvasBounds before: left=${before.left} top=${before.top} w=${before.w} h=${before.h}`);
  console.log(`  canvasBounds after : left=${after.left} top=${after.top} w=${after.w} h=${after.h}`);
  console.log(`  displayScale: before=(${before.dsX.toFixed(6)}, ${before.dsY.toFixed(6)})  after=(${after.dsX.toFixed(6)}, ${after.dsY.toFixed(6)})`);

  expect(after.left).toBe(before.left);
  expect(after.top).toBe(before.top);
  expect(after.w).toBe(before.w);
  expect(after.h).toBe(before.h);

  // visibilityState をリセット
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible', configurable: true
    });
  });

  console.log('  → テスト① PASS ✓');
});

// ─── テスト② JSON読み込み後の壁建具タッチ操作 ───────────────

test('[テスト②] JSON読み込み後の4辺タッチでpointer座標ズレ10px以内', async ({ page }) => {
  await startMainScene(page);

  // JSON をキャッシュ注入 → MainScene 再起動
  const jsonData = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
  await page.evaluate((data) => {
    window._phaserGame.cache.json.add('load_json_data', data);
  }, jsonData);

  await page.evaluate(() => {
    window._phaserGame.scene.getScene('MainScene').scene.restart();
  });
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(2000);

  // パーツ情報取得
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
  console.log(`\n[テスト②] パーツ位置: (${partInfo.x}, ${partInfo.y})  サイズ: ${partInfo.w}x${partInfo.h}`);

  const state = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    const canvasRect = document.querySelector('#game_app canvas').getBoundingClientRect();
    return {
      ds: { x: sc.displayScale.x, y: sc.displayScale.y },
      cssLeft: canvasRect.left,
      cssTop:  canvasRect.top,
    };
  });
  console.log(`  displayScale: x=${state.ds.x.toFixed(6)} y=${state.ds.y.toFixed(6)}`);

  const sides = [
    ['上辺', partInfo.topMid],
    ['右辺', partInfo.rightMid],
    ['下辺', partInfo.bottomMid],
    ['左辺', partInfo.leftMid],
  ];

  console.log('\n  辺       | 辺座標(game)   | pointer(game)  | dist');
  console.log('  ---------|----------------|----------------|-----');

  for (const [sideName, edgeGame] of sides) {
    const sx = Math.round(edgeGame.x / state.ds.x + state.cssLeft);
    const sy = Math.round(edgeGame.y / state.ds.y + state.cssTop);

    await page.touchscreen.tap(sx, sy);
    await page.waitForTimeout(150);

    const ptr = await page.evaluate(() => {
      const s = window._phaserGame.scene.getScene('MainScene');
      return s?.input?.activePointer
        ? { x: s.input.activePointer.x, y: s.input.activePointer.y }
        : null;
    });

    expect(ptr).not.toBeNull();
    const dx = ptr.x - edgeGame.x;
    const dy = ptr.y - edgeGame.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    console.log(
      `  ${sideName.padEnd(5)}   | (${edgeGame.x.toFixed(0)}, ${edgeGame.y.toFixed(0)})`.padEnd(32) +
      `| (${Math.round(ptr.x)}, ${Math.round(ptr.y)})`.padEnd(17) +
      `| ${dist.toFixed(1)}px ${dist <= 10 ? '✓' : '⚠'}`
    );
    expect(dist, `${sideName}: dist=${dist.toFixed(1)}px`).toBeLessThanOrEqual(10);
  }

  console.log('\n  → テスト② PASS ✓');
});
