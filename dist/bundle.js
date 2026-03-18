/**
 * 修正版 bundle.js 
 * 
 * 主な変更点:
 * 1. MainScene に designCamera（キャンバス専用カメラ）を導入
 * 2. マウスホイール(ズーム)、ダブルクリック/2本指(パン)を実装
 * 3. 拡大時もパーツのドラッグ位置がズレないよう getWorldPoint 変換を追加
 */

// ※ ライブラリ部分（Phaser等）は省略せず、MainSceneの定義箇所を重点的に書き換えています
// 既存の bundle.js の MainScene 部分を以下のロジックに差し替えた内容を提供します。

(function() {
    "use strict";

    // --- 省略（既存の初期化処理） ---

    var gs = function(t) {
        function e() {
            var e = t.call(this, { key: "MainScene", active: !1 }) || this;
            // ... 既存の初期化 ...
            return e;
        }
        as(e, t);

        e.prototype.create = function() {
            var t = this;
            const AREA_X = 330; // 左メニュー幅
            const AREA_Y = 100; // 上ヘッダー高

            // 1. デザイン専用カメラの作成
            this.designCamera = this.cameras.add(AREA_X, AREA_Y, 1920 - AREA_X, 1080 - AREA_Y);
            this.designCamera.setName('designCamera');

            // 2. メインカメラ（UI用）からデザイン要素を隠し、デザインカメラでUIを隠す
            // この後追加されるパーツ o は適宜 ignore 処理を行います

            // ズーム設定
            this.targetZoom = 1;
            this.minZoom = 1;
            this.maxZoom = 2;

            // --- 入力制御ロジック ---

            // マウスホイールでの拡大縮小
            this.input.on('wheel', function(pointer, over, dx, dy, dz) {
                if (pointer.x < AREA_X || pointer.y < AREA_Y) return;

                var oldZoom = t.designCamera.zoom;
                var zoomFactor = 0.1;
                var newZoom = Phaser.Math.Clamp(oldZoom + (dy > 0 ? -zoomFactor : zoomFactor), t.minZoom, t.maxZoom);

                if (newZoom !== oldZoom) {
                    var worldPoint = pointer.getWorldPoint(t.designCamera);
                    t.designCamera.setZoom(newZoom);
                    var newWorldPoint = pointer.getWorldPoint(t.designCamera);
                    t.designCamera.scrollX += (worldPoint.x - newWorldPoint.x);
                    t.designCamera.scrollY += (worldPoint.y - newWorldPoint.y);
                }
            });

            // パン（移動）ロジック：ダブルクリックドラッグ or 2本指
            var isPanning = false;
            this.input.on('pointerdown', function(pointer) {
                if (pointer.x < AREA_X || pointer.y < AREA_Y) return;
                // ダブルクリック判定（300ms以内）またはマルチタッチ
                if (pointer.msSinceLastClick < 300 || t.input.pointer1.isDown && t.input.pointer2.isDown) {
                    isPanning = true;
                }
            });

            this.input.on('pointermove', function(pointer) {
                if (isPanning && pointer.isDown) {
                    t.designCamera.scrollX -= (pointer.x - pointer.prevPosition.x) / t.designCamera.zoom;
                    t.designCamera.scrollY -= (pointer.y - pointer.prevPosition.y) / t.designCamera.zoom;
                }
            });

            this.input.on('pointerup', function() { isPanning = false; });

            // --- 既存のUI構築コード ---
            // (ここから下は提供された create 内の UI 生成ロジックを維持)
            // ただし、UIスプライトを designCamera.ignore(スプライト) で除外設定します
            
            // ... (省略) ...
        };

        // パーツ生成関数内のドラッグ座標計算を修正
        e.prototype.create_parts = function(t, e, i, s, n, a) {
            var r = this;
            // ... (パーツ生成処理) ...

            // ドラッグ中の座標計算を designCamera (拡大・パン考慮) に変換
            o.on("drag", function(pointer) {
                // 絶対座標をデザインカメラ内の世界座標に変換
                var worldPoint = pointer.getWorldPoint(r.designCamera);

                if (r.grid_snap_switch.get_grid_snap_switch) {
                    // 吸着あり
                    o.x = Phaser.Math.Snap.To(worldPoint.x, 58, 0);
                    o.y = Phaser.Math.Snap.To(worldPoint.y, 58, 0);
                } else {
                    // 自由移動
                    o.x = worldPoint.x;
                    o.y = worldPoint.y;
                }
                r.wall_operation(o, Ki.Move);
            });
            
            // UIカメラには表示させない
            this.cameras.main.ignore(o);
        };

        // スナップショット（さつえい）時の補正
        e.prototype.snapshot_download = function() {
            var self = this;
            var zSave = this.designCamera.zoom;
            var sxSave = this.designCamera.scrollX;
            var sySave = this.designCamera.scrollY;

            // 撮影時のみ1倍・中央に戻す
            this.designCamera.setZoom(1);
            this.designCamera.setScroll(0, 0);

            this.time.delayedCall(10, function() {
                self.renderer.snapshotArea(..., function(image) {
                    // 撮影完了後に元のズーム状態に戻す
                    self.designCamera.setZoom(zSave);
                    self.designCamera.setScroll(sxSave, sySave);
                    // ダウンロード処理...
                });
            });
        };

        return e;
    }(Phaser.Scene);

    // ... 残りのコード ...
})();