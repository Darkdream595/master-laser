/* ============================================================
 * 《激光大师 · Master Laser》游戏逻辑（game.js）
 * 职责：状态机、fold 平滑、光束几何、投射物生成（抛物线反解初速）、
 *       物理积分与判定（穿刺/炸弹/漏接）、计分连击、扣血、
 *       粒子/弹字/串签衰减、红闪灰闪震屏、最佳成绩 localStorage 存取。
 * 红线：不碰 DOM 与 canvas（唯一例外：localStorage 最佳成绩）。
 * ============================================================ */
(function () {
  'use strict';

  /* —— 模块内自用表现常量（纯表现/健壮性，§7 豁免，不进 CFG）—— */
  var DT_MAX = 0.05;        // 单帧 dt 上限，防切后台回来的巨步摧毁物理
  var FLASH_DECAY = 3;      // 红闪/灰闪线性衰减速率（约 0.33s 归零）
  var SHAKE_DECAY = 9;      // 震屏指数衰减系数
  var SHAKE_AMP = 10;       // 炸弹爆炸震屏振幅 px
  var POPUP_LIFE = 0.9;     // 弹字寿命 s
  var POPUP_RISE = 46;      // 弹字上飘速度 px/s
  var JUICE_N = 14;         // 果汁粒子数量
  var BOOM_N = 20;          // 爆炸粒子数量
  var MAX_PARTICLES = 320;  // 粒子上限，超出丢最旧
  var JUICE_COLORS = ['#ff5f6d', '#ffa24d', '#ffe08a', '#7de07d', '#ff8fb1'];
  var BOOM_COLORS = ['#ffd166', '#ff9d3c', '#9aa0a6', '#e8eaed'];
  var COLOR_GOLD = '#ffd75e';
  var COLOR_RED = '#ff6b6b';
  var COLOR_GRAY = '#c9ced6';
  var COLOR_GREEN = '#7dffa8';
  var GRAZE_N = 16;         // 擦弹绿光粒子数（无重力，散成一圈）
  var GRAZE_COLORS = ['#7dffa8', '#b6ffcf', '#4fe08a'];

  /* —— 小工具 —— */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function rand(a, b) { return a + Math.random() * (b - a); }

  function saveBest() {
    try { localStorage.setItem(CFG.BEST_KEY, String(G.best)); } catch (e) { /* 隐私模式等禁写 */ }
  }

  function addPopup(x, y, text, color) {
    G.popups.push({ x: x, y: y, text: text, color: color, life: POPUP_LIFE, maxLife: POPUP_LIFE });
  }

  /* 音效事件：只推纯数据，由 main 循环交给 Sfx 播放（本文件不碰 DOM，红线不破） */
  function pushSfx(name, v) { G.sfxQueue.push({ name: name, v: v }); }

  function addParticles(x, y, n, colors, spMin, spMax, g) {
    for (var i = 0; i < n; i++) {
      if (G.particles.length >= MAX_PARTICLES) G.particles.shift();
      var a = Math.random() * Math.PI * 2;
      var sp = rand(spMin, spMax);
      var life = rand(0.35, 0.8);
      G.particles.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: life, maxLife: life,
        size: rand(2, 5),
        color: colors[(Math.random() * colors.length) | 0],
        g: g,
      });
    }
  }

  /* —— 生成策略（接口）——
   * 每个策略 (isBomb, W) → { lo, hi, bias, guard }：
   *   穿越点在 [lo, hi] 内按 lo + (hi-lo)·u^bias 抽取（bias<1 偏右）；
   *   guard 非空时，升穿与落穿两个穿越点都必须 ≥ guard（保证合上手机时的最短光束能躲开）。
   * 挑战模式等新玩法用 Game.registerSpawnMode 注册，再 Game.setSpawnMode 切换。 */
  var SPAWN_MODES = {
    random: function (isBomb, W) {
      return { lo: CFG.CROSS_X_MIN * W, hi: CFG.CROSS_X_MAX * W, bias: 1, guard: null };
    },
    classic: function (isBomb, W) {
      if (!isBomb) return SPAWN_MODES.random(isBomb, W);
      var guard = CFG.BEAM_LEN_MIN * W + CFG.BOMB_R + 10;
      var lo = Math.max(CFG.BOMB_CROSS_X_MIN * W, guard);
      return { lo: lo, hi: Math.max(CFG.CROSS_X_MAX * W, lo), bias: CFG.BOMB_RIGHT_BIAS, guard: guard };
    },
  };
  var spawnMode = SPAWN_MODES[CFG.SPAWN_MODE] ? CFG.SPAWN_MODE : 'classic';

  /* 生成一个投射物：先抽穿越点与顶点，再反解初速，指哪打哪（SPEC §5） */
  function spawnOne(forceFruit) {
    var W = G.AW, g = CFG.GRAVITY;
    var y0 = G.AH + 40;                                            // 出生点：战场下缘外 40px
    var d = y0 - G.beamY;                                          // 出生点距光束线的竖直距离
    var isBomb = !forceFruit && CFG.BOMB_CHANCE > 0 && Math.random() < CFG.BOMB_CHANCE;
    var pol = SPAWN_MODES[spawnMode](isBomb, W);
    var x0 = 0, vx = 0, xc = 0, vy0 = 0, t1 = 0, t2 = 0, ok = false;
    for (var i = 0; i < 24; i++) {
      xc = pol.lo + (pol.hi - pol.lo) * Math.pow(Math.random(), pol.bias);
      var peak = rand(CFG.PEAK_MIN, CFG.PEAK_MAX);                 // 顶点高出光束线的距离
      vy0 = Math.sqrt(2 * g * (d + peak));                         // 顶点恰好高于光束线 peak
      var disc = Math.sqrt(vy0 * vy0 - 2 * g * d);
      t1 = (vy0 - disc) / g;                                       // 上升段穿越光束线时刻
      t2 = (vy0 + disc) / g;                                       // 下落段穿越光束线时刻
      vx = rand(CFG.VX_MIN, CFG.VX_MAX) * (Math.random() < 0.5 ? -1 : 1);
      x0 = xc - vx * t1;
      ok = x0 >= 30 && x0 <= W - 30 && (pol.guard == null || x0 + vx * t2 >= pol.guard);
      if (ok) break;
    }
    /* 兜底：守卫失败时改成向右飞，落穿点必在升穿点右侧，仍满足 guard */
    if (!ok && pol.guard != null) { vx = Math.abs(vx); x0 = xc - vx * t1; }
    x0 = clamp(x0, 30, Math.max(30, W - 30));
    G.fruits.push({
      id: G.fruitSeq++,
      type: isBomb ? 'bomb' : 'fruit',
      emoji: isBomb ? CFG.EMOJI_BOMB : CFG.EMOJI_FRUITS[(Math.random() * CFG.EMOJI_FRUITS.length) | 0],
      r: isBomb ? CFG.BOMB_R : CFG.FRUIT_R,
      x: x0, y: y0, vx: vx, vy: -vy0,
      pierced: false, dead: false,
    });
  }

  function updateSpawn(dt) {
    var k = Math.min(1, G.t / CFG.SPAWN_RAMP_TIME);
    var interval = lerp(CFG.SPAWN_INTERVAL0, CFG.SPAWN_INTERVAL_MIN, k);
    /* 超载后遗症：常规生成照旧，另开一路只丢水果，让水果期望数量 = 平常的 BLUR_FRUIT_MULT 倍。
     * 炸弹不加量：多出来的"炸弹"全是伪装的水果，惩罚靠认不出而不是更多真炸弹 */
    if (G.blurT > 0 && CFG.BLUR_FRUIT_MULT > 1) {
      G.blurSpawnTimer -= dt;
      if (G.blurSpawnTimer <= 0) {
        var fruitPerSpawn = (1 - CFG.BOMB_CHANCE) * (G.t > 45 ? 1.2 : 1);   // 一次常规生成的期望水果数（含 45s 后的加抛）
        G.blurSpawnTimer += interval / ((CFG.BLUR_FRUIT_MULT - 1) * Math.max(0.05, fruitPerSpawn));
        spawnOne(true);
      }
    } else {
      G.blurSpawnTimer = 0;   // 下次模糊开始时立刻补第一个
    }
    G.spawnTimer -= dt;
    if (G.spawnTimer > 0) return;
    G.spawnTimer = interval;
    spawnOne();
    if (G.t > 45 && Math.random() < 0.2) spawnOne();   // 45s 后 20% 概率多生成 1 个
  }

  /* fold 指数平滑逼近 foldTarget；每帧按当帧 W/H 重算光束与手机几何，不缓存绝对坐标 */
  function updateFold(dt) {
    G.fold += (G.foldTarget - G.fold) * (1 - Math.exp(-CFG.FOLD_SMOOTH * dt));
    G.beamY = G.AH * CFG.BEAM_Y_FRAC;
    G.phoneW = 0;                                       // v2.0 起战场原点就是折痕
    G.prevBeamLen = G.beamLen;
    /* 超载期间光束锁定满长并射出右屏，不随开合变化 */
    G.beamLen = G.overload > 0 ? G.AW * CFG.OVERLOAD_BEAM
      : G.AW * (CFG.BEAM_LEN_MIN + G.fold * (CFG.BEAM_LEN_MAX - CFG.BEAM_LEN_MIN));
  }

  /* 完整开合计数：fold 在"合上 / 全开"两个端点之间交替到达一次记半程，两个半程 = 1 次。
   * 超载期间不计数，只更新端点，结束后从当前端点重新起算 */
  function updateOverload(dt) {
    var f = G.fold;
    var at = f <= CFG.FOLD_CLOSED_T ? 'closed' : (f >= CFG.FOLD_OPEN_T ? 'open' : null);
    if (at && at !== G.lastExtreme) {
      if (G.lastExtreme && G.overload <= 0) G.foldHalves++;
      G.lastExtreme = at;
    }
    if (G.overload > 0) {
      G.overload -= dt;
      G.overloadT += dt;
      if (G.overload <= 0) {
        G.overload = 0;
        G.foldHalves = 0;
        G.blurT = CFG.OVERLOAD_BLUR_TIME;   // 超载后遗症：整机模糊，与开合无关
        pushSfx('overloadEnd');
      }
      return;
    }
    if (G.foldHalves >= CFG.OVERLOAD_CYCLES * 2) {
      /* 次数用完还硬要超载：不看血量，手机直接烧坏 */
      if (G.overloadCharges <= 0) { endGame('broken'); return; }
      G.overloadCharges--;
      G.overload = CFG.OVERLOAD_TIME;
      G.overloadT = 0;
      G.overloadCount++;
      G.foldHalves = 0;
      G.shake = SHAKE_AMP * 1.6;
      addPopup(G.AW * 0.5, G.beamY - 60, '⚡ 激光超载', COLOR_GOLD);
      pushSfx('overload');
    }
  }

  /* 随机事件「应用孤岛」：冷却走完后，只在离开合上的那一刻掷骰，合上时外屏视野完整，玩家是翻开才发现；
   * 全开→合上算 1 回合，满 ISLE_ROUNDS 回合在合上时结束，所以快速开合就能快速跳过 */
  function updateIsle(dt) {
    var closed = G.fold <= CFG.FOLD_CLOSED_T;
    if (G.isleRounds > 0) {
      if (G.fold >= CFG.FOLD_OPEN_T) G.isleOpened = true;
      if (closed && G.isleOpened) {
        G.isleOpened = false;
        G.isleRounds--;
        if (G.isleRounds <= 0) G.isleCool = CFG.ISLE_COOLDOWN;
      }
    } else {
      G.isleCool = Math.max(0, G.isleCool - dt);
      if (G.isleWasClosed && !closed && G.isleCool <= 0 && Math.random() < CFG.ISLE_CHANCE) {
        G.isleRounds = CFG.ISLE_ROUNDS;
        G.isleOpened = false;
        G.isleSeq++;
      }
    }
    G.isleWasClosed = closed;
  }

  /* 结束一局：reason = 'hp'（血量归零）| 'broken'（超载次数用尽后再次超载） */
  function endGame(reason) {
    G.state = 'gameover';
    G.endReason = reason;
    G.combo = 0;
    G.overload = 0;
    G.isleRounds = 0;      // 结算画面要看得全
    G.best = Math.max(G.best, G.score);
    saveBest();            // 显示归 main.js
    pushSfx(reason === 'broken' ? 'broken' : 'gameover');
  }

  /* 扣血：连串（≥ STREAK_MIN）中被打断时一次性重罚，随后连串清零，下一次按普通数值 */
  function hurt(normal, inStreak) {
    var dmg = G.streak >= CFG.STREAK_MIN ? inStreak : normal;
    G.hp = Math.max(0, G.hp - dmg);
    G.streak = 0;
    return dmg;
  }

  /* 擦弹：回血但不碰连击与连串；满血时只给提示，避免"擦了却没反应"的困惑 */
  function graze(x, y) {
    var full = G.hp >= CFG.HP_MAX;
    if (!full) {
      G.hp = Math.min(CFG.HP_MAX, G.hp + CFG.GRAZE_HEAL);
      G.healPulse = 1;
    }
    addParticles(x, y - CFG.GRAZE_H * 0.5, GRAZE_N, GRAZE_COLORS, 80, 160, 0);
    addPopup(x, y - CFG.GRAZE_H - 10, full ? '擦弹' : '擦弹 +' + CFG.GRAZE_HEAL, COLOR_GREEN);
    pushSfx('graze');
  }

  /* 投射物物理 + 逐帧判定；judge=false（gameover）时只飞不判 */
  function updateFruits(dt, judge) {
    var beamY = G.beamY, beamLen = G.beamLen;
    for (var i = G.fruits.length - 1; i >= 0; i--) {
      var f = G.fruits[i];
      var prevY = f.y;
      f.vy += CFG.GRAVITY * dt;
      f.y += f.vy * dt;
      f.x += f.vx * dt;
      /* 左右墙反弹：位置按穿透量镜像回墙内，穿刺判定的线性插值在镜像轨迹上仍然成立 */
      var wallL = f.r, wallR = G.AW - f.r;
      if (f.x < wallL) { f.x = Math.min(wallR, 2 * wallL - f.x); f.vx = Math.abs(f.vx) * CFG.WALL_BOUNCE; }
      else if (f.x > wallR) { f.x = Math.max(wallL, 2 * wallR - f.x); f.vx = -Math.abs(f.vx) * CFG.WALL_BOUNCE; }
      if (judge && !f.pierced && !f.dead) {
        /* 擦弹预备：炸弹压在光束正上方的薄带里（身体与光束横向重叠）。
         * 只记标记，真正结算要等它穿过光束线且没被引爆，免得收短后又伸长炸到也算 */
        if (f.type === 'bomb' && !f.grazed && CFG.GRAZE_H > 0 &&
            f.y < beamY && f.y >= beamY - CFG.GRAZE_H && f.x >= 0 && f.x <= beamLen + f.r) {
          f.grazeArmed = true;
        }
        /* 穿越光束线判定（升穿一次 + 落穿一次，两次机会） */
        if ((prevY - beamY) * (f.y - beamY) < 0 && Math.abs(f.vy) >= CFG.PIERCE_MIN_VY) {
          var xc = f.x - (f.y - beamY) * f.vx / f.vy;  // 线性插值穿越点
          if (f.type === 'bomb') {
            if (xc >= 0 && xc <= beamLen) {                 // 炸进光束任意部位 → 爆炸
              f.dead = true;
              addParticles(xc, beamY, BOOM_N, BOOM_COLORS, 60, 320, 420);
              if (G.overload > 0) {
                /* 超载光束直接把炸弹熔掉：无伤害、不打断连串 */
                addPopup(xc, beamY, '熔毁 💥', COLOR_GOLD);
                pushSfx('melt');
              } else {
                var bd = hurt(CFG.DMG_BOMB, CFG.DMG_BOMB_STREAK);
                G.flashRed = 1;
                G.shake = SHAKE_AMP;
                G.buzzT = CFG.BUZZ_TIME;
                /* 部分安卓浏览器真机同步震；没有该接口或调用无效的平台静默跳过 */
                if (navigator.vibrate) { try { navigator.vibrate(Math.round(CFG.BUZZ_TIME * 1000)); } catch (e) {} }
                G.lastHurt = 'bomb';
                addPopup(xc, beamY, '-' + bd + ' 💥', COLOR_RED);
                pushSfx('bomb');
              }
            }
            /* 否则炸弹无惩罚，继续飞（漏掉不罚）；之前压在光束上方擦弹带里的，算擦弹 */
            else if (f.grazeArmed && !f.grazed) {
              f.grazed = true;
              graze(xc, beamY);
            }
          } else if (xc >= 4 && xc <= beamLen) {
            /* ★ 穿刺：光束任何部位（根部到尖端）都算 ★ */
            G.combo = (G.comboTimer > 0) ? G.combo + 1 : 1;
            G.comboTimer = CFG.COMBO_WINDOW;
            var mult = Math.min(G.combo, CFG.COMBO_MAX);
            var pts = CFG.SCORE_PER_PIERCE * mult * (G.overload > 0 ? CFG.OVERLOAD_SCORE_MULT : 1);
            G.score += pts;
            f.pierced = true;
            /* 连串：只被炸弹/漏接打断，与连击窗口无关；达到门槛后每串一个回血 */
            G.streak++;
            if (G.streak >= CFG.STREAK_MIN && G.hp < CFG.HP_MAX) {
              G.hp = Math.min(CFG.HP_MAX, G.hp + CFG.HEAL_STREAK);
              G.healPulse = 1;
            }
            /* 连串每满 OVERLOAD_RESTORE_STREAK 个恢复 1 次超载；满额时不累计 */
            if (G.streak % CFG.OVERLOAD_RESTORE_STREAK === 0 && G.overloadCharges < CFG.OVERLOAD_CHARGES) {
              G.overloadCharges++;
              addPopup(xc, beamY - 34, '⚡ 超载次数 +1', COLOR_GOLD);
              pushSfx('charge');
            }
            G.skewers.push({ x: xc, emoji: f.emoji, r: f.r, life: CFG.SKEWER_LIFE, maxLife: CFG.SKEWER_LIFE });
            addParticles(xc, beamY, JUICE_N, JUICE_COLORS, 50, 260, 520);
            addPopup(xc, beamY, mult > 1 ? '+' + pts + ' ×' + mult : '+' + pts, COLOR_GOLD);
            pushSfx('pierce', mult);
          }
          /* 否则：越过尖端飞过，不处理，等落穿或坠出屏幕 */
        }
      }
      if (f.y > G.AH + 80) {                           // 坠出战场
        /* 超载后遗症期间水果都伪装成炸弹，玩家躲开是合理反应，漏接不罚（连串也不打断） */
        if (judge && !f.pierced && !f.dead && f.type === 'fruit' && !(G.blurT > 0)) {
          var md = hurt(CFG.DMG_MISS, CFG.DMG_MISS_STREAK);   // 漏接
          G.flashGray = 1;
          G.lastHurt = 'miss';
          addPopup(clamp(f.x, 40, G.AW - 40), G.AH - 70, '-' + md + ' 漏接', COLOR_GRAY);
          pushSfx('miss');
        }
        G.fruits.splice(i, 1);
      }
    }
  }

  /* 串签/粒子/弹字衰减 + 红闪灰闪震屏衰减 */
  function updateEffects(dt) {
    var i;
    for (i = G.skewers.length - 1; i >= 0; i--) {
      G.skewers[i].life -= dt;
      if (G.skewers[i].life <= 0) G.skewers.splice(i, 1);
    }
    for (i = G.particles.length - 1; i >= 0; i--) {
      var p = G.particles[i];
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life <= 0) G.particles.splice(i, 1);
    }
    for (i = G.popups.length - 1; i >= 0; i--) {
      var q = G.popups[i];
      q.y -= POPUP_RISE * dt;
      q.life -= dt;
      if (q.life <= 0) G.popups.splice(i, 1);
    }
    G.flashRed = Math.max(0, G.flashRed - FLASH_DECAY * dt);
    G.flashGray = Math.max(0, G.flashGray - FLASH_DECAY * dt);
    G.shake = G.shake * Math.exp(-SHAKE_DECAY * dt);
    if (G.shake < 0.1) G.shake = 0;
    G.buzzT = Math.max(0, (G.buzzT || 0) - dt);
    G.healPulse = Math.max(0, (G.healPulse || 0) - 2.5 * dt);
  }

  /* SPEC §2：G.reset() 填充/清零运行时状态。
   * W/H 归 Render.resize 所有，这里只保留现值不清零（清零会在重开局时丢视口尺寸）。 */
  G.reset = function () {
    G.state = 'menu';
    G.t = 0;
    G.fold = 0.85;
    G.foldTarget = 0.85;
    if (typeof G.W !== 'number') G.W = 0;
    if (typeof G.H !== 'number') G.H = 0;
    if (typeof G.AW !== 'number') G.AW = 0;           // 战场逻辑尺寸归 Render.resize 所有
    if (typeof G.AH !== 'number') G.AH = 0;
    if (typeof G.snapSeq !== 'number') G.snapSeq = 0; // 铰链磁吸计数，input 写、render 读
    G.beamY = 0;
    G.phoneW = 0;
    G.beamLen = 0;
    G.prevBeamLen = 0;
    G.hp = CFG.HP_MAX;
    G.score = 0;
    if (typeof G.best !== 'number' || !isFinite(G.best)) G.best = 0;  // 保留 init 读入的最佳成绩
    G.combo = 0;
    G.comboTimer = 0;
    G.spawnTimer = 0;
    G.fruits = [];
    G.skewers = [];
    G.particles = [];
    G.popups = [];
    G.sfxQueue = [];      // 音效事件队列（纯数据），main 循环里由 Sfx 排空
    G.flashRed = 0;
    G.flashGray = 0;
    G.shake = 0;
    G.buzzT = 0;           // 被炸后的整机震动剩余 s，render 读
    G.fruitSeq = 1;
    G.streak = 0;          // 连串：连续串到且未被炸弹/漏接打断的个数
    G.healPulse = 0;       // 回血脉冲（表现用，1→0 衰减）
    G.lastHurt = null;     // 'bomb' | 'miss'，结算孤岛文案用
    G.foldHalves = 0;      // 端点交替次数，2 次 = 1 次完整开合
    G.lastExtreme = null;  // 'closed' | 'open'
    G.overload = 0;        // 超载剩余 s
    G.overloadT = 0;       // 本次超载已持续 s（表现用）
    G.overloadCount = 0;   // 本局超载次数；>0 时右缘永久损坏（表现）
    G.overloadCharges = CFG.OVERLOAD_CHARGES;   // 剩余可超载次数
    G.blurT = 0;           // 超载后整机模糊剩余 s；>0 时所有投射物显示成炸弹（纯表现，判定不变）
    G.blurSpawnTimer = 0;  // 模糊期间额外水果的生成计时
    G.countdown = 0;       // 开局倒计时剩余 s（state === 'countdown' 时有效）
    G.endReason = null;    // 'hp' | 'broken'
    G.isleRounds = 0;      // 应用孤岛剩余回合；>0 即事件进行中
    G.isleCool = CFG.ISLE_COOLDOWN;   // 距下次可触发的冷却 s
    G.isleOpened = false;  // 本回合是否已全开过
    G.isleWasClosed = false;          // 上一帧是否合上，用于捕捉"开始展开"的边沿
    if (typeof G.isleSeq !== 'number') G.isleSeq = 0;   // 触发计数，表现层据此弹通知
  };

  window.Game = {
    /* 读 localStorage 初始化最佳成绩，再填充 G */
    init: function () {
      G.best = 0;
      try {
        var v = parseInt(localStorage.getItem(CFG.BEST_KEY), 10);
        if (isFinite(v) && v > 0) G.best = v;
      } catch (e) { /* 隐私模式/file:// 下可能禁读 */ }
      G.reset();
    },

    /* 重开局：reset 后保留上次 fold 位置（手感延续），进入 playing */
    startGame: function () {
      var fold = (typeof G.fold === 'number') ? G.fold : 0.85;
      var target = (typeof G.foldTarget === 'number') ? G.foldTarget : fold;
      G.reset();
      G.fold = fold;
      G.foldTarget = target;
      /* 先 3-2-1 倒计时再进 playing；COUNTDOWN 设 0 则直接开打 */
      G.countdown = Math.max(0, CFG.COUNTDOWN || 0);
      G.state = G.countdown > 0 ? 'countdown' : 'playing';
      if (G.countdown > 0) pushSfx('tick');   // 起步就是"3"，整秒处再各哔一次
    },

    /* 生成策略接口：fn(isBomb, W) → { lo, hi, bias, guard }，见 SPAWN_MODES 注释 */
    registerSpawnMode: function (name, fn) {
      if (typeof name === 'string' && typeof fn === 'function') SPAWN_MODES[name] = fn;
    },
    setSpawnMode: function (name) {
      if (SPAWN_MODES[name]) spawnMode = name;
      return spawnMode;
    },
    spawnMode: function () { return spawnMode; },

    togglePause: function () {
      if (G.state === 'playing') G.state = 'paused';
      else if (G.state === 'paused') G.state = 'playing';
    },

    /* 纯逻辑主步进，按 state 分支（SPEC §5 状态表） */
    update: function (dt) {
      if (!(G.AW > 0) || !(G.AH > 0)) return; // 首帧前（resize 未发生）保护
      if (!(dt > 0)) return;
      if (dt > DT_MAX) dt = DT_MAX;
      if (G.state === 'paused') return;       // 全部冻结，渲染出静帧

      if (G.state === 'menu') {
        G.t += dt;
        /* 标题页自动全程开合，演示模糊动效与"应用孤岛"彩蛋；smoothstep 让两端停留更久 */
        var p = 0.5 - 0.5 * Math.cos(G.t * 0.55);
        G.foldTarget = p * p * (3 - 2 * p);
        updateFold(dt);
        updateEffects(dt);
        return;
      }

      if (G.blurT > 0) G.blurT = Math.max(0, G.blurT - dt);   // gameover 时也继续走完淡出

      if (G.state === 'countdown') {
        /* 倒计时：可以先把手机开合到想要的位置，但不生成、不判定、不计开合次数、不走游戏时钟 */
        updateFold(dt);
        updateEffects(dt);
        var prevTick = Math.ceil(G.countdown);
        G.countdown -= dt;
        if (G.countdown <= 0) {
          G.countdown = 0;
          G.state = 'playing';
          addPopup(G.AW * 0.5, G.beamY - 60, '开串！', COLOR_GOLD);
          pushSfx('go');
        } else if (Math.ceil(G.countdown) !== prevTick) {
          pushSfx('tick');
        }
        return;
      }

      if (G.state === 'gameover') {
        updateFold(dt);        // 折痕仍平滑，但不再生成/判定/积分
        updateFruits(dt, false);
        updateEffects(dt);     // 粒子、弹字、串签继续衰减到消失
        return;
      }

      /* playing：完整模拟 */
      G.t += dt;
      updateFold(dt);
      updateOverload(dt);
      if (G.state !== 'playing') { updateEffects(dt); return; }   // 本帧因超载损坏结束
      updateIsle(dt);
      G.comboTimer -= dt;
      if (G.comboTimer <= 0) { G.combo = 0; G.comboTimer = 0; }
      updateSpawn(dt);
      updateFruits(dt, true);
      updateEffects(dt);
      if (G.hp <= 0) endGame('hp');
    },
  };
})();
