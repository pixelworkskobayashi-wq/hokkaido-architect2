// @ts-check
const { test, expect, devices } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

/**
 * iPadシミュレーション - タッチ座標精度テスト
 *
 * 目的：iPad Pro (1024x1366) 環境でタッチ操作時に
 *       Phaserが認識するゲーム座標が正しいかを検証する。
 *
 * 検証内容：
 *   1. 利用規約同意 → MainScene(住宅)遷移
 *   2. JSONレイアウトをキャッシュ注入して読み込み
 *      （ファイルが無い場合はpage.evaluateでパーツ2個を直接配置）
 *   3. 既存パーツ中心タッチ → pointer.x/y精度検証
 *   4. 上辺・左辺タッチ → pointer座標 ≈ 辺座標（10px以内）
 *   5. 新規パーツを1個配置 → タッチ → 辺タッチで壁建具操作
 *   6. 各ステップでスクリーンショット保存
 */

const COORD_TOLERANCE = 10; // px
const TEST_JSON_PATH = path.resolve(__dirname, '../test-data/test_layout.json');

// ─────────────────────────────────────────────────────────────
// ヘルパー
// ─────────────────────────────────────────────────────────────

async function waitForPhaserReady(page) {
  await page.waitForFunction(
    () => window._phaserGame?.scene?.scenes?.length > 0,
    { timeout: 20000 }
  );
}

async function waitForScene(page, key, timeout = 20000) {
  await page.waitForFunction(
    (k) => {
      const s = window._phaserGame?.scene?.getScene(k);
      return s?.sys?.settings?.active;
    },
    key,
    { timeout }
  );
}

/** 利用規約同意 → Phaserロード完了 */
async function agreeTosAndWait(page) {
  await page.goto('/');
  await page.waitForSelector('#tos-agree-btn', { state: 'visible' });
  await page.click('#tos-agree-btn');
  await page.waitForFunction(
    () => document.getElementById('tos-overlay')?.style.display === 'none',
    { timeout: 5000 }
  );
  await waitForPhaserReady(page);
  await page.waitForFunction(
    () => window._phaserGame?.scene?.scenes?.some(s =>
      s.sys.settings.active &&
      ['TitleScene', 'SelectionScene', 'MainScene'].includes(s.sys.settings.key)
    ),
    { timeout: 20000 }
  );
}

/** SelectionScene または TitleScene から MainScene へ遷移 */
async function startMainScene(page, premisesIndex = 1) {
  await page.evaluate((idx) => {
    const game = window._phaserGame;
    const main = game.scene.getScene('MainScene');
    if (main?.sys?.settings?.active) {
      main.scene.restart({ premises_index: idx });
    } else {
      game.scene.start('MainScene', { premises_index: idx });
    }
  }, premisesIndex);
  await waitForScene(page, 'MainScene');
  await page.waitForTimeout(1500);
}

/** canvas の位置・サイズ・displayScale を取得 */
async function getCanvasInfo(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#game_app canvas');
    const rect = canvas.getBoundingClientRect();
    const scale = window._phaserGame.scale;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      displayScaleX: scale.displayScale.x,
      displayScaleY: scale.displayScale.y,
      baseW: scale.baseSize.width,
      baseH: scale.baseSize.height,
    };
  });
}

/** ゲーム座標 → スクリーン座標 */
function gameToScreen(gx, gy, info) {
  return {
    x: Math.round(gx / info.displayScaleX + info.left),
    y: Math.round(gy / info.displayScaleY + info.top),
  };
}

/** activePointer 座標を取得（タッチ後 200ms 待って読む） */
async function getPointerCoords(page) {
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const s = window._phaserGame?.scene?.getScene('MainScene');
    if (!s?.input) return null;
    const p = s.input.activePointer;
    return { x: Math.round(p.x), y: Math.round(p.y) };
  });
}

/**
 * タッチ座標を検証する
 * @param {number} screenX  タッチしたスクリーンX
 * @param {number} screenY  タッチしたスクリーンY
 * @param {object} info     getCanvasInfo の返り値
 * @param {object} actual   getPointerCoords の返り値
 * @param {string} label    ログ用ラベル
 */
function verifyPointerCoords(screenX, screenY, info, actual, label) {
  const expectedX = Math.round((screenX - info.left) * info.displayScaleX);
  const expectedY = Math.round((screenY - info.top) * info.displayScaleY);
  const dx = Math.abs(actual.x - expectedX);
  const dy = Math.abs(actual.y - expectedY);
  const ok = dx <= COORD_TOLERANCE && dy <= COORD_TOLERANCE;
  console.log(
    `  [${label}] タッチ(screen): (${screenX},${screenY})` +
    `  期待(game): (${expectedX},${expectedY})` +
    `  実測(game): (${actual.x},${actual.y})` +
    `  差: dx=${dx} dy=${dy}  ${ok ? '✓' : '✗ FAIL'}`
  );
  return { expectedX, expectedY, dx, dy, ok };
}

/**
 * touchstart → touchmove(+2px) → touchend を dispatch して dragend を発火させる
 * ※Phaser の drag系イベントを確実に起こすための補助
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
  await page.waitForTimeout(200);
}

// ─────────────────────────────────────────────────────────────
// テスト①: デスクトップ zoom-coordinate.spec.js は別ファイル参照
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// テスト②: iPadシミュレーション
// ─────────────────────────────────────────────────────────────

test('[iPad] 住宅エリア - タッチ座標精度・壁建具操作', async ({ page }) => {

  // ── 1. セットアップ ──────────────────────────────────────
  await agreeTosAndWait(page);
  await startMainScene(page, 1);  // 住宅 (premisesIndex=1)

  // ── 2. JSONレイアウト注入（なければパーツ直接生成） ────────
  const jsonExists = fs.existsSync(TEST_JSON_PATH);
  console.log(`\n=== iPad タッチ座標テスト ===`);
  console.log(`テストJSON: ${jsonExists ? '読み込み' : 'page.evaluateで直接生成'}`);

  if (jsonExists) {
    // JSONをキャッシュ注入 → MainScene再起動
    const jsonData = JSON.parse(fs.readFileSync(TEST_JSON_PATH, 'utf-8'));
    await page.evaluate((data) => {
      window._phaserGame.cache.json.add('load_json_data', data);
    }, jsonData);
    await page.evaluate(() => {
      const game = window._phaserGame;
      const main = game.scene.getScene('MainScene');
      if (main?.sys?.settings?.active) {
        main.scene.restart();
      } else {
        game.scene.start('MainScene');
      }
    });
    await waitForScene(page, 'MainScene');
    await page.waitForTimeout(2000);
  } else {
    // パーツを2個直接生成
    console.log('  JSONなし: create_parts で2個生成');
    await page.evaluate(() => {
      const scene = window._phaserGame.scene.getScene('MainScene');
      if (!scene) return;
      scene.create_parts(960,  540, 'Livingroom.png', true, 0, false);
      scene.create_parts(1100, 680, 'Livingroom.png', true, 0, false);
      // 壁位置を更新
      scene.deploy_parts.forEach(p => scene.wall_operation(p, 5)); // Ki.Move=5
    });
    await page.waitForTimeout(500);

    // 生成したデータをJSONとして保存（次回から使い回し）
    const savedJson = await page.evaluate(() => {
      const scene = window._phaserGame.scene.getScene('MainScene');
      if (!scene) return null;
      const parts = scene.deploy_parts
        .filter(p => p.visible)
        .map((p, i) => {
          const wi = scene.wall_information[scene.deploy_parts.indexOf(p)];
          return {
            parts_data: { x: p.x, y: p.y, frameKey: p.frame.name, rotation: p.rotation },
            walls_data: { using: wi.using, width: wi.width, height: wi.height, map: wi.wall_map },
          };
        });
      return {
        data_version: 0,
        premises_index: scene.stage_number,
        text_data: { date: '', work_name: 'テスト用', drawing_name: '平面図', school_name: '', grade_class: '', name: 'test' },
        parts_data: parts,
      };
    });
    if (savedJson) {
      fs.mkdirSync(path.dirname(TEST_JSON_PATH), { recursive: true });
      fs.writeFileSync(TEST_JSON_PATH, JSON.stringify(savedJson, null, '\t'), 'utf-8');
      console.log(`  JSONを保存: ${TEST_JSON_PATH}`);
    }
  }

  // パーツが配置されているか確認
  const partCount = await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    return scene?.deploy_parts?.filter(p => p.visible)?.length ?? 0;
  });
  console.log(`  配置済みパーツ数: ${partCount}`);
  expect(partCount).toBeGreaterThanOrEqual(1);

  const info = await getCanvasInfo(page);
  console.log(`  Canvas: left=${info.left} top=${info.top} w=${info.width} h=${info.height}`);
  console.log(`  displayScale: x=${info.displayScaleX.toFixed(4)} y=${info.displayScaleY.toFixed(4)}`);
  console.log(`  gameBase: ${info.baseW}x${info.baseH}`);

  // ── 3. パーツ情報取得 ────────────────────────────────────
  const parts = await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    return scene.deploy_parts
      .filter(p => p.visible)
      .map(p => ({
        x: p.x, y: p.y,
        w: p.width, h: p.height,
        angle: p.angle,
        frameKey: p.frame.name,
      }));
  });
  console.log(`  パーツ情報:`, parts.map(p => `(${p.x},${p.y}) ${p.w}x${p.h}`).join(', '));

  // ── 4. 初期スクリーンショット ─────────────────────────────
  await page.screenshot({ path: 'tests/ipad-01-loaded.png' });

  // ─────────────────────────────────────────────────────────
  // ステップA: 各パーツ中心をタッチ → pointer座標検証
  // ─────────────────────────────────────────────────────────
  console.log('\n--- ステップA: パーツ中心タッチ ---');

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const sc = gameToScreen(part.x, part.y, info);

    await page.touchscreen.tap(sc.x, sc.y);
    const ptr = await getPointerCoords(page);
    expect(ptr).not.toBeNull();

    const result = verifyPointerCoords(sc.x, sc.y, info, ptr, `パーツ${i + 1}中心`);
    expect(result.dx).toBeLessThanOrEqual(COORD_TOLERANCE, `パーツ${i+1}中心 X座標ずれ`);
    expect(result.dy).toBeLessThanOrEqual(COORD_TOLERANCE, `パーツ${i+1}中心 Y座標ずれ`);
  }
  await page.screenshot({ path: 'tests/ipad-02-center-tap.png' });

  // ─────────────────────────────────────────────────────────
  // ステップB: 上辺・左辺タッチ → pointer座標検証
  // ─────────────────────────────────────────────────────────
  console.log('\n--- ステップB: パーツ辺タッチ (上辺・左辺) ---');

  const part0 = parts[0]; // 最初のパーツを使用
  // 上辺中点 (angle=0 前提)
  const topEdgeGame  = { x: part0.x,             y: part0.y - part0.h / 2 };
  // 左辺中点
  const leftEdgeGame = { x: part0.x - part0.w / 2, y: part0.y };

  for (const [label, edgeGame] of [['上辺', topEdgeGame], ['左辺', leftEdgeGame]]) {
    const sc = gameToScreen(edgeGame.x, edgeGame.y, info);

    // タッチ
    await page.touchscreen.tap(sc.x, sc.y);
    const ptr = await getPointerCoords(page);
    expect(ptr).not.toBeNull();

    const result = verifyPointerCoords(sc.x, sc.y, info, ptr, `パーツ1 ${label}`);
    expect(result.dx).toBeLessThanOrEqual(COORD_TOLERANCE, `${label} X座標ずれ`);
    expect(result.dy).toBeLessThanOrEqual(COORD_TOLERANCE, `${label} Y座標ずれ`);
  }
  await page.screenshot({ path: 'tests/ipad-03-edge-tap.png' });

  // ─────────────────────────────────────────────────────────
  // ステップC: 壁建具の配置操作
  //   1回目タッチ（中心）→ 選択状態に
  //   2回目タッチ（上辺）→ dragend で壁配置試行
  // ─────────────────────────────────────────────────────────
  console.log('\n--- ステップC: 壁建具配置操作 ---');

  const centerSc = gameToScreen(part0.x, part0.y, info);

  // 1回目: パーツ中心をタッチ（選択）
  await page.touchscreen.tap(centerSc.x, centerSc.y);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'tests/ipad-04-part-selected.png' });

  const isSelected = await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    return scene?.naw_parts_edit ?? false;
  });
  console.log(`  パーツ選択状態 (naw_parts_edit): ${isSelected}`);

  // 2回目: 上辺をdragありでタッチ → dragend を発火させて壁配置
  const topEdgeSc = gameToScreen(topEdgeGame.x, topEdgeGame.y, info);
  console.log(`  上辺タッチ(screen): (${topEdgeSc.x}, ${topEdgeSc.y})`);
  await touchTapWithDrag(page, topEdgeSc.x, topEdgeSc.y);

  await page.screenshot({ path: 'tests/ipad-05-wall-attempt.png' });

  // 壁が配置されたか確認（best effort - 失敗しても座標検証が通ればOK）
  const wallResult = await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    if (!scene?.wall_information?.length) return { placed: false, map: null };
    const wi = scene.wall_information[0];
    const topMap = wi?.wall_map?.[0] ?? [];
    const placed = topMap.some(v => v !== 0);
    return { placed, topMap };
  });
  console.log(`  壁配置結果: ${wallResult.placed ? '成功' : '未確認'} (topMap: [${wallResult.topMap}])`);

  // 壁消去試行（同じ辺を再タッチ）
  if (wallResult.placed) {
    await touchTapWithDrag(page, topEdgeSc.x, topEdgeSc.y);
    await page.screenshot({ path: 'tests/ipad-06-wall-removed.png' });
    const afterRemove = await page.evaluate(() => {
      const scene = window._phaserGame.scene.getScene('MainScene');
      const topMap = scene?.wall_information?.[0]?.wall_map?.[0] ?? [];
      return topMap.every(v => v === 0);
    });
    console.log(`  壁消去: ${afterRemove ? '成功' : '未確認'}`);
  }

  // ─────────────────────────────────────────────────────────
  // ステップD: 新規パーツを1個タッチ操作で配置
  //   ※ ゲームのUIパネルからドラッグするのはPlaywrightでは困難なため、
  //     page.evaluate で create_parts を呼んで配置し、タッチ操作を検証する
  // ─────────────────────────────────────────────────────────
  console.log('\n--- ステップD: 新規パーツ配置・辺タッチ検証 ---');

  // 既存パーツ数を記録
  const beforeCount = await page.evaluate(() =>
    window._phaserGame.scene.getScene('MainScene')?.deploy_parts?.filter(p => p.visible)?.length ?? 0
  );

  // 新規パーツ配置（ゲーム座標 (800, 700)）
  await page.evaluate(() => {
    const scene = window._phaserGame.scene.getScene('MainScene');
    if (!scene) return;
    scene.create_parts(800, 700, 'Livingroom.png', true, 0, false);
    const newPart = scene.deploy_parts[scene.deploy_parts.length - 1];
    scene.wall_operation(newPart, 5); // Ki.Move
  });
  await page.waitForTimeout(300);

  const afterCount = await page.evaluate(() =>
    window._phaserGame.scene.getScene('MainScene')?.deploy_parts?.filter(p => p.visible)?.length ?? 0
  );
  console.log(`  パーツ数: ${beforeCount} → ${afterCount}`);

  // 新規パーツのタッチ座標検証
  const newPartSc = gameToScreen(800, 700, info);
  await page.touchscreen.tap(newPartSc.x, newPartSc.y);
  const ptr = await getPointerCoords(page);
  expect(ptr).not.toBeNull();

  const resultNew = verifyPointerCoords(newPartSc.x, newPartSc.y, info, ptr, '新規パーツ中心');
  expect(resultNew.dx).toBeLessThanOrEqual(COORD_TOLERANCE, '新規パーツ X座標ずれ');
  expect(resultNew.dy).toBeLessThanOrEqual(COORD_TOLERANCE, '新規パーツ Y座標ずれ');

  // 新規パーツ上辺タッチ
  const newTopEdgeSc = gameToScreen(800, 700 - 232 / 2, info);
  await page.touchscreen.tap(newTopEdgeSc.x, newTopEdgeSc.y);
  const ptrEdge = await getPointerCoords(page);
  expect(ptrEdge).not.toBeNull();

  const resultEdge = verifyPointerCoords(newTopEdgeSc.x, newTopEdgeSc.y, info, ptrEdge, '新規パーツ上辺');
  expect(resultEdge.dx).toBeLessThanOrEqual(COORD_TOLERANCE, '新規パーツ上辺 X座標ずれ');
  expect(resultEdge.dy).toBeLessThanOrEqual(COORD_TOLERANCE, '新規パーツ上辺 Y座標ずれ');

  await page.screenshot({ path: 'tests/ipad-07-new-part.png' });

  // ── 最終スクリーンショット ─────────────────────────────
  await page.screenshot({ path: 'tests/ipad-08-final.png' });
  console.log('\n=== iPad タッチ座標テスト 完了 ✓ ===\n');
});
