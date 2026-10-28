/* ============================================================
 * phone-screen.js —— 折叠手机屏幕贴图（渲染层私有，PhoneArt 的一半）
 * 每帧把内屏（横跨两块面板的一整块柔性屏）与外屏（锁屏 + 顶部胶囊）
 * v2.0：drawHud 画左半 HUD，drawArenaBg 画右半战场背景（合上即外屏）。
 * 只读 CFG/G；裂纹、通知、最近串到等都是纯表现状态，不影响规则。
 * ============================================================ */
(function () {
  'use strict';
  const PA = window.PhoneArt = window.PhoneArt || {};

  const FONT = "system-ui,'Microsoft YaHei','Segoe UI',sans-serif";
  const EMOJI = "emoji,'Segoe UI Emoji','Noto Color Emoji',sans-serif";
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const FINISH_KEY = 'crease_pierce_finish_v1';
  const NOTE_LIFE = 2.6;
  const RING_COLORS = ['255,72,48', '170,226,60', '255,184,64'];   // 战况环三色（第三环换成熔金，贴合暖色主题）
  const EMBER_RGB = '255,132,44';   // 与 render.js 光束辉光同色

  /* 两种配色：影响金属中框、背板、壁纸。主题是"夜市摊位"：炭黑 + 熔金 + 朱砂，不走冷色科技风
   * gl：给 WebGL 机身用的线性 RGB（rim0 基色 / rim1 反射色 / back 磨砂背板） */
  const FINISHES = {
    night: {
      rim: ['#2a2622', '#7a6e62', '#161310'], rimHi: 'rgba(255,226,190,0.6)',
      cover: ['#120b07', '#3a1c0e', '#7a2e12'], glow: '255,150,60',
      gl: { rim0: [0.16, 0.145, 0.13], rim1: [0.55, 0.5, 0.45], back: [0.07, 0.065, 0.06] },
    },
    star: {
      rim: ['#c9c3b8', '#fbf9f4', '#a39d92'], rimHi: 'rgba(255,255,255,0.95)',
      cover: ['#1a120a', '#5a3a1c', '#d99a52'], glow: '255,206,140',
      gl: { rim0: [0.62, 0.58, 0.52], rim1: [0.95, 0.92, 0.86], back: [0.78, 0.75, 0.69] },
    },
  };

  let finishKey = 'night';
  try {
    const saved = localStorage.getItem(FINISH_KEY);
    if (saved && FINISHES[saved]) finishKey = saved;
  } catch (e) { /* file:// 或隐私模式禁读 */ }

  PA.finish = function () { return FINISHES[finishKey]; };
  PA.finishKey = function () { return finishKey; };
  PA.setFinish = function (key) {
    if (!FINISHES[key]) return;
    finishKey = key;
    try { localStorage.setItem(FINISH_KEY, key); } catch (e) { /* 忽略 */ }
  };

  /* 固定种子的星点（归一化坐标），每帧只做闪烁 */
  const STARS = [];
  (function () {
    let s = 7;
    const rnd = function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 46; i++) STARS.push({ x: rnd(), y: rnd() * 0.75, r: 0.3 + rnd() * 0.9, p: rnd() * 6.28 });
  })();

  /* 每角独立圆角：rs = [左上, 右上, 右下, 左下] */
  function rrect(ctx, x, y, w, h, rs) {
    const m = Math.min(w, h) / 2;
    const tl = Math.min(rs[0], m), tr = Math.min(rs[1], m), br = Math.min(rs[2], m), bl = Math.min(rs[3], m);
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    if (tr) ctx.arcTo(x + w, y, x + w, y + tr, tr); else ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - br);
    if (br) ctx.arcTo(x + w, y + h, x + w - br, y + h, br); else ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + bl, y + h);
    if (bl) ctx.arcTo(x, y + h, x, y + h - bl, bl); else ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + tl);
    if (tl) ctx.arcTo(x, y, x + tl, y, tl); else ctx.lineTo(x, y);
    ctx.closePath();
  }
  PA.rrect = rrect;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* 面板几何：圆角、黑边宽度（与面板宽度成比例，真机约 10% 圆角） */
  PA.panelMetrics = function (cw, ph) {
    const r = Math.min(cw, ph) * 0.14;
    const bez = Math.max(2.5, cw * 0.03);
    return { r: r, bez: bez, rim: Math.max(1.4, cw * 0.012) };
  };

  /* ——— 表现层事件跟踪（只读 G）——— */
  const fx = {
    cracks: [], notes: [], recent: [], seen: new WeakSet(), lastHp: null, lastState: '', combo5: false, deadT: 0, count: 0,
    burn: null, burnLevel: 0,
    isle: 0, isleOn: false, isleN: 0, wasOpen: false,   // 彩蛋「应用孤岛」淡入量 / 是否显示 / 菜单全开次数
  };
  PA.fx = fx;

  /* 血条显示值：show 快速跟随真实血量；ghost 受击后先停 0.45s 再追上，形成浅色残段；
   * slosh 血量变化时液面晃动强度，指数衰减 */
  const hpFx = { show: 1, ghost: 1, hold: 0, slosh: 0, last: 1, floats: [] };
  function resetHp() { hpFx.show = hpFx.ghost = hpFx.last = 1; hpFx.hold = 0; hpFx.slosh = 0; hpFx.floats.length = 0; }
  function trackHp(dt) {
    const k = clamp((G.hp != null ? G.hp : CFG.HP_MAX) / CFG.HP_MAX, 0, 1);
    if (k !== hpFx.last) {
      hpFx.slosh = Math.min(1, hpFx.slosh + 0.35 + Math.abs(k - hpFx.last) * 4);
      if (k < hpFx.last) hpFx.hold = 0.45;
      else hpFx.floats.push({ v: Math.round((k - hpFx.last) * CFG.HP_MAX), life: 0.9 });
      hpFx.last = k;
    }
    for (let i = hpFx.floats.length - 1; i >= 0; i--) {
      hpFx.floats[i].life -= dt;
      if (hpFx.floats[i].life <= 0) hpFx.floats.splice(i, 1);
    }
    hpFx.show += (k - hpFx.show) * (1 - Math.exp(-10 * dt));
    hpFx.hold -= dt;
    if (hpFx.hold <= 0) hpFx.ghost += (hpFx.show - hpFx.ghost) * (1 - Math.exp(-3.5 * dt));
    if (hpFx.ghost < hpFx.show) hpFx.ghost = hpFx.show;
    hpFx.slosh *= Math.exp(-1.8 * dt);
  }

  /* 激光击穿的右缘缺口：固定种子生成形状，每帧不抖；level 越高缺口越大、坏线越多 */
  function makeBurn(level) {
    let s = 977 + level * 131;
    const rnd = function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const rim = [];
    for (let i = 0; i <= 16; i++) rim.push(0.72 + rnd() * 0.5);
    const lines = [];
    const LINE_COLORS = ['120,255,160', '255,80,220', '90,170,255'];   // 坏线只用屏幕坏点常见的 RGB 单色，纯白会被误认成渲染 bug
    for (let i = 0; i < Math.min(12, 2 + level * 2); i++) {
      const full = rnd() < 0.5;
      lines.push({
        dx: 0.01 + rnd() * (0.05 + 0.025 * level), w: 0.5 + rnd() * 1.1, c: LINE_COLORS[(rnd() * LINE_COLORS.length) | 0],
        y0: full ? 0 : rnd() * 0.5, y1: full ? 1 : 0.5 + rnd() * 0.5, f: 3 + rnd() * 9,
      });
    }
    const rays = [];
    for (let i = 0; i < 3 + level; i++) {
      const pts = [[0, 0]];
      let a = Math.PI + (rnd() - 0.5) * 2.2, d = 0;
      const len = 0.08 + rnd() * 0.12 + level * 0.02;
      while (d < len) {
        d += 0.02 + rnd() * 0.035;
        a += (rnd() - 0.5) * 0.5;
        pts.push([Math.cos(a) * d, Math.sin(a) * d]);
      }
      rays.push(pts);
    }
    return { level: level, rim: rim, lines: lines, rays: rays, age: 0, cool: 0 };
  }

  function note(icon, title, body) {
    fx.notes.unshift({ icon: icon, title: title, body: body, life: NOTE_LIFE });
    if (fx.notes.length > 2) fx.notes.length = 2;
  }

  /* 裂纹：中心 + 若干条折线射线，坐标以显示区高为单位存储，resize 不失真。
   * 射线角度不均分、长短悬殊、拐折幅度随机，部分射线中途分叉；起点也不全在中心，避免像规整的蛛网 */
  function crackPath(x, y, a, len, bend) {
    const pts = [[x, y]];
    let d = 0;
    while (d < len) {
      const step = 0.012 + Math.random() * 0.045;
      d += step;
      a += (Math.random() - 0.5) * bend;
      x += Math.cos(a) * step; y += Math.sin(a) * step;
      pts.push([x, y]);
    }
    return pts;
  }
  function makeCrack() {
    const rays = [];
    const n = 4 + ((Math.random() * 6) | 0);
    for (let i = 0; i < n; i++) {
      const a0 = Math.random() * Math.PI * 2;
      const r0 = Math.random() * 0.025;
      const len = 0.05 + Math.pow(Math.random(), 1.6) * 0.32;
      const pts = crackPath(Math.cos(a0) * r0, Math.sin(a0) * r0, a0, len, 0.3 + Math.random() * 0.9);
      rays.push({ pts: pts, w: 0.6 + Math.random() * 0.8 });
      /* 分叉：从中段某点斜着岔出一条更短更细的 */
      if (pts.length > 3 && Math.random() < 0.55) {
        const p = pts[1 + ((Math.random() * (pts.length - 2)) | 0)];
        const side = Math.random() < 0.5 ? -1 : 1;
        rays.push({ pts: crackPath(p[0], p[1], a0 + side * (0.5 + Math.random() * 0.9), len * (0.2 + Math.random() * 0.4), 0.8), w: 0.4 + Math.random() * 0.4 });
      }
    }
    /* 环纹不是完整的圆：只画 1~2 段随机弧 */
    const arcs = [];
    const ring = 0.02 + Math.random() * 0.04;
    for (let k = 0, m = 1 + ((Math.random() * 2) | 0); k < m; k++) {
      const s = Math.random() * Math.PI * 2;
      arcs.push([ring * (0.8 + Math.random() * 0.5), s, s + 0.6 + Math.random() * 1.8]);
    }
    return { x: 0.12 + Math.random() * 0.76, y: 0.1 + Math.random() * 0.75, rays: rays, arcs: arcs, alpha: 0.4 + Math.random() * 0.25, age: 0 };
  }

  /* 每帧对比 G 的变化，派生出通知、裂纹、最近串到等纯表现事件 */
  PA.track = function (dt) {
    const st = G.state;
    /* 新一局从倒计时开始；倒计时 → playing 是同一局，不能再清一次 */
    const inRun = st === 'countdown' || st === 'playing';
    if (inRun && fx.lastState !== 'countdown' && fx.lastState !== 'playing' && fx.lastState !== 'paused') {
      fx.cracks.length = 0; fx.notes.length = 0; fx.recent.length = 0;
      fx.combo5 = false; fx.bestNoted = false; fx.deadT = 0; fx.count = 0;
      fx.burn = null; fx.burnLevel = 0;
      fx.lastCharges = null; fx.blurWas = false;   // 不清会把上局剩余次数当基准，开局误弹「+1」
      resetHp();
      note('🔦', '激光大师', '按住左半屏拖动开合');
    }
    if (st === 'gameover' && fx.lastState !== 'gameover') fx.deadT = 0;
    fx.lastState = st;
    if (st === 'gameover') fx.deadT += dt;

    const hp = G.hp;
    if (fx.lastHp != null && hp < fx.lastHp && st !== 'menu') {
      if (G.lastHurt === 'bomb') {
        fx.cracks.push(makeCrack());
        note('⚠️', '检测到折痕漏液', '屏幕受损，请前往菠萝售后');
      } else {
        note('🍃', '漏接提醒', '有水果掉到地上了');
      }
    }
    fx.lastHp = hp;

    const ss = G.skewers || [];
    for (let i = 0; i < ss.length; i++) {
      if (fx.seen.has(ss[i])) continue;
      fx.seen.add(ss[i]);
      fx.count++;
      fx.recent.unshift(ss[i].emoji);
      if (fx.recent.length > 6) fx.recent.length = 6;
    }
    if (st === 'playing') {
      if ((G.combo || 0) >= CFG.COMBO_MAX && !fx.combo5) { fx.combo5 = true; note('🔥', '连击 ×' + CFG.COMBO_MAX, '满倍率，手感火热'); }
      if ((G.combo || 0) < 2) fx.combo5 = false;
      if (!fx.bestNoted && G.best > 0 && G.score > G.best) { fx.bestNoted = true; note('🏆', '新纪录', '已超越历史最佳 ' + G.best); }
    }
    for (let j = fx.notes.length - 1; j >= 0; j--) {
      fx.notes[j].life -= dt;
      if (fx.notes[j].life <= 0) fx.notes.splice(j, 1);
    }
    for (let k = 0; k < fx.cracks.length; k++) fx.cracks[k].age += dt;
    if (fx.cracks.length > 6) fx.cracks.shift();
    /* 每次超载都在右缘再烧大一圈，本局保留；超载结束后熔边慢慢冷却 */
    if ((G.overloadCount || 0) > fx.burnLevel) {
      fx.burnLevel = G.overloadCount;
      fx.burn = makeBurn(fx.burnLevel);
      note('⚡', '激光超载', G.overloadCharges > 0 ? '右缘已击穿 · 还能超载 ' + G.overloadCharges + ' 次' : '次数已用尽 · 再超载手机会报废');
    }
    /* 超载次数回复提示：只在增加时弹，减少由上面的超载通知负责 */
    const charges = G.overloadCharges != null ? G.overloadCharges : CFG.OVERLOAD_CHARGES;
    if (st === 'playing' && fx.lastCharges != null && charges > fx.lastCharges) note('🔋', '超载次数 +1', '连串 ' + CFG.OVERLOAD_RESTORE_STREAK + ' 个 · 剩余 ' + charges + ' 次');
    fx.lastCharges = charges;
    /* 超载后遗症开始：提醒玩家眼前的炸弹可能是水果 */
    const blurOn = (G.blurT || 0) > 0;
    if (blurOn && !fx.blurWas && st === 'playing') note('😵', '屏幕过热', '画面模糊，看到的炸弹不一定是炸弹');
    fx.blurWas = blurOn;
    if (fx.burn) {
      fx.burn.age += dt;
      fx.burn.cool = G.overload > 0 ? 0 : fx.burn.cool + dt;
    }
    trackHp(dt);
    if (fx.isleSeq == null) fx.isleSeq = G.isleSeq;
    if (G.isleSeq !== fx.isleSeq) {
      fx.isleSeq = G.isleSeq;
      if (st === 'playing') note('🏝️', '应用孤岛', '此应用尚未适配折叠屏 · 合上 ' + CFG.ISLE_ROUNDS + ' 次恢复');
    }
    /* 菜单演示每两次全开露一次「应用孤岛」，稀有一点才像彩蛋 */
    const openNow = st === 'menu' && (G.fold || 0) > 0.9;
    if (openNow && !fx.wasOpen) { fx.isleN++; fx.isleOn = fx.isleN % 2 === 1; }
    if (!openNow) fx.isleOn = false;
    if (st !== 'menu') fx.isle = 0;   // 开局立刻切走，不让 App 残影盖在战场上
    fx.wasOpen = openNow;
    fx.isle += ((fx.isleOn ? 1 : 0) - fx.isle) * (1 - Math.exp(-8 * dt));
    if (fx.isle < 0.003) fx.isle = 0;
  };

  /* ——— 通用小部件 ——— */
  function clockText() {
    const d = new Date();
    return { hm: d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2), date: (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + WEEK[d.getDay()] };
  }

  function text(ctx, s, x, y, size, weight, color, align) {
    ctx.font = weight + ' ' + size.toFixed(2) + 'px ' + FONT;
    ctx.fillStyle = color;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }

  function emoji(ctx, ch, x, y, size) {
    ctx.font = size.toFixed(2) + 'px ' + EMOJI;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, x, y);
  }

  /* 游戏面板：切角漆盒 + 双线金边 + 四角铆钉 + 顶部高光条，和 DOM 窗口同一套语言 */
  function chamfer(ctx, x, y, w, h, c) {
    ctx.beginPath();
    ctx.moveTo(x + c, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + c);
    ctx.lineTo(x + w, y + h - c); ctx.lineTo(x + w - c, y + h); ctx.lineTo(x + c, y + h);
    ctx.lineTo(x, y + h - c); ctx.lineTo(x, y + c);
    ctx.closePath();
  }
  function glass(ctx, x, y, w, h, r, a) {
    const c = r * 0.55, k = Math.max(0.6, r * 0.12);
    chamfer(ctx, x, y, w, h, c);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(46,24,14,' + (0.78 + (a || 0)) + ')');
    g.addColorStop(1, 'rgba(18,9,5,' + (0.86 + (a || 0)) + ')');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = k * 1.6;
    ctx.strokeStyle = '#c8893c';
    ctx.stroke();
    chamfer(ctx, x + k * 2.2, y + k * 2.2, w - k * 4.4, h - k * 4.4, Math.max(0, c - k * 1.4));
    ctx.lineWidth = k * 0.6;
    ctx.strokeStyle = 'rgba(255,214,150,0.35)';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,230,190,0.05)';
    ctx.fillRect(x + c, y + k * 2.6, w - c * 2, Math.min(h * 0.1, k * 4));
    const st = [[x + c * 0.9, y + c * 0.9], [x + w - c * 0.9, y + c * 0.9], [x + c * 0.9, y + h - c * 0.9], [x + w - c * 0.9, y + h - c * 0.9]];
    for (let i = 0; i < 4; i++) {
      const rg = ctx.createRadialGradient(st[i][0] - k * 0.4, st[i][1] - k * 0.4, 0, st[i][0], st[i][1], k * 1.5);
      rg.addColorStop(0, '#fff1c8'); rg.addColorStop(0.5, '#d9963e'); rg.addColorStop(1, '#5a3010');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(st[i][0], st[i][1], k * 1.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  /* 壁纸：配色渐变 + 缓慢漂移的极光 + 星点（nightsky 主题） */
  function wallpaper(ctx, w, h, t, dim) {
    const f = PA.finish();
    const g = ctx.createLinearGradient(0, 0, w * 0.3, h);
    g.addColorStop(0, f.cover[0]);
    g.addColorStop(0.6, f.cover[1]);
    g.addColorStop(1, f.cover[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const blobs = [[0.25, 0.7, '214,58,36'], [0.75, 0.35, f.glow], [0.55, 0.95, '255,196,90']];
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const bx = w * (b[0] + 0.08 * Math.sin(t * 0.21 + i * 2.1));
      const by = h * (b[1] + 0.05 * Math.cos(t * 0.17 + i));
      const R = Math.max(w, h) * 0.5;
      const rg = ctx.createRadialGradient(bx, by, 0, bx, by, R);
      rg.addColorStop(0, 'rgba(' + b[2] + ',0.42)');
      rg.addColorStop(1, 'rgba(' + b[2] + ',0)');
      ctx.fillStyle = rg;
      ctx.fillRect(0, 0, w, h);
    }
    for (let k = 0; k < STARS.length; k++) {
      const s = STARS[k];
      ctx.globalAlpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 1.7 + s.p));
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r * h / 260, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (dim > 0) { ctx.fillStyle = 'rgba(0,0,0,' + dim + ')'; ctx.fillRect(0, 0, w, h); }
  }

  /* 状态栏：电量 = 血量（满血绿、残血红），信号格随连击跳动 */
  function statusBar(ctx, x0, x1, y, u, hm) {
    text(ctx, hm, x0, y, 3.6 * u, '600', '#fff', 'left');
    const hp = clamp(G.hp != null ? G.hp : CFG.HP_MAX, 0, CFG.HP_MAX);
    const k = hp / CFG.HP_MAX;
    const bw = 6.4 * u, bh = 3 * u, bx = x1 - bw, by = y - bh / 2;
    rrect(ctx, bx, by, bw, bh, [u, u, u, u]);
    ctx.lineWidth = 0.5 * u;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(x1 + 0.4 * u, y - 0.7 * u, 0.6 * u, 1.4 * u);
    if (k > 0) {
      rrect(ctx, bx + 0.6 * u, by + 0.6 * u, (bw - 1.2 * u) * k, bh - 1.2 * u, [0.5 * u, 0.5 * u, 0.5 * u, 0.5 * u]);
      ctx.fillStyle = k <= 0.25 ? '#ff453a' : (k < 1 ? '#fff' : '#30d158');
      ctx.fill();
    }
    const bars = 1 + Math.min(3, G.combo || 0);
    for (let i = 0; i < 4; i++) {
      const hgt = (1 + i * 0.6) * u;
      ctx.fillStyle = i < bars ? '#fff' : 'rgba(255,255,255,0.3)';
      ctx.fillRect(bx - 9 * u + i * 1.5 * u, y + 1.2 * u - hgt, 1 * u, hgt);
    }
  }

  /* 战况环：红=连击倍率 / 绿=冲击最佳进度 / 青=连击窗口余量 */
  function rings(ctx, cx, cy, R, u) {
    const vals = [
      clamp((G.combo || 0) / CFG.COMBO_MAX, 0, 1),
      G.best > 0 ? clamp((G.score || 0) / G.best, 0, 1) : clamp((G.score || 0) / 200, 0, 1),
      clamp((G.comboTimer || 0) / CFG.COMBO_WINDOW, 0, 1),
    ];
    const lw = R * 0.2;
    for (let i = 0; i < 3; i++) {
      const r = R - i * lw * 1.15;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(' + RING_COLORS[i] + ',0.25)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      if (vals[i] > 0.005) {
        ctx.strokeStyle = 'rgb(' + RING_COLORS[i] + ')';
        ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * vals[i]); ctx.stroke();
      }
    }
  }

  /* 通知横幅：从顶部滑入，结束前上收 */
  function notes(ctx, cx, top, bw, u) {
    for (let i = 0; i < fx.notes.length; i++) {
      const n = fx.notes[i];
      const age = NOTE_LIFE - n.life;
      const ein = clamp(age / 0.35, 0, 1), eout = clamp(n.life / 0.3, 0, 1);
      const e = Math.min(1 - Math.pow(1 - ein, 3), eout);
      const bh = 9 * u;
      const y = top + i * (bh + 1.5 * u) - (1 - e) * (bh + top);
      ctx.save();
      ctx.globalAlpha = e;
      glass(ctx, cx - bw / 2, y, bw, bh, 3 * u, 0.1);
      rrect(ctx, cx - bw / 2 + 1.6 * u, y + 1.6 * u, 5.8 * u, 5.8 * u, [1.4 * u, 1.4 * u, 1.4 * u, 1.4 * u]);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fill();
      emoji(ctx, n.icon, cx - bw / 2 + 4.5 * u, y + 4.6 * u, 3.8 * u);
      text(ctx, n.title, cx - bw / 2 + 9 * u, y + 3.2 * u, 2.7 * u, '700', '#fff', 'left');
      text(ctx, n.body, cx - bw / 2 + 9 * u, y + 6.2 * u, 2.3 * u, '500', 'rgba(255,255,255,0.7)', 'left');
      ctx.restore();
    }
  }

  /* 裂纹 + 折痕漏液：白色裂线，中心渗出青色光液并沿重力缓慢下淌 */
  function cracks(ctx, w, h) {
    for (let i = 0; i < fx.cracks.length; i++) {
      const c = fx.cracks[i];
      const cx = c.x * w, cy = c.y * h, s = h;
      const leak = clamp(c.age / 3, 0, 1);
      const lg = ctx.createLinearGradient(0, cy, 0, cy + s * 0.35 * leak + 1);
      lg.addColorStop(0, 'rgba(255,170,70,0.6)');
      lg.addColorStop(1, 'rgba(255,170,70,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(cx - s * 0.008, cy, s * 0.016, s * 0.35 * leak + 1);
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.07);
      rg.addColorStop(0, 'rgba(255,214,140,0.55)');
      rg.addColorStop(1, 'rgba(255,214,140,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(cx - s * 0.07, cy - s * 0.07, s * 0.14, s * 0.14);
      /* 只画一层半透明白线，不加深色描边：多道裂纹叠在一起时黑边会糊成一片 */
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,' + c.alpha.toFixed(3) + ')';
      for (let r = 0; r < c.rays.length; r++) {
        const pts = c.rays[r].pts;
        ctx.lineWidth = Math.max(0.4, s * 0.0035 * c.rays[r].w);
        ctx.beginPath();
        for (let p = 0; p < pts.length; p++) {
          const px = cx + pts[p][0] * s, py = cy + pts[p][1] * s;
          if (p) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
      ctx.lineWidth = Math.max(0.4, s * 0.0025);
      for (let k = 0; k < c.arcs.length; k++) {
        ctx.beginPath();
        ctx.arc(cx, cy, c.arcs[k][0] * s, c.arcs[k][1], c.arcs[k][2]);
        ctx.stroke();
      }
    }
  }

  /* 小组件卡片标题 */
  function widgetTitle(ctx, s, x, y, u) { text(ctx, s, x, y, 2.3 * u, '800', '#f2c27a', 'left'); }

  /* 光液配色：满血熔金 → 半血橙 → 残血朱砂，[亮, 中, 暗] 三档 */
  const HP_TONES = [
    [0.0, [255, 96, 70], [214, 40, 34], [110, 12, 16]],
    [0.3, [255, 150, 64], [236, 88, 30], [130, 34, 10]],
    [0.65, [255, 226, 140], [255, 160, 52], [150, 64, 12]],
  ];
  function hpTone(k) {
    let a = HP_TONES[0], b = HP_TONES[0];
    for (let i = 0; i < HP_TONES.length; i++) { if (k >= HP_TONES[i][0]) { a = HP_TONES[i]; b = HP_TONES[Math.min(i + 1, HP_TONES.length - 1)]; } }
    const span = b[0] - a[0], m = span > 0 ? clamp((k - a[0]) / span, 0, 1) : 0;
    const out = [];
    for (let j = 1; j <= 3; j++) {
      out.push(Math.round(a[j][0] + (b[j][0] - a[j][0]) * m) + ',' + Math.round(a[j][1] + (b[j][1] - a[j][1]) * m) + ',' + Math.round(a[j][2] + (b[j][2] - a[j][2]) * m));
    }
    return out;
  }

  /* 液面右缘的竖直波浪：两路正弦叠加，受击后振幅放大再衰减 */
  function waveX(yy, ty, th, t) {
    const A = th * (0.16 + 0.35 * hpFx.slosh);
    const p = (yy - ty) / th * Math.PI * 2;
    return A * Math.sin(p * 1.15 + t * 5.2) + A * 0.45 * Math.sin(p * 2.6 - t * 8.3);
  }

  /* 玻璃管 + 光液：凹槽底 → 残血段 → 光液（竖直波浪前沿）→ 气泡 → 弯月面高光 → 刻度 → 管壁高光 */
  function hpTube(ctx, tx, ty, tw, th, u, t) {
    const show = clamp(hpFx.show, 0, 1), ghost = clamp(hpFx.ghost, 0, 1);
    const tone = hpTone(show);
    const c = th * 0.32;
    ctx.save();
    chamfer(ctx, tx, ty, tw, th, c);
    const rg = ctx.createLinearGradient(0, ty, 0, ty + th);
    rg.addColorStop(0, 'rgba(4,2,1,0.95)'); rg.addColorStop(1, 'rgba(30,16,8,0.9)');
    ctx.fillStyle = rg;
    ctx.fill();
    ctx.clip();
    if (ghost > show + 0.002) {
      ctx.fillStyle = 'rgba(255,236,200,' + (0.4 + 0.15 * Math.sin(t * 20)).toFixed(3) + ')';
      ctx.fillRect(tx + tw * show, ty, tw * (ghost - show), th);
    }
    const fx0 = tx + tw * show;
    if (show > 0.001) {
      const steps = 14;
      ctx.beginPath();
      ctx.moveTo(tx - 2, ty);
      for (let i = 0; i <= steps; i++) {
        const yy = ty + th * i / steps;
        ctx.lineTo(Math.max(tx, fx0 + waveX(yy, ty, th, t)), yy);
      }
      ctx.lineTo(tx - 2, ty + th);
      ctx.closePath();
      const lg = ctx.createLinearGradient(0, ty, 0, ty + th);
      lg.addColorStop(0, 'rgb(' + tone[0] + ')'); lg.addColorStop(0.5, 'rgb(' + tone[1] + ')'); lg.addColorStop(1, 'rgb(' + tone[2] + ')');
      ctx.fillStyle = lg;
      ctx.fill();
      /* 前沿最亮：液体在波峰处更厚、透光更强 */
      const eg = ctx.createLinearGradient(fx0 - th * 2.2, 0, fx0 + th * 0.3, 0);
      eg.addColorStop(0, 'rgba(255,240,200,0)'); eg.addColorStop(1, 'rgba(255,244,214,0.5)');
      ctx.fillStyle = eg;
      ctx.fill();
      /* 气泡：在液体里缓缓上浮，只画在液面以内 */
      for (let i = 0; i < 7; i++) {
        const bx = tx + ((i * 0.37 + 0.11) % 1) * tw * show;
        const by = ty + th * (1 - ((t * (0.35 + 0.09 * i) + i * 0.29) % 1));
        ctx.fillStyle = 'rgba(255,246,220,' + (0.22 + 0.12 * (i % 3)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(bx, by, th * (0.05 + 0.025 * (i % 3)), 0, Math.PI * 2); ctx.fill();
      }
      ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const yy = ty + th * i / steps, xx = Math.max(tx, fx0 + waveX(yy, ty, th, t));
          if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy);
        }
        ctx.strokeStyle = pass ? 'rgba(255,252,238,0.95)' : 'rgba(' + tone[0] + ',0.45)';
        ctx.lineWidth = pass ? Math.max(0.6, th * 0.07) : th * 0.3;
        ctx.stroke();
      }
    }
    /* 刻度：每 10% 一格，半程加长；画在液体上方像管壁上的蚀刻 */
    for (let i = 1; i < 10; i++) {
      const lx = tx + tw * i / 10, half = i === 5;
      ctx.fillStyle = 'rgba(20,8,2,' + (half ? 0.5 : 0.32) + ')';
      ctx.fillRect(lx - th * 0.025, ty + (half ? 0 : th * 0.55), Math.max(0.6, th * 0.05), half ? th : th * 0.45);
    }
    ctx.fillStyle = 'rgba(255,250,235,0.16)';
    ctx.fillRect(tx, ty + th * 0.1, tw, th * 0.22);
    ctx.restore();
    chamfer(ctx, tx, ty, tw, th, c);
    ctx.lineWidth = Math.max(0.6, th * 0.07);
    ctx.strokeStyle = 'rgba(255,214,150,0.55)';
    ctx.stroke();
    const heal = clamp(G.healPulse || 0, 0, 1);
    if (heal > 0.01) {
      ctx.lineWidth = th * 0.28;
      ctx.strokeStyle = 'rgba(190,255,150,' + (0.45 * heal).toFixed(3) + ')';
      ctx.stroke();
    }
    return { fx0: fx0, tone: tone };
  }

  /* HUD 血条卡片：和其他小组件同一套漆盒金边；残血时外框泛红呼吸 */
  function hpCard(ctx, x, y, w, h, u, t) {
    const hp = clamp(Math.round(G.hp != null ? G.hp : CFG.HP_MAX), 0, CFG.HP_MAX);
    const k = hp / CFG.HP_MAX;
    glass(ctx, x, y, w, h, 4 * u, 0.12);
    if (k <= 0.25 && G.state !== 'menu') {
      chamfer(ctx, x, y, w, h, 4 * u * 0.55);
      ctx.lineWidth = 0.9 * u;
      ctx.strokeStyle = 'rgba(255,60,40,' + (0.35 + 0.35 * Math.sin(t * 7)).toFixed(3) + ')';
      ctx.stroke();
    }
    /* 连串回血状态不在这里写字（窄屏会和数字打架），由管壁绿光 + 顶部胶囊「连串 N」表达 */
    widgetTitle(ctx, '生命 · 光液', x + 3 * u, y + 3.9 * u, u);
    text(ctx, '/' + CFG.HP_MAX, x + w - 3 * u, y + 4.1 * u, 2.1 * u, '600', 'rgba(255,255,255,0.55)', 'right');
    ctx.font = '600 ' + (2.1 * u).toFixed(2) + 'px ' + FONT;
    const slashW = ctx.measureText('/' + CFG.HP_MAX).width;
    text(ctx, '' + hp, x + w - 3.4 * u - slashW, y + 3.8 * u, 3.4 * u, '800', k <= 0.25 ? '#ff6b52' : '#ffe2a6', 'right');
    const tx = x + 3 * u, ty = y + 6.6 * u, tw = w - 6 * u, th = h - 9.4 * u;
    const r = hpTube(ctx, tx, ty, tw, th, u, t);
    for (let i = 0; i < hpFx.floats.length; i++) {
      const f = hpFx.floats[i], p = 1 - f.life / 0.9;
      ctx.globalAlpha = clamp(f.life / 0.4, 0, 1);
      text(ctx, '+' + f.v, Math.min(r.fx0, tx + tw - 3 * u), ty - p * 3 * u, 2.2 * u, '800', '#c8ff9a', 'center');
      ctx.globalAlpha = 1;
    }
  }

  /* 战场上的精简血条（合上时 HUD 看不见，这里必须也有）：小切角框 + 同一根光液管 + 右侧数字 */
  function hpMini(ctx, x, y, w, h, u, t) {
    const hp = clamp(Math.round(G.hp != null ? G.hp : CFG.HP_MAX), 0, CFG.HP_MAX);
    const k = hp / CFG.HP_MAX;
    const numW = 6 * u;
    chamfer(ctx, x, y, w, h, h * 0.45);
    ctx.fillStyle = 'rgba(30,14,6,0.82)';
    ctx.fill();
    ctx.lineWidth = Math.max(0.8, u * 0.32);
    ctx.strokeStyle = k <= 0.25 ? 'rgba(255,80,50,' + (0.6 + 0.4 * Math.sin(t * 7)).toFixed(3) + ')' : '#c8893c';
    ctx.stroke();
    const p = h * 0.24;
    hpTube(ctx, x + p, y + p, w - numW - p * 2, h - p * 2, u, t);
    text(ctx, '' + hp, x + w - numW / 2 - p * 0.3, y + h / 2, h * 0.56, '800', k <= 0.25 ? '#ff6b52' : '#ffe2a6', 'center');
  }

  /* 超载充能：每次完整开合点亮一颗菱形（半程亮一半）；超载中改为倒计时熔条 */
  function chargeRow(ctx, cx, y, u, t) {
    const N = Math.max(1, CFG.OVERLOAD_CYCLES | 0);
    const s = 1.5 * u, gap = 3.6 * u;
    const total = gap * (N - 1);
    if (G.overload > 0) {
      const k = clamp(G.overload / CFG.OVERLOAD_TIME, 0, 1);
      const bw = total + 6 * u, bh = 1.6 * u, bx = cx - bw / 2 + 2.5 * u;
      emoji(ctx, '⚡', bx - 3 * u, y, 2.8 * u);
      chamfer(ctx, bx, y - bh / 2, bw, bh, bh * 0.4);
      ctx.fillStyle = 'rgba(20,8,2,0.8)'; ctx.fill();
      const fl = 0.75 + 0.25 * Math.sin(t * 40);
      ctx.fillStyle = 'rgba(255,' + (220 + 35 * fl | 0) + ',' + (170 + 80 * fl | 0) + ',1)';
      ctx.fillRect(bx, y - bh / 2, bw * k, bh);
      text(ctx, G.overload.toFixed(1) + 's', bx + bw + 1.2 * u, y, 2 * u, '800', '#fff2c8', 'left');
      return;
    }
    const halves = clamp(G.foldHalves || 0, 0, N * 2);
    const x0 = cx - total / 2 + 1.5 * u;
    /* 次数用尽后菱形改朱砂色警示：此时攒满不是超载而是报废 */
    const left = G.overloadCharges != null ? G.overloadCharges : CFG.OVERLOAD_CHARGES;
    const doomed = left <= 0;
    ctx.globalAlpha = 0.85;
    emoji(ctx, doomed ? '☠️' : '⚡', x0 - 3.6 * u, y, 2.4 * u);
    ctx.globalAlpha = 1;
    text(ctx, '剩' + left, x0 + total + 2.6 * u, y, 2 * u, '800', doomed ? 'rgba(255,90,60,' + (0.7 + 0.3 * Math.sin(t * 8)).toFixed(3) + ')' : '#ffe2a6', 'left');
    for (let i = 0; i < N; i++) {
      const px = x0 + i * gap;
      const fill = clamp(halves / 2 - i, 0, 1);
      ctx.beginPath();
      ctx.moveTo(px, y - s); ctx.lineTo(px + s, y); ctx.lineTo(px, y + s); ctx.lineTo(px - s, y); ctx.closePath();
      ctx.fillStyle = 'rgba(20,8,2,0.7)'; ctx.fill();
      ctx.lineWidth = Math.max(0.6, 0.28 * u);
      ctx.strokeStyle = 'rgba(255,214,150,0.6)'; ctx.stroke();
      if (fill > 0) {
        ctx.save();
        ctx.clip();
        const ready = halves >= N * 2 - 1;
        ctx.fillStyle = doomed ? (ready ? 'rgba(255,60,40,' + (0.7 + 0.3 * Math.sin(t * 18)).toFixed(3) + ')' : '#d8402a')
          : ready ? 'rgba(255,250,220,' + (0.75 + 0.25 * Math.sin(t * 14)).toFixed(3) + ')' : '#ffb04a';
        ctx.fillRect(px - s, y + s - 2 * s * fill, 2 * s, 2 * s * fill);
        ctx.restore();
      }
    }
  }

  /* 右缘烧穿：缺口在光束出口最深，沿边缘向上下变浅；熔边超载时白热、结束后冷却成暗红余烬；
   * 缺口外侧是坏线（彩色竖线闪烁）和朝左的裂纹。本局永久保留，级数越高越深 */
  function burnEdge(ctx, w, h, t) {
    const b = fx.burn;
    if (!b) return;
    const by = clamp((G.beamY > 0 ? G.beamY : G.AH * CFG.BEAM_Y_FRAC) / (G.AH || 640), 0, 1);
    const depth = w * Math.min(0.2, 0.05 + 0.03 * b.level);
    const grow = clamp(b.age / 0.6, 0, 1);
    const n = b.rim.length - 1;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const yy = i / n;
      const focus = 0.25 + 0.75 * Math.exp(-Math.pow((yy - by) / 0.16, 2));
      pts.push([w - depth * focus * b.rim[i] * grow, yy * h]);
    }
    const heat = G.overload > 0 ? 1 : Math.max(0.18, Math.exp(-b.cool / 2.2));
    const dMax = depth * grow;
    for (let i = 0; i < b.lines.length; i++) {
      const ln = b.lines[i];
      const lx = w - dMax - ln.dx * w;
      ctx.globalAlpha = 0.22 + 0.2 * Math.sin(t * ln.f + i);
      ctx.fillStyle = 'rgb(' + ln.c + ')';
      ctx.fillRect(lx, ln.y0 * h, ln.w, (ln.y1 - ln.y0) * h);
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(w + 2, -2);
    for (let i = 0; i <= n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineTo(w + 2, h + 2);
    ctx.closePath();
    ctx.fillStyle = '#020101';
    ctx.fill();
    ctx.lineJoin = 'round';
    const hot = heat > 0.6 ? '255,250,230' : '255,' + (120 + 120 * heat | 0) + ',' + (40 + 120 * heat | 0);
    const layers = [[h * 0.03, 0.12], [h * 0.012, 0.35], [h * 0.004, 0.9]];
    for (let L = 0; L < layers.length; L++) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) { if (i) ctx.lineTo(pts[i][0], pts[i][1]); else ctx.moveTo(pts[i][0], pts[i][1]); }
      ctx.lineWidth = layers[L][0] * (L < 2 ? 0.6 + 0.4 * heat : 1);
      ctx.strokeStyle = 'rgba(' + (L === 2 ? hot : EMBER_RGB) + ',' + (layers[L][1] * (0.4 + 0.6 * heat)).toFixed(3) + ')';
      ctx.stroke();
    }
    const ox = w - dMax, oy = by * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = Math.max(0.5, h * 0.003);
    for (let r = 0; r < b.rays.length; r++) {
      const ray = b.rays[r];
      ctx.beginPath();
      for (let p = 0; p < ray.length; p++) {
        const px = ox + ray[p][0] * h * grow, py = oy + (r - b.rays.length / 2) * h * 0.012 + ray[p][1] * h * grow;
        if (p) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
    }
  }

  /* 彩蛋「应用孤岛」：没适配大屏的 App 只肯开成手机宽，孤零零悬在展开内屏正中，四周全黑。
   * 内屏是左右两张贴图拼的：左半 HUD 传 off=0，右半战场传 off=-w，两边各画一半，接缝落在折痕上 */
  const ISLE_CHATS = [
    ['🔦', '激光大师官方', '您的光束已到账，请查收', '刚刚', 2],
    ['🍉', '水果摊老板', '今天的西瓜又被串走三个', '21:07', 1],
    ['🛠️', '菠萝售后客服', '折痕漏液不在保修范围内', '20:45', 0],
    ['📁', '文件传输助手', '[图片] 光剑使用说明.png', '昨天', 0],
    ['🍍', '菠萝家族群', '你们谁见过折叠屏真机？', '昨天', 9],
    ['🔥', '夜市摊位', '炭火已经点好了', '周二', 0],
  ];
  function appIsland(ctx, w, h, off, a) {
    const u = h / 100;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(off, 0);
    const ah = h * 0.86, aw = Math.min(ah * 9 / 19.5, w * 1.6), ax = w - aw / 2, ay = (h - ah) / 2;
    rrect(ctx, ax, ay, aw, ah, [2 * u, 2 * u, 2 * u, 2 * u]);
    ctx.fillStyle = '#ededed';
    ctx.fill();
    ctx.save();
    ctx.clip();
    const s = aw / 46;   // 窗口内排版单位：以 46 单位宽设计
    const ck = clockText();
    text(ctx, ck.hm, ax + 4 * s, ay + 3.2 * s, 2.4 * s, '700', '#111', 'left');
    rrect(ctx, ax + aw - 7.6 * s, ay + 2.4 * s, 4.4 * s, 1.8 * s, [0.5 * s, 0.5 * s, 0.5 * s, 0.5 * s]);
    ctx.fillStyle = '#111'; ctx.fill();
    text(ctx, '消息(12)', ax + aw / 2, ay + 8.4 * s, 2.8 * s, '700', '#111', 'center');
    text(ctx, '⊕', ax + aw - 4.4 * s, ay + 8.4 * s, 3.2 * s, '400', '#111', 'center');
    rrect(ctx, ax + 3 * s, ay + 11.6 * s, aw - 6 * s, 3.6 * s, [0.8 * s, 0.8 * s, 0.8 * s, 0.8 * s]);
    ctx.fillStyle = '#fff'; ctx.fill();
    text(ctx, '🔍 搜索', ax + aw / 2, ay + 13.4 * s, 2 * s, '500', '#aaa', 'center');
    const rowH = 7.4 * s;
    let ry = ay + 16.8 * s;
    for (let i = 0; i < ISLE_CHATS.length && ry + rowH < ay + ah - 9 * s; i++, ry += rowH) {
      const c = ISLE_CHATS[i];
      ctx.fillStyle = i === 0 ? '#e2e2e2' : '#f7f7f7';
      ctx.fillRect(ax, ry, aw, rowH);
      rrect(ctx, ax + 3 * s, ry + 1.2 * s, 5 * s, 5 * s, [0.9 * s, 0.9 * s, 0.9 * s, 0.9 * s]);
      ctx.fillStyle = ['#ffd9a8', '#c9f0c0', '#cfe2ff', '#ffe9a0', '#ffd0d0', '#ffc9a0'][i % 6];
      ctx.fill();
      emoji(ctx, c[0], ax + 5.5 * s, ry + 3.7 * s, 3.2 * s);
      if (c[4] > 0) {
        ctx.fillStyle = '#fa5151';
        ctx.beginPath(); ctx.arc(ax + 8 * s, ry + 1.4 * s, 1.15 * s, 0, Math.PI * 2); ctx.fill();
        text(ctx, '' + c[4], ax + 8 * s, ry + 1.45 * s, 1.4 * s, '700', '#fff', 'center');
      }
      text(ctx, c[1], ax + 10 * s, ry + 2.5 * s, 2.2 * s, '600', '#111', 'left');
      text(ctx, c[2], ax + 10 * s, ry + 5.2 * s, 1.8 * s, '400', '#999', 'left');
      text(ctx, c[3], ax + aw - 3 * s, ry + 2.5 * s, 1.6 * s, '400', '#b2b2b2', 'right');
      ctx.fillStyle = '#e5e5e5';
      ctx.fillRect(ax + 10 * s, ry + rowH - 0.15 * s, aw - 10 * s, 0.15 * s);
    }
    const tabY = ay + ah - 8.6 * s;
    ctx.fillStyle = '#f7f7f7';
    ctx.fillRect(ax, tabY, aw, 8.6 * s);
    ctx.fillStyle = '#ddd';
    ctx.fillRect(ax, tabY, aw, 0.15 * s);
    const tabs = [['💬', '消息'], ['👥', '通讯录'], ['🧭', '发现'], ['👤', '我']];
    for (let i = 0; i < tabs.length; i++) {
      const tx = ax + aw * (i + 0.5) / tabs.length;
      ctx.globalAlpha = a * (i === 0 ? 1 : 0.55);
      emoji(ctx, tabs[i][0], tx, tabY + 2.6 * s, 2.6 * s);
      text(ctx, tabs[i][1], tx, tabY + 5.3 * s, 1.5 * s, '600', i === 0 ? '#07c160' : '#333', 'center');
    }
    ctx.globalAlpha = a;
    rrect(ctx, ax + aw / 2 - 7 * s, ay + ah - 1.6 * s, 14 * s, 0.7 * s, [0.35 * s, 0.35 * s, 0.35 * s, 0.35 * s]);
    ctx.fillStyle = '#111'; ctx.fill();
    ctx.restore();
    /* 只在左侧黑边写一行小字，点明梗 */
    if (off === 0 && ax > 16 * u) text(ctx, '此应用尚未适配折叠屏', ax / 2, h * 0.94, 2 * u, '500', 'rgba(255,255,255,0.32)', 'center');
    ctx.restore();
  }

  /* 随机事件「应用孤岛」的遮罩强度：跟着 fold 走而不是按时间淡入，合上时为 0，外屏视野始终完整 */
  function isleK() {
    const st = G.state;
    if (!(G.isleRounds > 0) || (st !== 'playing' && st !== 'paused')) return 0;
    return clamp(((G.fold || 0) - CFG.FOLD_CLOSED_T) / 0.2, 0, 1);
  }

  PA.isleK = isleK;

  /* 把合上时的外屏画面（scene = 本帧完整战场贴图）原样搬进一块单屏宽、骑在折痕上的窗口，两侧外半屏全黑：
   * HUD 侧右半显示 scene 左半，战场侧左半显示 scene 右半。画进贴图里，翻折时的模糊照常作用 */
  PA.drawIsleMask = function (ctx, w, h, side, scene) {
    const k = isleK();
    if (k <= 0 || !scene) return;
    const u = h / 100, r = 2.4 * u, hud = side === 'hud';
    const sw = scene.width / 2, sh = scene.height;
    ctx.save();
    ctx.globalAlpha = k;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (hud) {
      text(ctx, '此应用尚未适配折叠屏', w / 4, h * 0.9, 2 * u, '500', 'rgba(255,255,255,0.32)', 'center');
      text(ctx, '再合上 ' + G.isleRounds + ' 次恢复', w / 4, h * 0.94, 1.8 * u, '500', 'rgba(255,255,255,0.24)', 'center');
    }
    /* 圆角只在窗口外缘，折痕处两半要无缝拼上 */
    rrect(ctx, hud ? w / 2 : 0, 0, w / 2, h, hud ? [r, 0, 0, r] : [0, r, r, 0]);
    ctx.clip();
    ctx.drawImage(scene, hud ? 0 : sw, 0, sw, sh, hud ? w / 2 : 0, 0, w / 2, h);
    ctx.restore();
  };

  /* 左半 HUD（展开后才看到）：时钟 + 战况环（连击/分数/最佳）+ 最近串到 + 应用坞 */
  PA.drawHud = function (ctx, w, h, t, scene) {
    const u = h / 100;
    const ck = clockText();
    wallpaper(ctx, w, h, t, 0.22);
    statusBar(ctx, 5 * u, w - 6 * u, 4.5 * u, u, ck.hm);
    const lx = 4 * u, lw = w - 8 * u;
    text(ctx, ck.date, w / 2, 14 * u, 2.6 * u, '600', 'rgba(255,255,255,0.8)', 'center');
    text(ctx, ck.hm, w / 2, 24 * u, Math.min(13 * u, lw * 0.34), '700', '#fff', 'center');

    const cardY = 33 * u, cardH = 27 * u;
    glass(ctx, lx, cardY, lw, cardH, 4 * u);
    widgetTitle(ctx, '战况 · 穿刺', lx + 3 * u, cardY + 4.5 * u, u);
    const R = Math.min(cardH * 0.34, lw * 0.22);
    rings(ctx, lx + 3 * u + R, cardY + cardH * 0.58, R, u);
    const tx = lx + 7 * u + R * 2;
    text(ctx, '×' + Math.max(1, Math.min(G.combo || 0, CFG.COMBO_MAX)), tx, cardY + 11 * u, 3.6 * u, '800', 'rgb(' + RING_COLORS[0] + ')', 'left');
    text(ctx, '' + (G.score || 0), tx, cardY + 17 * u, 3.6 * u, '800', 'rgb(' + RING_COLORS[1] + ')', 'left');
    text(ctx, '最佳 ' + (G.best || 0), tx, cardY + 22.5 * u, 2.3 * u, '600', 'rgb(' + RING_COLORS[2] + ')', 'left');

    const ry = 62.5 * u;
    glass(ctx, lx, ry, lw, 15 * u, 4 * u);
    widgetTitle(ctx, '最近串到 · 本局 ' + fx.count, lx + 3 * u, ry + 4.3 * u, u);
    if (fx.recent.length) {
      const n = Math.min(fx.recent.length, Math.max(1, Math.floor((lw - 4 * u) / (6.5 * u))));
      for (let i = 0; i < n; i++) emoji(ctx, fx.recent[i], lx + 5.5 * u + i * 6.5 * u, ry + 10 * u, 5 * u);
    } else {
      text(ctx, G.state === 'menu' ? '点「开合开始」串第一串' : '光束待命中…', lx + 3 * u, ry + 10 * u, 2.3 * u, '600', 'rgba(255,255,255,0.7)', 'left');
    }

    hpCard(ctx, lx, 80 * u, lw, 16 * u, u, t);

    PA.drawIsleMask(ctx, w, h, 'hud', scene);   // 通知画在窗口之上，触发提示不能被盖掉
    notes(ctx, w / 2, 2.5 * u, lw, u);
    cracks(ctx, w, h);
    if (G.state === 'gameover') gameoverTint(ctx, w, h, u);
    if (fx.isle > 0) appIsland(ctx, w, h, 0, fx.isle);
  };

  /* 结算：屏幕随机花屏条纹 → 渐暗，像漏液后烧屏 */
  function gameoverTint(ctx, w, h, u) {
    const k = clamp(fx.deadT / 1.2, 0, 1);
    if (fx.deadT < 0.9) {
      for (let i = 0; i < 5; i++) {
        const y = Math.random() * h;
        ctx.fillStyle = ['rgba(255,0,140,0.5)', 'rgba(0,255,200,0.45)', 'rgba(255,255,255,0.4)'][i % 3];
        ctx.fillRect(0, y, w, (0.5 + Math.random() * 2) * u);
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,' + (0.55 * k) + ')';
    ctx.fillRect(0, 0, w, h);
  }

  /* 顶部胶囊：游戏中展开成战况条（左侧 🍢 + 连击，右侧分数）；菜单时显示游戏名 */
  function island(ctx, cx, y, u) {
    const live = G.state === 'playing' || G.state === 'paused' || G.state === 'countdown';
    const combo = G.combo || 0;
    const fresh = clamp((G.comboTimer || 0) / CFG.COMBO_WINDOW, 0, 1);
    const ww = (live ? 44 : 34) * u + (combo >= 2 ? 4 * u * fresh : 0);
    const hh = 7 * u;
    rrect(ctx, cx - ww / 2, y, ww, hh, [hh / 2, hh / 2, hh / 2, hh / 2]);
    ctx.fillStyle = '#000';
    ctx.fill();
    if (!live) {
      text(ctx, '🔦 激光大师', cx, y + hh / 2, hh * 0.42, '700', 'rgba(255,255,255,0.8)', 'center');
      return;
    }
    emoji(ctx, '🍢', cx - ww / 2 + hh * 0.62, y + hh / 2, hh * 0.62);
    if (combo >= 2) text(ctx, '×' + combo, cx - ww / 2 + hh * 1.2, y + hh / 2, hh * 0.46, '800', '#ffb04a', 'left');
    /* 中间：超载时闪烁警示，平时显示连串数（≥门槛即在回血） */
    if (G.overload > 0) {
      const fl = 0.6 + 0.4 * Math.sin(G.overloadT * 30);
      text(ctx, '⚡ 超载', cx, y + hh / 2, hh * 0.42, '900', 'rgba(255,' + (150 + 90 * fl | 0) + ',60,1)', 'center');
    } else if ((G.streak || 0) >= CFG.STREAK_MIN) {
      text(ctx, '连串 ' + G.streak, cx, y + hh / 2, hh * 0.38, '800', '#ffcf7a', 'center');
    }
    text(ctx, '' + (G.score || 0), cx + ww / 2 - hh * 0.6, y + hh / 2, hh * 0.46, '800', '#ffd75e', 'right');
  }

  /* 战场背景（右半显示区，合上即外屏）：暗壁纸 + 顶部胶囊，压暗保证水果可读 */
  PA.drawArenaBg = function (ctx, w, h, t) {
    const u = h / 100;
    wallpaper(ctx, w, h, t + 40, 0.42);
    statusBar(ctx, 5 * u, w - 6 * u, 3.6 * u, u * 0.8, '');
    island(ctx, w / 2, 1.6 * u, u);
    burnEdge(ctx, w, h, t);
    if (G.state !== 'menu') {
      /* 展开后左屏 HUD 已有血条卡片，这里的精简血条随展开淡出、超载行顶上来；
       * 合上（外屏）和孤岛期间（HUD 被盖住）仍需要它，所以按 fold 渐变而不是直接删 */
      const miniK = isleK() > 0 ? 1 : 1 - clamp(((G.fold || 0) - CFG.FOLD_CLOSED_T) / 0.2, 0, 1);
      if (miniK > 0) {
        ctx.globalAlpha = miniK;
        hpMini(ctx, 4 * u, 10.2 * u, w - 8 * u, 3.8 * u, u, t);
        ctx.globalAlpha = 1;
      }
      if (G.state !== 'gameover') chargeRow(ctx, w / 2, (11 + 6 * miniK) * u, u, t);
    }
    cracks(ctx, w, h);
    if (G.state === 'gameover') gameoverTint(ctx, w, h, u);
  };

  /* 战场最上层（光束、水果之后）：孤岛 App 要把光束一起盖住才像真的切了应用 */
  PA.drawArenaOver = function (ctx, w, h) {
    if (fx.isle > 0) appIsland(ctx, w, h, -w, fx.isle);
    if (G.state === 'countdown') countdownDigit(ctx, w, h);
  };

  /* 开局倒计时：画在战场上（开着、合着都能看到）。每秒一个数字，弹入放大后渐隐 */
  function countdownDigit(ctx, w, h) {
    const left = Math.max(0, G.countdown || 0);
    const n = Math.ceil(left);
    if (n <= 0) return;
    const p = 1 - (left - (n - 1));            // 本秒已过去的比例 0..1
    const pop = 1 - Math.pow(1 - Math.min(1, p / 0.25), 3);
    const size = h * 0.26 * (1.35 - 0.35 * pop);
    const a = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
    const cx = w / 2, cy = h * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.45 * a;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = a;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, size);
    rg.addColorStop(0, 'rgba(255,170,70,0.45)');
    rg.addColorStop(1, 'rgba(255,170,70,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(cx - size, cy - size, size * 2, size * 2);
    ctx.font = '900 ' + size.toFixed(1) + 'px ' + FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = size * 0.08;
    ctx.strokeStyle = 'rgba(70,20,4,0.9)';
    ctx.strokeText('' + n, cx, cy);
    ctx.fillStyle = '#ffe2a6';
    ctx.fillText('' + n, cx, cy);
    ctx.restore();
    text(ctx, '准备开合', cx, cy + h * 0.17, h * 0.03, '700', 'rgba(255,226,166,' + (0.8 * a).toFixed(3) + ')', 'center');
  }
})();
