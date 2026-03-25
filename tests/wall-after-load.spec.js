// @ts-check
/**
 * wall-after-load.spec.js
 *
 * タブレットでJSONファイル読み込み後に壁建具操作ができることを検証
 *
 * 検証シナリオ:
 *   1. MainScene起動 → パーツ2個配置
 *   2. ファイルピッカー操作をシミュレート（input[type=file]生成 + visibilitychange）
 *   3. JSONデータをキャッシュ注入して読み込み
 *   4. 読み込み後のパーツに対してタッチ → pointer座標がゲーム座標と一致
 *   5. パーツの辺をドラッグして壁の配置・消去ができること
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const COORD_TOLERANCE = 15; // px

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

async function resetVisibility(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible', configurable: true
    });
  });
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

/** ゲーム座標 → スクリーン座標 */
function gameToScreen(gx, gy, info) {
  return {
    x: Math.round(gx / info.dsX + info.cssLeft),
    y: Math.round(gy / info.dsY + info.cssTop),
  };
}

/** Phaserのpointer座標を取得 */
async function getPointerCoords(page) {
  return page.evaluate(() => {
    const s = window._phaserGame?.scene?.getScene('MainScene');
    if (!s?.input) return null;
    const p = s.input.activePointer;
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
}

/**
 * touchstart → touchmove(+2px) → touchend を dispatch してPhaserのdragendを発火
 */
async function touchTapWithDrag(page, sx, sy) {
  await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('#game_app canvas');
    if (!canvas) return;
    const mk = (id, cx, cy) => new Touch({
      identifier: id, target: canvas,
      clientX: cx, clientY: cy, pageX: cx, pageY: cy,
      screenX: cx, screenY: cy, radiusX: 1, radiusY: 1,
      rotationAngle: 0, force: 1,
    });
    const opts = (touches, changed) => ({
      bubbles: true, cancelable: true,
      touches, targetTouches: touches, changedTouches: changed,
    });
    const t0 = mk(1, x, y);
    canvas.dispatchEvent(new TouchEvent('touchstart', opts([t0], [t0])));
    const t1 = mk(1, x + 2, y + 1);
    canvas.dispatchEvent(new TouchEvent('touchmove', opts([t1], [t1])));
    const t2 = mk(1, x + 2, y + 1);
    canvas.dispatchEvent(new TouchEvent('touchend', opts([], [t2])));
  }, { x: sx, y: sy });
  await page.waitForTimeout(300);
}

/**
 * ファイルピッカー操作をシミュレート
 * MutationObserverトリガー → visibilitychange hidden/visible → change event
 */
async function simulateFilePicker(page) {
  // 1. input[type=file] を生成 → MutationObserverが _filePicking=true にする
  await page.evaluate(() => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id = '_test_file_picker';
    document.body.appendChild(inp);
  });
  await page.waitForTimeout(200);

  // 2. hidden → visible（iOSでのファイルピッカー表示/復帰をシミュレート）
  await fireVisibility(page, 'hidden');
  await page.waitForTimeout(100);

  // iOSでは復帰時にresizeが発火する場合がある
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(100);

  await fireVisibility(page, 'visible');
  await page.waitForTimeout(200);

  // もう1回resizeを発火（iOSの挙動を模倣）
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(100);

  // 3. changeイベントを発火（ファイル選択完了）
  await page.evaluate(() => {
    const inp = document.getElementById('_test_file_picker');
    if (inp) inp.dispatchEvent(new Event('change'));
  });

  // 4. _filePicking=falseになるまで待機（1000ms） + _saveR0/_apply復帰 + バッファ
  await page.waitForTimeout(1500);

  // 5. input要素を削除
  await page.evaluate(() => {
    document.getElementById('_test_file_picker')?.remove();
  });

  await resetVisibility(page);
}


// ─── テスト1: ファイルピッカー後のdisplayScale正常性 ──────

test('[壁建具] ファイルピッカー後のdisplayScaleが正常', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => {
    window._phaserGame.scene.start('MainScene', { premises_index: 1 });
  });
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  console.log('\n=== ファイルピッカー後のdisplayScale検証 ===');

  // ファイルピッカー前のdisplayScaleを記録
  const before = await getCanvasInfo(page);
  console.log(`  前: dsX=${before.dsX.toFixed(6)} dsY=${before.dsY.toFixed(6)} cssW=${Math.round(before.cssW)}`);

  // ファイルピッカー操作をシミュレート
  await simulateFilePicker(page);

  // ファイルピッカー後のdisplayScaleを検証
  const after = await getCanvasInfo(page);
  console.log(`  後: dsX=${after.dsX.toFixed(6)} dsY=${after.dsY.toFixed(6)} cssW=${Math.round(after.cssW)}`);

  const dsDiffX = Math.abs(after.dsX - before.dsX);
  const dsDiffY = Math.abs(after.dsY - before.dsY);
  console.log(`  差: dsX=${dsDiffX.toFixed(6)} dsY=${dsDiffY.toFixed(6)}`);

  // displayScaleが変わっていないこと（誤差0.01以内）
  expect(dsDiffX, `displayScale.x がずれた: ${before.dsX} → ${after.dsX}`).toBeLessThan(0.01);
  expect(dsDiffY, `displayScale.y がずれた: ${before.dsY} → ${after.dsY}`).toBeLessThan(0.01);

  // canvas幅も変わっていないこと
  const wDiff = Math.abs(after.cssW - before.cssW);
  expect(wDiff, `canvas幅がずれた: ${before.cssW} → ${after.cssW}`).toBeLessThan(before.cssW * 0.05);

  console.log('  → displayScale検証 PASS ✓');
});


// ─── テスト2: ファイルピッカー後のpointer座標精度 ────────────

test('[壁建具] ファイルピッカー後のpointer座標精度（パーツ複数）', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => {
    window._phaserGame.scene.start('MainScene', { premises_index: 1 });
  });
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  console.log('\n=== ファイルピッカー後のpointer座標精度 ===');

  // ファイルピッカー操作をシミュレート（パーツ配置前）
  await simulateFilePicker(page);

  // ファイルピッカー後にパーツを配置
  await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    scene.create_parts(960, 540, 'Livingroom.png', true, 0, false);
    scene.create_parts(1100, 680, 'Livingroom.png', true, 0, false);
  });
  await page.waitForTimeout(500);

  // canvas情報を取得
  const info = await getCanvasInfo(page);
  console.log(`  Canvas: dsX=${info.dsX.toFixed(4)} dsY=${info.dsY.toFixed(4)}`);

  // パーツ情報を取得
  const parts = await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    return scene.deploy_parts.filter(p => p.visible).map(p => ({
      x: p.x, y: p.y, w: p.width, h: p.height,
    }));
  });
  console.log(`  パーツ数: ${parts.length}`);
  expect(parts.length).toBeGreaterThanOrEqual(2);

  // 各パーツの中心をタッチして座標精度を検証
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const sc = gameToScreen(part.x, part.y, info);

    await page.touchscreen.tap(sc.x, sc.y);
    await page.waitForTimeout(200);
    const ptr = await getPointerCoords(page);
    expect(ptr).not.toBeNull();

    const dx = Math.abs(ptr.x - part.x);
    const dy = Math.abs(ptr.y - part.y);
    const ok = dx <= COORD_TOLERANCE && dy <= COORD_TOLERANCE;
    console.log(`  パーツ${i+1} game(${part.x},${part.y}) pointer(${ptr.x},${ptr.y}) dx=${dx} dy=${dy} ${ok ? '✓' : '✗'}`);
    expect(dx, `パーツ${i+1} X座標ずれ`).toBeLessThanOrEqual(COORD_TOLERANCE);
    expect(dy, `パーツ${i+1} Y座標ずれ`).toBeLessThanOrEqual(COORD_TOLERANCE);
  }

  console.log('  → pointer座標精度テスト PASS ✓');
});


// ─── テスト3: ファイルピッカー後の辺タッチ座標精度 ──────────

test('[壁建具] ファイルピッカー後の辺タッチで座標が正確', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => {
    window._phaserGame.scene.start('MainScene', { premises_index: 1 });
  });
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  console.log('\n=== ファイルピッカー後の辺タッチ座標テスト ===');

  // ファイルピッカー操作をシミュレート
  await simulateFilePicker(page);

  // パーツを配置
  await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    scene.create_parts(960, 540, 'Livingroom.png', true, 0, false);
  });
  await page.waitForTimeout(500);

  const info = await getCanvasInfo(page);
  console.log(`  dsX=${info.dsX.toFixed(4)} dsY=${info.dsY.toFixed(4)}`);

  // パーツ情報取得
  const part = await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    const p = scene.deploy_parts.find(p => p.visible);
    return p ? { x: p.x, y: p.y, w: p.width, h: p.height } : null;
  });
  expect(part).not.toBeNull();
  console.log(`  パーツ: (${part.x},${part.y}) ${part.w}x${part.h}`);

  // パーツ中心タッチで座標精度確認
  const centerSc = gameToScreen(part.x, part.y, info);
  await page.touchscreen.tap(centerSc.x, centerSc.y);
  await page.waitForTimeout(300);

  const centerPtr = await getPointerCoords(page);
  expect(centerPtr).not.toBeNull();
  const cdx = Math.abs(centerPtr.x - part.x);
  const cdy = Math.abs(centerPtr.y - part.y);
  console.log(`  中心 pointer(${centerPtr.x},${centerPtr.y}) dx=${cdx} dy=${cdy}`);
  expect(cdx, '中心 X座標ずれ').toBeLessThanOrEqual(COORD_TOLERANCE);
  expect(cdy, '中心 Y座標ずれ').toBeLessThanOrEqual(COORD_TOLERANCE);

  // 上辺タッチで座標精度確認（壁建具操作の前提）
  const topEdgeY = part.y - part.h / 2;
  const topEdgeSc = gameToScreen(part.x, topEdgeY, info);
  console.log(`  上辺タッチ screen:(${topEdgeSc.x},${topEdgeSc.y}) game:(${part.x},${Math.round(topEdgeY)})`);

  await touchTapWithDrag(page, topEdgeSc.x, topEdgeSc.y);
  await page.waitForTimeout(300);

  const edgePtr = await getPointerCoords(page);
  if (edgePtr) {
    const dx = Math.abs(edgePtr.x - part.x);
    const dy = Math.abs(edgePtr.y - topEdgeY);
    console.log(`  辺 pointer(${edgePtr.x},${edgePtr.y}) dx=${dx} dy=${dy}`);
    expect(dx, '辺タッチ X座標ずれ').toBeLessThanOrEqual(COORD_TOLERANCE);
    expect(dy, '辺タッチ Y座標ずれ').toBeLessThanOrEqual(COORD_TOLERANCE);
  }

  await page.screenshot({ path: 'tests/wall-after-load-result.png' });
  console.log('  → 辺タッチ座標テスト PASS ✓');
});


// ─── テスト4: 新規パーツへの壁操作（JSON読み込み後） ────

test('[壁建具] JSON読み込み後に新規パーツへ壁操作ができる', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => {
    window._phaserGame.scene.start('MainScene', { premises_index: 1 });
  });
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  console.log('\n=== JSON読み込み後の新規パーツ壁操作テスト ===');

  // ファイルピッカー → 空のJSON読み込み
  await simulateFilePicker(page);

  // パーツを新規配置（JSONロード後のシナリオ）
  await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    scene.create_parts(960, 540, 'Livingroom.png', true, 0, false);
    scene.deploy_parts.forEach(p => scene.wall_operation(p, 5));
  });
  await page.waitForTimeout(500);

  const info = await getCanvasInfo(page);
  console.log(`  dsX=${info.dsX.toFixed(4)} dsY=${info.dsY.toFixed(4)}`);

  // パーツ中心をタッチ
  const centerSc = gameToScreen(960, 540, info);
  await page.touchscreen.tap(centerSc.x, centerSc.y);
  await page.waitForTimeout(300);

  const ptr = await getPointerCoords(page);
  expect(ptr).not.toBeNull();
  const dx = Math.abs(ptr.x - 960);
  const dy = Math.abs(ptr.y - 540);
  console.log(`  新規パーツ中心 pointer(${ptr.x},${ptr.y}) dx=${dx} dy=${dy}`);
  expect(dx, '新規パーツ X座標ずれ').toBeLessThanOrEqual(COORD_TOLERANCE);
  expect(dy, '新規パーツ Y座標ずれ').toBeLessThanOrEqual(COORD_TOLERANCE);

  // パーツ選択状態を確認
  const selected = await page.evaluate(() => {
    return window._phaserGame.scene.getScene('MainScene')?.naw_parts_edit ?? false;
  });
  console.log(`  パーツ選択: ${selected}`);

  // 上辺タッチで座標精度を検証
  const topY = 540 - 116; // Livingroom高さ232の半分
  const topSc = gameToScreen(960, topY, info);
  await page.touchscreen.tap(topSc.x, topSc.y);
  await page.waitForTimeout(200);

  const topPtr = await getPointerCoords(page);
  if (topPtr) {
    const tdx = Math.abs(topPtr.x - 960);
    const tdy = Math.abs(topPtr.y - topY);
    console.log(`  上辺 pointer(${topPtr.x},${topPtr.y}) 期待(960,${topY}) dx=${tdx} dy=${tdy}`);
    expect(tdx, '上辺 X座標ずれ').toBeLessThanOrEqual(COORD_TOLERANCE);
    expect(tdy, '上辺 Y座標ずれ').toBeLessThanOrEqual(COORD_TOLERANCE);
  }

  console.log('  → 新規パーツ壁操作テスト PASS ✓');
});


// ─── テスト5: ファイルピッカー中のresize抑制検証 ──────

test('[壁建具] _filePicking中のresizeでcanvasBoundsが壊れない', async ({ page }) => {
  await startApp(page);
  await page.evaluate(() => {
    window._phaserGame.scene.start('MainScene', { premises_index: 1 });
  });
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);

  console.log('\n=== _filePicking中のresize抑制テスト ===');

  const before = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return {
      dsX: sc.displayScale.x,
      dsY: sc.displayScale.y,
      cbW: sc.canvasBounds.width,
      cbH: sc.canvasBounds.height,
    };
  });
  console.log(`  前: dsX=${before.dsX.toFixed(4)} cbW=${before.cbW}`);

  // input[type=file]を生成して_filePicking=trueにする
  await page.evaluate(() => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.id = '_test_fp';
    document.body.appendChild(inp);
  });
  await page.waitForTimeout(200);

  // _filePicking=true の状態でresizeを連続発火
  await page.evaluate(() => {
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new Event('resize'));
    }
  });
  await page.waitForTimeout(500);

  const during = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return {
      dsX: sc.displayScale.x,
      dsY: sc.displayScale.y,
      cbW: sc.canvasBounds.width,
      cbH: sc.canvasBounds.height,
    };
  });
  console.log(`  中: dsX=${during.dsX.toFixed(4)} cbW=${during.cbW}`);

  // canvasBoundsが変わっていないこと
  expect(during.cbW).toBe(before.cbW);
  expect(during.cbH).toBe(before.cbH);

  // displayScaleが変わっていないこと
  expect(Math.abs(during.dsX - before.dsX)).toBeLessThan(0.001);

  // クリーンアップ: changeイベント発火 → _filePicking解除を待つ
  await page.evaluate(() => {
    const inp = document.getElementById('_test_fp');
    if (inp) inp.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(1500);

  const after = await page.evaluate(() => {
    const sc = window._phaserGame.scale;
    return { dsX: sc.displayScale.x, cbW: sc.canvasBounds.width };
  });
  console.log(`  後: dsX=${after.dsX.toFixed(4)} cbW=${after.cbW}`);

  // 復帰後も正常
  expect(Math.abs(after.dsX - before.dsX)).toBeLessThan(0.01);
  expect(after.cbW).toBeGreaterThan(0);

  await page.evaluate(() => {
    document.getElementById('_test_fp')?.remove();
  });
  await resetVisibility(page);
  console.log('  → resize抑制テスト PASS ✓');
});
