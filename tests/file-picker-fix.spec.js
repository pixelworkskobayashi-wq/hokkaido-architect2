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

/** canvas の CSS 幅を返す */
async function canvasWidth(page) {
  return page.evaluate(() =>
    document.querySelector('#game_app canvas').getBoundingClientRect().width
  );
}

// ─── シナリオA：全シーン visibilitychange 復帰後の canvas 幅確認 ──

test('[シナリオA] visibilitychange復帰後に全シーンでcanvas幅が正常値を維持', async ({ page }) => {
  await startApp(page);

  // SelectionScene（またはTitleScene）で確認
  const selW = await canvasWidth(page);
  console.log(`\n[シナリオA] SelectionScene canvas幅: ${selW}px`);
  expect(selW).toBeGreaterThan(0);

  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(700);

  const selWAfter = await canvasWidth(page);
  console.log(`  復帰後: ${selWAfter}px  ${selWAfter >= selW * 0.95 ? '✓' : '⚠'}`);
  expect(selWAfter).toBeGreaterThanOrEqual(selW * 0.95);

  // MainScene 全3エリアで確認
  const areas = [['住宅', 1], ['郊外', 0], ['海岸', -1]];
  for (const [label, idx] of areas) {
    await page.evaluate((i) => {
      window._phaserGame.scene.start('MainScene', { premises_index: i });
    }, idx);
    await waitForScene(page, 'MainScene');
    await page.waitForTimeout(1000);

    const w0 = await canvasWidth(page);
    await fireVisibility(page, 'hidden');
    await page.waitForTimeout(50);
    await fireVisibility(page, 'visible');
    await page.waitForTimeout(700);
    const w1 = await canvasWidth(page);

    console.log(`  ${label} MainScene: ${w0}px → ${w1}px  ${w1 >= w0 * 0.95 ? '✓' : '⚠'}`);
    expect(w1, `${label}: canvas幅が縮小`).toBeGreaterThanOrEqual(w0 * 0.95);
  }

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });
  console.log('  → シナリオA PASS ✓');
});

// ─── シナリオB：JSONロード後の壁建具タッチ操作 ───────────

test('[シナリオB] JSON読み込み後の4辺タッチでpointer座標ズレ10px以内', async ({ page }) => {
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
      topMid:    { x: (edges[0].x + edges[1].x) / 2, y: (edges[0].y + edges[1].y) / 2 },
      rightMid:  { x: (edges[1].x + edges[2].x) / 2, y: (edges[1].y + edges[2].y) / 2 },
      bottomMid: { x: (edges[2].x + edges[3].x) / 2, y: (edges[2].y + edges[3].y) / 2 },
      leftMid:   { x: (edges[3].x + edges[0].x) / 2, y: (edges[3].y + edges[0].y) / 2 },
    };
  });
  expect(partInfo).not.toBeNull();

  const st = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    const r  = document.querySelector('#game_app canvas').getBoundingClientRect();
    return { dsX: sc.displayScale.x, dsY: sc.displayScale.y, cssLeft: r.left, cssTop: r.top };
  });
  console.log(`\n[シナリオB] displayScale: (${st.dsX.toFixed(6)}, ${st.dsY.toFixed(6)})`);
  console.log('  辺       | game座標       | pointer        | dist');
  console.log('  ---------|----------------|----------------|-----');

  const sides = [['上辺', partInfo.topMid], ['右辺', partInfo.rightMid],
                 ['下辺', partInfo.bottomMid], ['左辺', partInfo.leftMid]];
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
  console.log('  → シナリオB PASS ✓');
});

// ─── シナリオC：ファイルピッカー操作中のvisibilitychange保護 ──

test('[シナリオC] _filePicking=true の時 visibilitychange visible でr0が変化しない', async ({ page }) => {
  await startMainScene(page);

  const before = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { left: sc.canvasBounds.left, top: sc.canvasBounds.top,
             w: sc.canvasBounds.width,   h: sc.canvasBounds.height };
  });

  // MutationObserver をトリガー: input[type=file] を body に追加
  await page.evaluate(() => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id = '_test_file_inp';
    document.body.appendChild(inp);
  });
  await page.waitForTimeout(100);

  // _filePicking=true の状態で visibilitychange hidden→visible
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(700);

  const after = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { left: sc.canvasBounds.left, top: sc.canvasBounds.top,
             w: sc.canvasBounds.width,   h: sc.canvasBounds.height };
  });
  console.log(`\n[シナリオC] canvasBounds before: left=${before.left} top=${before.top} w=${before.w} h=${before.h}`);
  console.log(`            canvasBounds after : left=${after.left} top=${after.top} w=${after.w} h=${after.h}`);
  expect(after.left).toBe(before.left);
  expect(after.top).toBe(before.top);
  expect(after.w).toBe(before.w);
  expect(after.h).toBe(before.h);

  // changeイベントでフラグ解除 → その後は_resetOnForegroundが動く
  await page.evaluate(() => {
    const inp = document.getElementById('_test_file_inp');
    if (inp) inp.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(1200);

  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(50);
  await fireVisibility(page, 'visible');
  await page.waitForTimeout(700);

  const afterReset = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { w: sc.canvasBounds.width, h: sc.canvasBounds.height };
  });
  console.log(`  フラグ解除後 canvasBounds: w=${afterReset.w} h=${afterReset.h}  ${afterReset.w > 0 ? '(正常) ✓' : '⚠'}`);
  expect(afterReset.w).toBeGreaterThan(0);

  // クリーンアップ
  await page.evaluate(() => {
    const inp = document.getElementById('_test_file_inp');
    if (inp) inp.remove();
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });
  console.log('  → シナリオC PASS ✓');
});
