/* ============================================================
 * 《激光大师 · Master Laser》主循环与 DOM 接线（main.js）
 * 职责：初始化时序（Render→Input→Game）、rAF 主循环、
 *       覆盖层显隐与文本同步、按钮/键盘、切后台自动暂停。
 * ============================================================ */
(function () {
  'use strict';

  /* 结算随机语录（梗向，可随意增删） */
  var GAMEOVER_LINES = [
    '我们为折痕负责。——菠萝高管',
    '菠萝售后已为你预约，请勿暴力开合。',
    '漏液不是故障，是光束熄灭了。',
    '建议贴一张哑光膜冷静一下。',
    '折痕，是光进来的地方。',
  ];

  /* 超载次数用尽后再超载 → 手机报废，另一套标题与语录 */
  var BROKEN_LINES = [
    '已超出保修范围：人为超载。——菠萝售后',
    '折痕撑住了，主板没撑住。',
    '光剑太亮，手机先走一步。',
    '建议换一台不会漏液的。',
  ];

  /* 开局前的玩法简介：逐页翻，最后一页按钮变成「开始游戏」 */
  var INTRO_PAGES = [
    { icon: '🍢', title: '折痕漏液，就是光剑', body: '手机折痕里射出一道光束。<br>按住<b>左半屏</b>拖动翻盖：左拉展开，右推合上。<br>开得越大，光束越长。' },
    { icon: '🍉', title: '串水果', body: '水果从下方抛上来，上升和落回时各穿一次光束线。<br>穿线时碰到光束<b>任意位置</b>就算串到。<br>2 秒内连续串到，倍率最高 ×5。' },
    { icon: '💣', title: '躲炸弹', body: '炸弹碰到光束就炸，扣 <b>20</b> 血；漏掉炸弹不罚。<br>看到炸弹就合上，让它从光束尖端外飞过。<br>水果漏接扣 <b>5</b> 血。' },
    { icon: '💚', title: '连串回血', body: '不被炸、不漏接地连续串到叫「连串」。<br>连串 3 个起每串 1 个回 1 血。<br>连串中被打断会重罚：炸弹 <b>25</b>、漏接 <b>10</b>。<br>炸弹压到光束上方的<b>绿光带</b>，再从尖端外落下没炸，算「擦弹」，回 1 血。' },
    { icon: '⚡', title: '激光超载', body: '完整开合 6 次（合上↔全开）触发 5 秒超载：<br>光束射穿右屏、炸弹被熔掉不扣血、得分 ×2。<br>结束后整机<b>模糊 3 秒</b>，水果变成平时的 <b>3 倍</b>，<br>而且所有东西都看成炸弹：<br>其实是水果的，串到或漏掉都不扣血；真炸弹照样扣。' },
    { icon: '☠️', title: '超载有次数', body: '每局只能超载 <b>3</b> 次，HUD 上的「剩 N」就是余量。<br>次数用完再攒满开合，手机<b>直接报废</b>，血再多也没用。<br>连串每满 <b>15</b> 个恢复 1 次。' },
  ];

  var last = 0;        // 上一帧时间戳
  var lastState = '';  // 状态迁移检测
  var els = {};        // DOM 缓存
  var introPage = -1;  // 简介当前页；-1 = 未打开。简介只是 DOM 层状态，G.state 仍是 menu

  function renderIntro() {
    var p = INTRO_PAGES[introPage];
    els.introIcon.textContent = p.icon;
    els.introTitle.textContent = p.title;
    els.introBody.innerHTML = p.body;   // 文案是上面写死的常量，不含外部输入
    els.introStep.textContent = (introPage + 1) + ' / ' + INTRO_PAGES.length;
    var lastPage = introPage === INTRO_PAGES.length - 1;
    els.btnIntroNext.firstChild.textContent = lastPage ? '开始游戏' : '下一页';
    els.btnIntroPrev.disabled = introPage === 0;
    els.introDisclaimer.hidden = introPage !== 0;
    els.btnIntroSkip.hidden = lastPage;   // 最后一页「开始游戏」已等价于跳过
  }

  function openIntro() {
    introPage = 0;
    els.menu.classList.add('hidden');
    els.intro.classList.remove('hidden');
    renderIntro();
  }

  function closeIntro() {
    introPage = -1;
    els.intro.classList.add('hidden');
  }

  function introNext() {
    if (introPage < 0) return;
    if (introPage < INTRO_PAGES.length - 1) { introPage++; renderIntro(); return; }
    closeIntro();
    Game.startGame();
  }

  function introPrev() {
    if (introPage > 0) { introPage--; renderIntro(); }
  }

  /* 跳过剩余简介，直接进入 3-2-1 倒计时 */
  function introSkip() {
    if (introPage < 0) return;
    closeIntro();
    Game.startGame();
  }

  /* 覆盖层只在状态迁移时动 DOM，文本一次写全 */
  function syncOverlays() {
    if (G.state === lastState) return;
    lastState = G.state;
    els.menu.classList.toggle('hidden', G.state !== 'menu' || introPage >= 0);
    els.gameover.classList.toggle('hidden', G.state !== 'gameover');
    els.pause.classList.toggle('hidden', G.state !== 'paused');
    if (G.state === 'menu') {
      els.menuBest.textContent = G.best || 0;
    } else if (G.state === 'gameover') {
      els.scoreFinal.textContent = G.score || 0;
      els.bestFinal.textContent = G.best || 0;
      var broken = G.endReason === 'broken';
      var lines = broken ? BROKEN_LINES : GAMEOVER_LINES;
      els.gameoverTitle.textContent = broken ? '手机报废' : '光束熄灭';
      els.gameoverReason.textContent = broken ? '超载次数已用尽，强行超载烧坏了主板' : '光液耗尽';
      els.gameover.classList.toggle('is-broken', broken);
      els.gameoverLine.textContent = lines[(Math.random() * lines.length) | 0];
    }
  }

  /* 声音开关按钮与 M 键共用：切静音、同步文案，解除静音时"嗒"一声确认 */
  function toggleSfx() {
    Sfx.toggleMuted();
    syncSfxBtn();
    if (!Sfx.muted()) Sfx.play('click');
  }

  function syncSfxBtn() {
    var m = Sfx.muted();
    els.btnSfx.textContent = m ? '🔇 声音：关' : '🔊 声音：开';
    els.btnSfx.setAttribute('aria-pressed', m ? 'false' : 'true');
  }

  function frame(now) {
    var dt = last ? (now - last) / 1000 : 0;
    last = now;
    Input.update(dt);
    Game.update(dt);
    Sfx.update(dt);      // 排空音效事件队列 + 光束嗡鸣/磁吸等轮询音
    Render.draw(dt);
    syncOverlays();
    requestAnimationFrame(frame);
  }

  function boot() {
    els = {
      menu: document.getElementById('overlay-menu'),
      gameover: document.getElementById('overlay-gameover'),
      pause: document.getElementById('overlay-pause'),
      btnStart: document.getElementById('btn-start'),
      btnRestart: document.getElementById('btn-restart'),
      menuBest: document.getElementById('menu-best'),
      scoreFinal: document.getElementById('score-final'),
      bestFinal: document.getElementById('best-final'),
      gameoverLine: document.getElementById('gameover-line'),
      gameoverTitle: document.getElementById('t-go'),
      gameoverReason: document.getElementById('gameover-reason'),
      intro: document.getElementById('overlay-intro'),
      introIcon: document.getElementById('intro-icon'),
      introTitle: document.getElementById('t-intro'),
      introBody: document.getElementById('intro-body'),
      introStep: document.getElementById('intro-step'),
      introDisclaimer: document.getElementById('intro-disclaimer'),
      btnIntroNext: document.getElementById('btn-intro-next'),
      btnIntroPrev: document.getElementById('btn-intro-prev'),
      btnIntroSkip: document.getElementById('btn-intro-skip'),
      btnSfx: document.getElementById('btn-sfx'),
    };

    Render.init();   // 内部先 resize，G.W/G.H 就位
    Input.init();
    Game.init();
    Sfx.init();

    /* 从菜单开始都先看简介；结算页「再来一局」直接开打 */
    els.btnStart.addEventListener('click', function () {
      els.btnStart.blur();   // 防止随后按 Space 误触按钮
      Sfx.play('click');
      openIntro();
    });
    els.btnIntroNext.addEventListener('click', function () {
      els.btnIntroNext.blur();
      Sfx.play('click');
      introNext();
    });
    els.btnIntroPrev.addEventListener('click', function () {
      els.btnIntroPrev.blur();
      Sfx.play('click');
      introPrev();
    });
    els.btnIntroSkip.addEventListener('click', function () {
      els.btnIntroSkip.blur();
      Sfx.play('click');
      introSkip();
    });
    els.btnRestart.addEventListener('click', function () {
      els.btnRestart.blur();
      Sfx.play('click');
      Game.startGame();
    });
    els.btnSfx.addEventListener('click', function () {
      els.btnSfx.blur();
      toggleSfx();
    });

    /* 机身配色切换（纯表现，PhoneArt 自己存 localStorage） */
    var FINISH_NAMES = { night: '炭金黑', star: '月光白' };
    var swatches = document.querySelectorAll('.swatch');
    function syncFinish() {
      var key = PhoneArt.finishKey();
      for (var i = 0; i < swatches.length; i++) {
        swatches[i].setAttribute('aria-checked', swatches[i].getAttribute('data-finish') === key ? 'true' : 'false');
      }
      document.getElementById('finish-name').textContent = FINISH_NAMES[key] || '';
    }
    for (var s = 0; s < swatches.length; s++) {
      swatches[s].addEventListener('click', function (e) {
        PhoneArt.setFinish(e.currentTarget.getAttribute('data-finish'));
        e.currentTarget.blur();
        Sfx.play('click');
        syncFinish();
      });
    }
    syncFinish();
    syncSfxBtn();   // 按上次的静音偏好显示文案

    window.addEventListener('keydown', function (e) {
      if (e.key === 'm' || e.key === 'M') {   // 任何界面随时切音效
        if (!e.repeat) toggleSfx();            // 按住不放会连发 keydown，只认第一下
        return;
      }
      if (introPage >= 0) {
        /* 简介打开时：Space/Enter/→ 下一页，← 上一页；方向键不再传给翻盖 */
        if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); Sfx.play('click'); introNext(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); Sfx.play('click'); introPrev(); }
        else if (e.key === 'Escape') { e.preventDefault(); Sfx.play('click'); introSkip(); }
        return;
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (G.state === 'menu') { Sfx.play('click'); openIntro(); }
        else if (G.state === 'gameover') { Sfx.play('click'); Game.startGame(); }
      } else if (e.key === 'p' || e.key === 'P') {
        if (G.state === 'playing' || G.state === 'paused') Game.togglePause();
      }
    });

    /* 切后台自动暂停，回来按 P 继续 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && G.state === 'playing') Game.togglePause();
    });

    window.addEventListener('resize', function () { Render.resize(); });

    lastState = '';
    syncOverlays();   // 首帧同步（menu）
    requestAnimationFrame(function (t) {
      last = t;
      requestAnimationFrame(frame);
    });
  }

  boot();
})();
