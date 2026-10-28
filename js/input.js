/* ============================================================
 * 《激光大师 · Master Laser》输入模块（input.js）
 * 职责：按住左半屏（翻盖）拖动开合——翻盖跟手：向右推 = 合上，向左拉 = 展开；
 *       横向移动累计修改 G.foldTarget（clamp 0..1）；
 *       方向键 ←/→ 持续微调（调试/无障碍），方向与拖翻盖一致。
 * 命中框 G.flapHit 由 render 每帧按左片投影发布；只读 CFG / G，不依赖其他模块。
 * ============================================================ */
(function () {
  'use strict';

  var KEY_SPEED = 1.4;   // 方向键 foldTarget 调整速度（全程 0→1 约 0.7s）

  var dragging = false;  // 是否处于拖拽
  var dragId = null;     // 拖拽的 pointerId
  var lastX = 0;         // 上次指针 x，自己算 dx（避免 movementX 兼容问题）
  var keyL = false;      // 方向键 ← 按住
  var keyR = false;      // 方向键 → 按住
  var canvas = null;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* render 首帧前还没有命中框，此时不拦截，保持可操作 */
  function onFlap(x, y) {
    var h = G.flapHit;
    if (!h) return true;
    return x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1;
  }

  /* 翻盖外缘在屏幕上的行程约为 单片宽 × DRAG_FLAP_SPAN，按它换算才跟手；拿不到宽度时退回视口宽 */
  function spanPx() {
    var h = G.flapHit;
    if (h && h.cw > 0) return h.cw * CFG.DRAG_FLAP_SPAN;
    return Math.max(1, G.W * 0.5);
  }

  function setCursor(c) { if (canvas && canvas.style.cursor !== c) canvas.style.cursor = c; }

  window.Input = {
    init: function () {
      canvas = document.getElementById('world');

      /* 只有按在翻盖上才开始拖拽；其他位置的按下不影响开合 */
      window.addEventListener('pointerdown', function (e) {
        if (dragging) return;   // 多指：只认第一根
        if (!onFlap(e.clientX, e.clientY)) return;
        dragging = true;
        dragId = e.pointerId;
        lastX = e.clientX;
        setCursor('grabbing');
      });

      window.addEventListener('pointermove', function (e) {
        if (!dragging) {
          if (e.pointerType === 'mouse') setCursor(onFlap(e.clientX, e.clientY) ? 'grab' : '');
          return;
        }
        if (e.pointerId !== dragId) return;
        if (typeof G.foldTarget === 'number') {
          var dx = e.clientX - lastX;
          G.foldTarget = clamp01(G.foldTarget - dx / spanPx());
        }
        lastX = e.clientX;
      });

      function endDrag(e) {
        if (!dragging || e.pointerId !== dragId) return;
        dragging = false;
        dragId = null;
        setCursor(onFlap(e.clientX, e.clientY) && e.pointerType === 'mouse' ? 'grab' : '');
        /* 铰链磁吸：松手时离端点够近就吸到端点，render 据 snapSeq 播回弹与闪光 */
        var t = G.foldTarget, z = CFG.SNAP_ZONE;
        if (typeof t === 'number' && (t < z || t > 1 - z)) {
          G.foldTarget = t < z ? 0 : 1;
          G.snapSeq = (G.snapSeq || 0) + 1;
        }
      }
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      window.addEventListener('blur', function () {
        dragging = false;
        dragId = null;
        keyL = false;
        keyR = false;
        setCursor('');
      });

      /* 方向键只记状态，调整在 update 里做 */
      window.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') keyL = true;
        else if (e.key === 'ArrowRight') keyR = true;
      });
      window.addEventListener('keyup', function (e) {
        if (e.key === 'ArrowLeft') keyL = false;
        else if (e.key === 'ArrowRight') keyR = false;
      });
    },

    update: function (dt) {
      if (typeof G.foldTarget !== 'number') return;
      if (dragging) return;   // 拖拽优先，键盘不叠加
      var v = 0;
      if (keyL) v += KEY_SPEED * dt;   // ← 把翻盖往左拉开
      if (keyR) v -= KEY_SPEED * dt;   // → 把翻盖往右推上
      if (v !== 0) G.foldTarget = clamp01(G.foldTarget + v);
    },
  };
})();
