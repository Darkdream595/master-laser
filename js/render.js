/* ============================================================
 * render.js —— 渲染模块（三层画布 + 3D 翻盖）
 * bg 层（2D）：桌面背景 + 机身投影
 * gl 层（WebGL2，PhoneArt.drawGL）：3D 机身；屏幕内容来自两张离屏 2D 画布作贴图——
 *   arena = 战场（右内屏 / 合上时的外屏），hud = 左内屏
 * fx 层（2D）：暗角 + 拖拽提示；WebGL2 不可用时在此画平面降级版
 * 纪律：只读 CFG/G；G.W/G.H/G.AW/G.AH 仅由 resize() 写入；G.flapHit（左片屏幕命中框，供 input）每帧由 draw() 写入；不改任何规则数值
 * ============================================================ */
(function () {
  'use strict';

  let cvBg = null, cvGL = null, cvFx = null;
  let ctxBg = null, ctxFx = null;
  let W = 0, H = 0, dpr = 1;
  let timeAcc = 0;
  let L = null;                 // 手机布局（PhoneArt.layout），resize 重建
  let glOK = false;
  let arenaCv = null, hudCv = null;
  let lastSnap = 0, snapT = 9;  // 磁吸动画计时：snapSeq 变化时归零
  let centerX = -1;             // 手机包围盒中心 x，菜单时右移给窗口让位（平滑过渡）
  let yShift = 0;               // 竖屏菜单时手机上移量（平滑过渡）
  let Ld = null;                // 本帧绘制用布局：L 的副本，只有 y0 叠加了 yShift

  /* ---- 表现层常量（纯视觉，不进 CFG） ---- */
  const EMBER = '255,132,44';   // 光束辉光：漏出来的是熔金色的光液
  const FONT_SYS = "system-ui,'Microsoft YaHei','Segoe UI',sans-serif";
  const FONT_EMOJI = "emoji,'Segoe UI Emoji','Noto Color Emoji',sans-serif";
  const DPR_CAP = 2;
  const PAD = 44;               // 抖动时战场超绘边距（逻辑 px）
  const HAS_FILTER = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;
  const SHAKE_VIEW = 3;         // 超载时整屏晃动幅度 px（小幅，只为震感）
  const REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const AFTER_BLUR_PX = 8;      // 超载后遗症：整窗模糊峰值 px（糊到分不清形状，配合"全变炸弹"）
  const AFTER_BLUR_IN = 0.3;    // 淡入变糊 s
  const AFTER_BLUR_OUT = 0.5;   // 淡出恢复 s

  let blurNode = null;          // SVG feGaussianBlur：横向为主的运动模糊，作用于 bg/gl 画布
  let viewFxOn = false;
  let prevSX = 0, prevSY = 0;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function drawEmoji(ctx, ch, x, y, size, rot, alpha) {
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(rot);
    if (alpha != null) ctx.globalAlpha *= clamp(alpha, 0, 1);
    ctx.font = Math.max(1, size).toFixed(1) + 'px ' + FONT_EMOJI;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  }

  /* 径向发光球（光束根部/端部用，代替 shadowBlur） */
  function glowBall(ctx, x, y, r, k) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,248,' + 0.95 * k + ')');
    g.addColorStop(0.3, 'rgba(255,214,150,' + 0.6 * k + ')');
    g.addColorStop(0.65, 'rgba(' + EMBER + ',' + 0.24 * k + ')');
    g.addColorStop(1, 'rgba(' + EMBER + ',0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function lightBlob(ctx, x, y, r, color) {
    if (r <= 0) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  /* 两路相位错开的正弦，比随机抖更像马达震；强度随剩余时间线性收尾 */
  function buzzXY() {
    const left = G.buzzT || 0;
    if (left <= 0 || !L) return { x: 0, y: 0 };
    const k = left / CFG.BUZZ_TIME;
    const amp = CFG.BUZZ_AMP * k * (REDUCED_MOTION ? 0.2 : 1) * clamp(L.ph / 560, 0.5, 1);
    const ph = (CFG.BUZZ_TIME - left) * CFG.BUZZ_HZ * Math.PI * 2;
    return { x: Math.sin(ph) * amp, y: Math.sin(ph * 1.7 + 1.1) * amp * 0.35 };
  }

  function shakeXY(sk) {
    if (sk <= 0.05) return null;
    return { x: (Math.random() * 2 - 1) * sk, y: (Math.random() * 2 - 1) * sk };
  }

  /* ============================================================
   * 对外 API：init / resize / draw
   * ============================================================ */
  function init() {
    cvBg = document.getElementById('bg');
    cvGL = document.getElementById('gl');
    cvFx = document.getElementById('world');
    ctxBg = cvBg.getContext('2d');
    ctxFx = cvFx.getContext('2d');
    arenaCv = document.createElement('canvas');
    hudCv = document.createElement('canvas');
    try { glOK = PhoneArt.initGL(cvGL); } catch (e) { glOK = false; console.error(e); }
    if (!glOK) cvGL.style.display = 'none';   // 降级：机身改由 fx 层 2D 绘制
    blurNode = makeMotionBlur();
    resize();
  }

  /* CSS blur() 只能各向同性；运动模糊要横竖分开设 stdDeviation，只能借 SVG 滤镜 */
  function makeMotionBlur() {
    const NS = 'http://www.w3.org/2000/svg';
    try {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.position = 'absolute';
      const f = document.createElementNS(NS, 'filter');
      f.setAttribute('id', 'cp-mblur');
      f.setAttribute('color-interpolation-filters', 'sRGB');
      const b = document.createElementNS(NS, 'feGaussianBlur');
      b.setAttribute('stdDeviation', '0 0');
      f.appendChild(b);
      svg.appendChild(f);
      document.body.appendChild(svg);
      return b;
    } catch (e) { return null; }
  }

  /* 超载包络：开场 0.12s 冲满，最后 0.4s 收掉，避免硬切 */
  function overEnv() {
    if (!(G.overload > 0)) return 0;
    return clamp((G.overloadT || 0) / 0.12, 0, 1) * clamp(G.overload / 0.4, 0, 1);
  }

  /* 超载后遗症包络：G.blurT 从 OVERLOAD_BLUR_TIME 倒数到 0，开头淡入、结尾淡出 */
  function afterBlurEnv() {
    const T = CFG.OVERLOAD_BLUR_TIME;
    if (!(G.blurT > 0) || !(T > 0)) return 0;
    return clamp((T - G.blurT) / AFTER_BLUR_IN, 0, 1) * clamp(G.blurT / AFTER_BLUR_OUT, 0, 1);
  }

  /* 整屏震感：三层画布同步平移（不对齐会露出错位），bg/gl 叠运动模糊，模糊量跟本帧位移速度成正比。
   * 超载后遗症的整窗模糊也挂在这三层上：DOM 覆盖层（结算窗口）不受影响，仍然看得清 */
  function viewFx() {
    const e = G.state === 'playing' ? overEnv() : 0;
    const soft = afterBlurEnv();
    if (e <= 0 && soft <= 0) {
      if (!viewFxOn) return;
      viewFxOn = false;
      prevSX = prevSY = 0;
      cvBg.style.transform = cvGL.style.transform = cvFx.style.transform = '';
      cvBg.style.filter = cvGL.style.filter = cvFx.style.filter = '';
      return;
    }
    viewFxOn = true;
    let tf = '', motion = false;
    if (e > 0) {
      const amp = SHAKE_VIEW * e * (REDUCED_MOTION ? 0.2 : 1) * clamp(L.ph / 560, 0.5, 1);
      const sx = (Math.random() * 2 - 1) * amp, sy = (Math.random() * 2 - 1) * amp * 0.5;
      tf = 'translate3d(' + sx.toFixed(2) + 'px,' + sy.toFixed(2) + 'px,0)';
      if (blurNode) {
        /* 封顶 2.2px：再糊 HUD 数字就读不出来了 */
        const bx = Math.min(2.2, 0.5 * e + Math.abs(sx - prevSX) * 0.35), by = Math.min(1, 0.15 * e + Math.abs(sy - prevSY) * 0.3);
        blurNode.setAttribute('stdDeviation', bx.toFixed(2) + ' ' + by.toFixed(2));
        motion = true;
      }
      prevSX = sx; prevSY = sy;
    } else {
      prevSX = prevSY = 0;
    }
    cvBg.style.transform = cvGL.style.transform = cvFx.style.transform = tf;
    const blurCss = soft > 0 ? 'blur(' + (AFTER_BLUR_PX * soft).toFixed(2) + 'px)' : '';
    const motionLayers = glOK ? [cvBg, cvGL] : [cvBg, cvFx];
    const all = [cvBg, cvGL, cvFx];
    for (let i = 0; i < all.length; i++) {
      const m = motion && motionLayers.indexOf(all[i]) >= 0 ? 'url(#cp-mblur)' : '';
      all[i].style.filter = (m && blurCss) ? m + ' ' + blurCss : (m || blurCss);
    }
  }

  /* 左片在屏幕上的命中框：按着色器同一单点透视投影四角取包围盒，再并上铰链两侧。
   * 翻到侧立时投影只剩一条窄边，外扩 pad 保证手指抓得住 */
  function publishFlapHit(fr) {
    const D = L.ph * CFG.EYE_DIST_H, ex = centerX;
    const pts = PhoneArt.flapCorners(Ld, fr.hx, fr.psi);
    let x0 = fr.hx, x1 = fr.hx;
    for (let i = 0; i < pts.length; i++) {
      const sx = ex + (pts[i][0] - ex) * D / Math.max(1, D - pts[i][2]);
      if (sx < x0) x0 = sx;
      if (sx > x1) x1 = sx;
    }
    const pad = Math.max(18, L.cw * 0.12);
    const hit = G.flapHit || (G.flapHit = {});
    hit.x0 = x0 - pad; hit.x1 = x1 + pad * 0.5;
    hit.y0 = Ld.y0 - pad; hit.y1 = Ld.y0 + L.ph + pad;
    hit.cw = L.cw;
  }

  /* 竖屏菜单窗口底部占用的高度（窗口 + overlay 底部内边距 24 + 与手机的间隔 20）；
   * offsetHeight 在布局未变时只是读缓存，每帧读开销可忽略；拿不到元素或尚未布局时退回旧的 330 */
  let menuWinEl = null;
  function menuWinReserve() {
    menuWinEl = menuWinEl || document.querySelector('#overlay-menu .win');
    const h = menuWinEl ? menuWinEl.offsetHeight : 0;
    return h > 0 ? h + 44 : 330;
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    G.W = W;
    G.H = H;
    L = PhoneArt.layout(W, H);
    Ld = Object.assign({}, L);
    /* 战场按参考高度等比缩放：逻辑高恒为 ARENA_REF_H，物理数值在任何屏幕手感一致 */
    G.AH = CFG.ARENA_REF_H;
    G.AW = L.dispW * CFG.ARENA_REF_H / L.dispH;
    if (!ctxBg || !ctxFx) return;
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    fit(cvBg, ctxBg);
    fit(cvFx, ctxFx);
    PhoneArt.resizeGL(W, H, dpr);
    /* 贴图按 DPR 超采样，着色器里按 texel/px 补 mip 偏移 */
    const tw = Math.max(2, Math.round(L.dispW * dpr)), th = Math.max(2, Math.round(L.dispH * dpr));
    arenaCv.width = hudCv.width = tw;
    arenaCv.height = hudCv.height = th;
  }

  function fit(cv, ctx) {
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* 每帧几何：ψ = 左片张角（0 平铺、π 合上），磁吸时叠加一段阻尼回弹；
   * 铰链 hx 随开合平移，让机身包围盒始终居中 */
  function frame(fold) {
    const b = Math.abs(Math.sin(snapT * 26) * Math.exp(-snapT * 9)) * 0.09;
    const psi = clamp((1 - fold) * Math.PI + (fold > 0.5 ? b : -b), 0, Math.PI);
    const wide = W > H * 1.2;
    const want = G.state === 'menu' && wide ? Math.max(W * 0.66, W * 0.38 + L.cw * 1.1) : W / 2;
    centerX = centerX < 0 ? want : centerX + (want - centerX) * 0.12;
    /* 竖屏菜单：窗口压在底部，手机整体上移让出位置；按窗口实测高度让位，文案增减（如免责声明）不会压到手机 */
    const menuGap = G.state === 'menu' && !wide ? menuWinReserve() : 0;
    const wantY = menuGap ? Math.max(0, Math.min(L.y0 - 24, L.y0 + L.ph - (H - menuGap))) : 0;
    yShift += (wantY - yShift) * 0.12;
    const hx = centerX - L.cw / 2 * (1 - fold);
    /* 被炸震动：整机（含投影、出口光束）跟着平移，桌面不动；y0Base/hxBase 留给命中框，抖动时手指照样抓得住 */
    const buzz = buzzXY();
    Ld.y0 = L.y0 - yShift + buzz.y;
    return {
      psi: psi, hx: hx + buzz.x, hxBase: hx, y0Base: L.y0 - yShift,
      s: L.dispH / CFG.ARENA_REF_H, flash: snapT < 2 ? Math.exp(-snapT * 5) : 0,
    };
  }

  function draw(dt) {
    if (!ctxBg || !ctxFx || !L) return;
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;
    timeAcc += dt;
    PhoneArt.track(dt);
    if (G.snapSeq !== lastSnap) { lastSnap = G.snapSeq; snapT = 0; }
    snapT += dt;

    const fold = clamp(G.fold != null ? G.fold : 0.85, 0, 1);
    const fr = frame(fold);
    drawArena(fr);
    /* 孤岛：外屏画面要整块搬到折痕窗口，先拷一份本帧战场，再改写两张贴图 */
    const scene = PhoneArt.isleK() > 0 ? arenaScene() : null;
    if (scene) {
      const actx = arenaCv.getContext('2d');
      actx.setTransform(dpr, 0, 0, dpr, 0, 0);
      PhoneArt.drawIsleMask(actx, L.dispW, L.dispH, 'arena', scene);
    }
    /* 左内屏翻过 0.92π 后被右片完全挡住，不再画 HUD 贴图省一次上传 */
    const hudOn = fr.psi < Math.PI * 0.92;
    if (hudOn) drawHudTex(scene);
    drawBg(fr);
    ctxFx.clearRect(0, 0, W, H);
    let ok = false;
    if (glOK) {
      ok = PhoneArt.drawGL({
        L: Ld, hx: fr.hx, psi: fr.psi, eyeX: centerX, eyeY: Ld.y0 + L.ph / 2,
        flash: fr.flash, arena: arenaCv, hud: hudOn ? hudCv : null,
      });
    }
    if (!ok) drawFlat(fr, hudOn);
    const y0Shaken = Ld.y0;
    Ld.y0 = fr.y0Base;
    publishFlapHit({ hx: fr.hxBase, psi: fr.psi });
    Ld.y0 = y0Shaken;
    drawOverloadExit(ctxFx, fr);
    drawDragHint(ctxFx, fr);
    viewFx();
  }

  /* 战场贴图：以逻辑坐标绘制，按 fr.s 缩放进显示区像素 */
  function drawArena(fr) {
    const ctx = arenaCv.getContext('2d');
    const AW = G.AW, AH = G.AH;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, arenaCv.width, arenaCv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    PhoneArt.drawArenaBg(ctx, L.dispW, L.dispH, timeAcc);
    ctx.save();
    ctx.scale(fr.s, fr.s);
    const sk = shakeXY(clamp(G.shake || 0, 0, 32));
    if (sk) ctx.translate(sk.x, sk.y);

    /* 超载后遗症期间所有投射物都画成炸弹（尺寸也统一成炸弹，免得靠大小认出水果）；判定不变 */
    const disguise = G.blurT > 0;
    const fruits = G.fruits;
    if (fruits) {
      for (let i = 0; i < fruits.length; i++) {
        const f = fruits[i];
        if (!f || f.pierced || (f.dead && f.type === 'bomb')) continue;
        const rot = (f.vx || 0) * 0.0012 + Math.sin(timeAcc * 2.2 + (f.id || 0) * 1.3) * 0.14;
        drawEmoji(ctx, disguise ? CFG.EMOJI_BOMB : f.emoji, f.x, f.y, (disguise ? CFG.BOMB_R : f.r) * 2, rot);
      }
    }
    const ps = G.particles;
    if (ps) {
      for (let j = 0; j < ps.length; j++) {
        const p = ps[j];
        if (!p || p.life <= 0) continue;
        const a = clamp(p.life / (p.maxLife || 1), 0, 1);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color || '#ffc27a';
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, (p.size || 2) * (0.4 + 0.6 * a)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    const beamY = G.beamY > 0 ? G.beamY : AH * CFG.BEAM_Y_FRAC;
    const len = G.beamLen > 1 ? G.beamLen : AW * CFG.BEAM_LEN_MIN;
    const over = overEnv();
    drawGrazeBand(ctx, beamY, len);
    drawBeam(ctx, beamY, len, over);
    if (over > 0) glowBall(ctx, AW, beamY, (34 + 10 * Math.sin(timeAcc * 29)) * (0.6 + 0.4 * over), over);   // 右缘出口
    drawSkewers(ctx, beamY);
    drawPopups(ctx);
    const fr2 = clamp(G.flashRed || 0, 0, 1), fg = clamp(G.flashGray || 0, 0, 1);
    if (fr2 > 0.004) { ctx.fillStyle = 'rgba(255,66,40,' + (fr2 * 0.32).toFixed(3) + ')'; ctx.fillRect(-PAD, -PAD, AW + PAD * 2, AH + PAD * 2); }
    if (fg > 0.004) { ctx.fillStyle = 'rgba(200,196,188,' + (fg * 0.26).toFixed(3) + ')'; ctx.fillRect(-PAD, -PAD, AW + PAD * 2, AH + PAD * 2); }
    ctx.restore();
    PhoneArt.drawArenaOver(ctx, L.dispW, L.dispH);
  }

  function drawHudTex(scene) {
    const ctx = hudCv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, hudCv.width, hudCv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    PhoneArt.drawHud(ctx, L.dispW, L.dispH, timeAcc, scene);
  }

  /* 只在孤岛期间每帧多一次整张贴图拷贝；尺寸跟着 arenaCv 走 */
  let sceneCv = null;
  function arenaScene() {
    sceneCv = sceneCv || document.createElement('canvas');
    if (sceneCv.width !== arenaCv.width || sceneCv.height !== arenaCv.height) {
      sceneCv.width = arenaCv.width;
      sceneCv.height = arenaCv.height;
    }
    const c = sceneCv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, sceneCv.width, sceneCv.height);
    c.drawImage(arenaCv, 0, 0);
    return sceneCv;
  }

  /* 桌面上的投影点：沿光线方向落到桌面 z = -zd，再按同一单点透视投到屏幕 */
  const LIGHT = [-0.42, -0.7, 0.58];
  function deskPt(x, y, z, zd, eyeX, eyeY, D) {
    const h = z + zd;
    const px = x - LIGHT[0] / LIGHT[2] * h, py = y - LIGHT[1] / LIGHT[2] * h;
    const s = D / (D + zd);
    return [eyeX + (px - eyeX) * s, eyeY + (py - eyeY) * s];
  }

  /* 桌面底图（深胡桃木 + 台灯暖光 + 木纹），只依赖视口，resize 时缓存；每帧只叠投影 */
  let deskCv = null, deskKey = '';
  function deskTexture() {
    const key = W + 'x' + H + '@' + dpr;
    if (deskCv && deskKey === key) return deskCv;
    deskCv = deskCv || document.createElement('canvas');
    deskCv.width = Math.round(W * dpr); deskCv.height = Math.round(H * dpr);
    const c = deskCv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#1c130d'); g.addColorStop(0.6, '#140d09'); g.addColorStop(1, '#0b0705');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    /* 木纹：固定种子的长弧线，低透明度叠加 */
    let s = 11;
    const rnd = function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
    c.lineWidth = 1;
    for (let i = 0; i < 70; i++) {
      const y = rnd() * H * 1.2 - H * 0.1, amp = 6 + rnd() * 26, ph = rnd() * 6.28;
      c.strokeStyle = rnd() < 0.5 ? 'rgba(255,190,130,0.025)' : 'rgba(0,0,0,0.18)';
      c.lineWidth = 0.6 + rnd() * 1.8;
      c.beginPath();
      for (let x = -20; x <= W + 20; x += 24) {
        const yy = y + Math.sin(x / (180 + amp * 9) + ph) * amp;
        if (x < 0) c.moveTo(x, yy); else c.lineTo(x, yy);
      }
      c.stroke();
    }
    lightBlob(c, W * 0.3, H * 0.12, Math.max(W, H) * 0.75, 'rgba(255,168,92,0.16)');
    lightBlob(c, W * 0.86, H * 0.9, Math.max(W, H) * 0.45, 'rgba(255,92,40,0.06)');
    const R = Math.max(W, H) * 0.75;
    const vg = c.createRadialGradient(W / 2, H / 2, R * 0.35, W / 2, H / 2, R);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)');
    c.fillStyle = vg; c.fillRect(0, 0, W, H);
    deskKey = key;
    return deskCv;
  }

  function polyPath(ctx, pts) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) { if (i) ctx.lineTo(pts[i][0], pts[i][1]); else ctx.moveTo(pts[i][0], pts[i][1]); }
    ctx.closePath();
  }

  /* bg 层：桌面 + 两片机身投在桌上的软影（左片翻起越高，影子越远越淡越虚）+ 铰链漏液在桌上的暖色反光 */
  function drawBg(fr) {
    const ctx = ctxBg;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(deskTexture(), 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const D = L.ph * CFG.EYE_DIST_H, zd = L.t, ex = centerX, ey = Ld.y0 + L.ph / 2;
    const y0 = Ld.y0, y1 = Ld.y0 + L.ph, hx = fr.hx;
    const right = [[hx, y0, 0], [hx + L.cw, y0, 0], [hx + L.cw, y1, 0], [hx, y1, 0]];
    const flap = PhoneArt.flapCorners(Ld, hx, fr.psi);
    const lift = Math.sin(fr.psi);
    ctx.save();
    /* 接触影：紧贴机身，黑而实 */
    if (HAS_FILTER) ctx.filter = 'blur(' + (L.t * 0.5).toFixed(1) + 'px)';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    polyPath(ctx, right.map(function (p) { return deskPt(p[0], p[1], -zd * 0.6, zd, ex, ey, D); }));
    ctx.fill();
    /* 投射影：沿光线方向落到桌面 */
    if (HAS_FILTER) ctx.filter = 'blur(' + (L.t * 1.6).toFixed(1) + 'px)';
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    polyPath(ctx, right.map(function (p) { return deskPt(p[0], p[1], p[2], zd, ex, ey, D); }));
    ctx.fill();
    if (HAS_FILTER) ctx.filter = 'blur(' + (L.t * (1.6 + 3 * lift)).toFixed(1) + 'px)';
    ctx.fillStyle = 'rgba(0,0,0,' + (0.42 - 0.16 * lift).toFixed(3) + ')';
    polyPath(ctx, flap.map(function (p) { return deskPt(p[0], p[1], p[2], zd, ex, ey, D); }));
    ctx.fill();
    ctx.restore();
    /* 光束漏光：在桌面铰链处晕开一圈暖光，随开合变强 */
    const beamY = Ld.y0 + L.e + (G.beamY > 0 ? G.beamY : G.AH * CFG.BEAM_Y_FRAC) * fr.s;
    lightBlob(ctx, hx, beamY, L.ph * (0.25 + 0.35 * (1 - fr.psi / Math.PI)), 'rgba(' + EMBER + ',0.10)');
  }

  /* 降级（无 WebGL2）：平面机身，左片按 |cos ψ| 横向压缩模拟翻转，过半后显示外屏；无逆投影模糊 */
  function drawFlat(fr, hudOn) {
    const ctx = ctxFx, f = PhoneArt.finish();
    const y0 = Ld.y0, ya = y0 + L.e, hx = fr.hx, r = L.m.r;
    const c = Math.cos(fr.psi), lw = L.cw * Math.abs(c);
    ctx.save();
    ctx.fillStyle = f.rim[0];
    PhoneArt.rrect(ctx, hx, y0, L.cw, L.ph, [0, r, r, 0]); ctx.fill();
    ctx.fillStyle = '#050505';
    PhoneArt.rrect(ctx, hx, y0 + L.m.rim, L.cw - L.m.rim, L.ph - L.m.rim * 2, [0, r, r, 0]); ctx.fill();
    ctx.drawImage(arenaCv, hx, ya, L.dispW, L.dispH);
    if (lw > 1) {
      const front = c > 0;
      ctx.fillStyle = f.rim[0];
      PhoneArt.rrect(ctx, hx - (front ? lw : 0), y0, lw, L.ph, front ? [r, 0, 0, r] : [0, r, r, 0]); ctx.fill();
      ctx.fillStyle = '#050505';
      PhoneArt.rrect(ctx, hx - (front ? lw : 0) + (front ? L.m.rim : 0), y0 + L.m.rim, lw - L.m.rim, L.ph - L.m.rim * 2, front ? [r, 0, 0, r] : [0, r, r, 0]); ctx.fill();
      const src = front ? (hudOn ? hudCv : null) : arenaCv;
      if (src) {
        ctx.globalAlpha = 0.35 + 0.65 * Math.abs(c);
        ctx.drawImage(src, front ? hx - lw : hx + L.e * Math.abs(c), ya, Math.max(1, lw - L.e * Math.abs(c)), L.dispH);
      }
    }
    ctx.restore();
  }

  /* 超载光束冲出机身右缘：屏幕空间里从右显示区边缘一路射到视口外，出口处炸开一团白热 + 甩出火星。
   * 右片固定在 z=0 平面，世界坐标即屏幕坐标，无需透视换算 */
  function drawOverloadExit(ctx, fr) {
    const e = overEnv();   // 暂停时也画（静帧要和战场内的粗光束一致），只有晃动/模糊随暂停停掉
    if (e <= 0) return;
    const by = Ld.y0 + L.e + (G.beamY > 0 ? G.beamY : G.AH * CFG.BEAM_Y_FRAC) * fr.s;
    const xs = fr.hx + L.dispW, xe = W + 40, s = fr.s;
    const flick = 1 + 0.22 * Math.sin(timeAcc * 47) + 0.1 * Math.sin(timeAcc * 83);
    ctx.save();
    ctx.lineCap = 'butt';
    const layers = [[90, 0.05], [46, 0.1], [22, 0.22], [10, 0.5]];
    for (let i = 0; i < layers.length; i++) {
      ctx.strokeStyle = 'rgba(' + EMBER + ',' + (layers[i][1] * e).toFixed(3) + ')';
      ctx.lineWidth = layers[i][0] * s * flick;
      ctx.beginPath(); ctx.moveTo(xs, by); ctx.lineTo(xe, by); ctx.stroke();
    }
    const core = ctx.createLinearGradient(xs, 0, W, 0);
    core.addColorStop(0, 'rgba(255,255,250,' + e + ')');
    core.addColorStop(1, 'rgba(255,226,170,' + (0.6 * e).toFixed(3) + ')');
    ctx.strokeStyle = core;
    ctx.lineWidth = 6 * s * flick;
    ctx.beginPath(); ctx.moveTo(xs, by); ctx.lineTo(xe, by); ctx.stroke();
    glowBall(ctx, xs, by, (60 + 16 * Math.sin(timeAcc * 31)) * s, e);
    /* 出口火星：固定种子 + 时间相位，向右上下扇形甩出；数量有界 */
    for (let k = 0; k < 22; k++) {
      const ph = (k * 0.618 + timeAcc * (1.6 + (k % 5) * 0.35)) % 1;
      const ang = ((k * 0.37) % 1 - 0.5) * 1.3;
      const d = ph * L.cw * 0.9;
      const px = xs + Math.cos(ang) * d, py = by + Math.sin(ang) * d + ph * ph * 40 * s;
      ctx.globalAlpha = e * (1 - ph);
      ctx.fillStyle = k % 3 ? 'rgb(' + EMBER + ')' : '#fff6e0';
      ctx.fillRect(px, py, (2 + (k % 3)) * s * (1 - ph * 0.5) * 2, 1.4 * s);
    }
    ctx.globalAlpha = 1;
    /* 视口边缘的冲击光：光束打出画面的那一侧整片泛白 */
    const eg = ctx.createRadialGradient(W, by, 0, W, by, H * 0.6);
    eg.addColorStop(0, 'rgba(255,214,150,' + (0.28 * e * flick).toFixed(3) + ')');
    eg.addColorStop(1, 'rgba(255,132,44,0)');
    ctx.fillStyle = eg;
    ctx.fillRect(W - H * 0.6, by - H * 0.6, H * 0.6, H * 1.2);
    ctx.restore();
  }

  /* 拖拽提示：画在左片（翻盖）下方，菜单带文案，游戏中仅淡箭头；提示的就是可拖的那半边 */
  function drawDragHint(ctx, fr) {
    const st = G.state;
    if (st !== 'menu' && st !== 'playing' && st !== 'countdown') return;
    const withText = st === 'menu';
    const a = (withText ? 0.7 : 0.26) * (0.72 + 0.28 * Math.sin(timeAcc * 2.6));
    const y = Ld.y0 + L.ph + Math.min(34, (H - Ld.y0 - L.ph) * 0.5);
    if (y > H - 6) return;
    const hit = G.flapHit;
    const Lh = 20;
    const x = clamp(hit ? (hit.x0 + hit.x1) / 2 : centerX, Lh + 8, W - Lh - 8);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#f2c27a';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - Lh, y); ctx.lineTo(x + Lh, y);
    ctx.moveTo(x - Lh + 6, y - 5); ctx.lineTo(x - Lh, y); ctx.lineTo(x - Lh + 6, y + 5);
    ctx.moveTo(x + Lh - 6, y - 5); ctx.lineTo(x + Lh, y); ctx.lineTo(x + Lh - 6, y + 5);
    ctx.stroke();
    if (withText) {
      ctx.font = '600 13px ' + FONT_SYS;
      ctx.fillStyle = '#f6dcae';
      ctx.textBaseline = 'middle';
      const hint = '按住左半屏 · 拖动翻盖';
      /* 窄屏右侧放不下时改到箭头正下方居中，避免文字被视口裁掉 */
      if (x + Lh + 12 + ctx.measureText(hint).width > W - 8) {
        ctx.textAlign = 'center';
        ctx.fillText(hint, x, y + 18);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(hint, x + Lh + 12, y);
      }
    }
    ctx.restore();
  }

  /* 擦弹带：光束正上方 GRAZE_H 高的淡绿光带，向上渐隐；范围与 game.js 的擦弹预备判定一致 */
  function drawGrazeBand(ctx, beamY, len) {
    const h = CFG.GRAZE_H || 0;
    if (h <= 0) return;
    const band = ctx.createLinearGradient(0, beamY, 0, beamY - h);
    band.addColorStop(0, 'rgba(125,255,168,0.16)');
    band.addColorStop(1, 'rgba(125,255,168,0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, beamY - h, Math.max(12, len), h);
  }

  /* 光束：自铰链（折痕）射出的熔金光液，白核 + 多层暖色辉光 + 端部亮球 + 沿途火星 */
  /* over：超载包络 0..1，光束加粗、高频脉动、核心更白 */
  function drawBeam(ctx, beamY, len, over) {
    over = over || 0;
    const x0 = 0;                                     // 战场原点即折痕
    const x1 = Math.max(x0 + 12, len);                // len 即逻辑尖端绝对坐标
    const pulse = 1 + 0.16 * Math.sin(timeAcc * 8.5) + over * (0.25 * Math.sin(timeAcc * 47) + 0.2);
    const thick = 1 + 1.6 * over;
    ctx.save();
    ctx.lineCap = 'round';
    const glowLayers = [[30, 0.06], [16, 0.13], [8, 0.26]];
    for (let i = 0; i < glowLayers.length; i++) {
      ctx.strokeStyle = 'rgba(' + EMBER + ',' + Math.min(0.5, glowLayers[i][1] * (1 + over)) + ')';
      ctx.lineWidth = glowLayers[i][0] * thick * (i < 2 ? pulse : 1);
      ctx.beginPath(); ctx.moveTo(x0, beamY); ctx.lineTo(x1, beamY); ctx.stroke();
    }
    if (over > 0) {
      ctx.strokeStyle = 'rgba(255,236,190,' + (0.5 * over).toFixed(3) + ')';
      ctx.lineWidth = 9 * pulse;
      ctx.beginPath(); ctx.moveTo(x0, beamY); ctx.lineTo(x1, beamY); ctx.stroke();
    }
    const core = ctx.createLinearGradient(x0, 0, x1, 0);
    core.addColorStop(0, 'rgba(255,255,250,0.97)');
    core.addColorStop(0.75, 'rgba(255,246,226,0.9)');
    core.addColorStop(1, 'rgba(255,214,150,0.95)');
    ctx.strokeStyle = core;
    ctx.lineWidth = 3.2 * (1 + over);
    ctx.beginPath(); ctx.moveTo(x0, beamY); ctx.lineTo(x1, beamY); ctx.stroke();
    glowBall(ctx, x0, beamY, 15, 1);
    glowBall(ctx, x1, beamY, 15 + 2.5 * Math.sin(timeAcc * 12), 1);
    const N = 14;
    for (let k = 0; k < N; k++) {
      const t = (k * 0.37 + timeAcc * (0.22 + (k % 3) * 0.09)) % 1;
      const a = 0.55 * Math.sin(t * Math.PI);
      if (a < 0.03) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = k % 4 === 0 ? '#fff6e0' : 'rgb(' + EMBER + ')';
      ctx.beginPath();
      ctx.arc(x0 + 6 + t * (x1 - x0 - 12), beamY + Math.sin(timeAcc * 4 + k * 1.9) * 2.5, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* 串在光束上的水果：随 life 缩小渐隐 */
  function drawSkewers(ctx, beamY) {
    const ss = G.skewers;
    if (!ss) return;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      if (!s || s.life <= 0) continue;
      const p = clamp(s.life / (s.maxLife || 1), 0, 1);
      drawEmoji(ctx, G.blurT > 0 ? CFG.EMOJI_BOMB : s.emoji, s.x, beamY, s.r * 2 * (0.45 + 0.55 * p), Math.sin(timeAcc * 6 + s.x * 0.1) * 0.15, p);
    }
  }

  /* 上飘弹字：弹入缩放 + 渐隐（上飘位移由 game.js 更新 u.y，这里只负责画） */
  function drawPopups(ctx) {
    const ps = G.popups;
    if (!ps) return;
    for (let i = 0; i < ps.length; i++) {
      const u = ps[i];
      if (!u || u.life <= 0) continue;
      const p = clamp(u.life / (u.maxLife || 1), 0, 1);
      const age = 1 - p;
      ctx.save();
      ctx.translate(u.x, u.y);
      const s = 0.6 + 0.4 * Math.min(1, age * 8);
      ctx.scale(s, s);
      ctx.globalAlpha = Math.min(1, age * 8) * p;
      ctx.font = '800 20px ' + FONT_SYS;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(30,14,4,0.8)';   // 描边代替底影：游戏字体的粗描边更醒目
      ctx.strokeText(u.text, 0, 0);
      ctx.fillStyle = u.color || '#ffd75e';
      ctx.fillText(u.text, 0, 0);
      ctx.restore();
    }
  }

  window.Render = { init: init, resize: resize, draw: draw };
})();
