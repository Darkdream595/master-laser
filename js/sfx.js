/* ============================================================
 * 《激光大师 · Master Laser》音效模块（sfx.js）
 * 职责：Web Audio 即时合成全部音效，零音频文件、零加载等待。
 *   · 事件音：game.js 只往 G.sfxQueue 推纯数据事件（不碰 DOM，红线不破），
 *     本模块每帧排空播放；main.js 的按钮/键盘音效直接调 Sfx.play。
 *   · 轮询音：铰链磁吸（snapSeq）、应用孤岛（isleSeq）由 update() 读 G 触发，
 *     input.js / game.js 都不依赖本模块。
 *   · 持续音：光束嗡鸣——fold 定音高、开合差速定响度、超载加激励。
 *   · 背景音乐：C 大调 lo-fi 和弦循环（电钢琶音 + pad + 低音），前瞻调度，
 *     解锁后常伴、暂停压低、静音即停，与音效共用总线受 M 键/按钮控制。
 * 约束：AudioContext 只在首次用户手势时创建（浏览器自动播放策略）；
 *       静音偏好持久化 localStorage；合成失败静默降级，绝不抛错影响游戏。
 * ============================================================ */
(function () {
  'use strict';

  var AC = window.AudioContext;
  var MUTE_KEY = 'crease_pierce_sfx_v1';   // 与 CFG.BEST_KEY 同风格的存储键
  var MASTER_VOL = 0.9;

  var ctx = null;         // AudioContext，unlock() 首次手势时创建
  var master = null;      // 主音量 → 压限器 → 扬声器（压限器防多音叠加爆音）
  var noiseBuf = null;    // 1s 白噪声缓存，所有噪声类音效共用
  var muted = false;

  /* —— 光束嗡鸣（常驻振荡器，gain 0 待命，省去频繁启停）—— */
  var humOscA = null, humOscB = null, humFilter = null, humGain = null;
  var humLevel = 0;       // 当前响度（指数平滑趋近目标）
  var humLastF = -1;      // 上次写入的嗡鸣频率，变化可感知时才写，少产生自动化事件

  /* —— 背景音乐：慢八分琶音的电钢 + 长 pad + 低音，C 大调 lo-fi 进行循环 —— */
  var bgmGain = null;     // BGM 总线（→ 低通 → master，柔化整体）
  var bgmLevel = 0;       // 当前响度（指数平滑）
  var bgmTimer = null;    // 前瞻调度器句柄
  var bgmStep = 0;        // 全局步数（八分音符个数）
  var bgmNext = 0;        // 下一音符的 ctx 时间
  var bgmNotes = 0;       // 已调度音符计数（Sfx.debug 验证用）

  /* —— 轮询音的上次序号 —— */
  var lastSnapSeq = 0;
  var lastIsleSeq = 0;

  var played = 0;         // 已播放事件音计数（Sfx.debug 验证用）

  /* —— 小工具 —— */
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function now() { return ctx.currentTime; }

  /* 通用包络：attack 线性起量，随后指数衰减到零（exponential 不接受 0，垫 0.0001） */
  function env(g, t0, vol, atk, dur) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  /* 单振荡器短音：type 音色、f0→f1 扫频、dur 总时长、when 相对现在的延迟 */
  function blip(type, f0, f1, dur, vol, when, atk) {
    var t0 = now() + (when || 0);
    var o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    var g = ctx.createGain();
    env(g, t0, vol, atk || 0.004, dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  /* 噪声短音：fo = { type, f0, f1, q } 描述串联滤波器，缺省不过滤 */
  function hiss(dur, vol, fo, when, atk) {
    var t0 = now() + (when || 0);
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;   // 每次微变速，避免"永远是同一声"
    var g = ctx.createGain();
    env(g, t0, vol, atk || 0.005, dur);
    var node = src;
    if (fo) {
      var fl = ctx.createBiquadFilter();
      fl.type = fo.type || 'lowpass';
      fl.frequency.setValueAtTime(fo.f0 || 1200, t0);
      if (fo.f1 && fo.f1 !== fo.f0) fl.frequency.exponentialRampToValueAtTime(Math.max(20, fo.f1), t0 + dur);
      fl.Q.value = fo.q || 1;
      src.connect(fl); node = fl;
    }
    node.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.03);
  }

  /* 连击音阶：五声音阶 C5 D5 E5 G5 A5，连击越高音越亮，串串上头 */
  var PIERCE_LADDER = [523.25, 587.33, 659.25, 783.99, 880];

  var SOUNDS = {
    /* 串到水果：v = 连击倍率 1..5 */
    pierce: function (v) {
      var i = Math.max(1, Math.min(PIERCE_LADDER.length, v || 1)) - 1;
      var f = PIERCE_LADDER[i] * (1 + (Math.random() * 0.012 - 0.006));   // ±0.6 音分随机微调
      blip('triangle', f, f * 0.55, 0.13, 0.26);           // 果肉"噗嗤"拨弦
      blip('sine', f * 2, f, 0.09, 0.09);                  // 亮芯
      hiss(0.03, 0.12, { type: 'highpass', f0: 5000 });    // 果皮迸裂
    },
    /* 炸弹命中：低频轰 + 碎屑扑面 */
    bomb: function () {
      hiss(0.5, 0.5, { type: 'lowpass', f0: 2600, f1: 140 });
      blip('sine', 150, 42, 0.38, 0.5);
      blip('square', 72, 60, 0.07, 0.2);
    },
    /* 超载熔毁炸弹：电流嘶落 */
    melt: function () {
      var t0 = now();
      var o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(340, t0);
      o.frequency.exponentialRampToValueAtTime(95, t0 + 0.3);
      var lfo = ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 26;
      var lfoG = ctx.createGain(); lfoG.gain.value = 55;
      lfo.connect(lfoG); lfoG.connect(o.frequency);
      var fl = ctx.createBiquadFilter();
      fl.type = 'bandpass'; fl.frequency.value = 950; fl.Q.value = 3;
      var g = ctx.createGain();
      env(g, t0, 0.3, 0.006, 0.32);
      o.connect(fl); fl.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + 0.35); lfo.start(t0); lfo.stop(t0 + 0.35);
      hiss(0.22, 0.16, { type: 'highpass', f0: 2500 });
    },
    /* 漏接：闷掉的下行，配灰闪 */
    miss: function () {
      blip('sine', 196, 98, 0.2, 0.2);
      hiss(0.12, 0.12, { type: 'lowpass', f0: 300 });
    },
    /* 擦弹：一缕气声 + 绿光上扬叮 */
    graze: function () {
      hiss(0.07, 0.13, { type: 'highpass', f0: 6000 });
      blip('triangle', 1318.5, 1568, 0.13, 0.18);
    },
    /* 铰链磁吸：v=0 合上（低沉"咔噔"）/ v=1 全开（清脆"咔"） */
    snap: function (v) {
      var closed = !v;
      hiss(0.03, 0.4, { type: 'bandpass', f0: closed ? 1200 : 2300, q: 8 });
      var f = closed ? 140 : 230;
      blip('sine', f, f * 0.6, 0.05, 0.3);
    },
    /* 激光超载：充能扫频上扬 + 双锯齿爆发 */
    overload: function () {
      var t0 = now();
      var o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(90, t0);
      o.frequency.exponentialRampToValueAtTime(620, t0 + 0.55);
      var fl = ctx.createBiquadFilter();
      fl.type = 'lowpass'; fl.Q.value = 2;
      fl.frequency.setValueAtTime(300, t0);
      fl.frequency.exponentialRampToValueAtTime(3800, t0 + 0.55);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.22, t0 + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.62);
      o.connect(fl); fl.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + 0.65);
      blip('sawtooth', 220, 218, 0.55, 0.16, 0.5, 0.015);      /* A3 */
      blip('sawtooth', 329.63, 326, 0.55, 0.16, 0.5, 0.015);   /* E4 */
      hiss(0.3, 0.16, { type: 'bandpass', f0: 1200, q: 1.5 }, 0.5, 0.04);
    },
    /* 超载结束掉电：微失谐双锯齿 + 渐深颤音下坠 */
    overloadEnd: function () {
      var t0 = now();
      var lfo = ctx.createOscillator();
      lfo.type = 'sine'; lfo.frequency.value = 9;
      var lfoG = ctx.createGain();
      lfoG.gain.setValueAtTime(6, t0);
      lfoG.gain.linearRampToValueAtTime(55, t0 + 0.7);
      lfo.connect(lfoG);
      var fl = ctx.createBiquadFilter();
      fl.type = 'lowpass'; fl.Q.value = 1.5;
      fl.frequency.setValueAtTime(1800, t0);
      fl.frequency.exponentialRampToValueAtTime(180, t0 + 0.7);
      var g = ctx.createGain();
      env(g, t0, 0.26, 0.01, 0.72);
      var i, o;
      for (i = 0; i < 2; i++) {
        o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(523 + i * 5, t0);
        o.frequency.exponentialRampToValueAtTime(72, t0 + 0.7);
        lfoG.connect(o.frequency);
        o.connect(fl);
        o.start(t0); o.stop(t0 + 0.75);
      }
      fl.connect(g); g.connect(master);
      lfo.start(t0); lfo.stop(t0 + 0.75);
      hiss(0.6, 0.1, { type: 'lowpass', f0: 900, f1: 120 });
    },
    /* 超载次数 +1：上行双音编钟 */
    charge: function () {
      blip('sine', 880, 0, 0.09, 0.2);
      blip('sine', 1174.7, 0, 0.16, 0.2, 0.09);
      blip('triangle', 1760, 0, 0.1, 0.06, 0.09);
    },
    /* 光束熄灭（血尽）：小调三连落 + 低音垫 */
    gameover: function () {
      blip('triangle', 392, 0, 0.32, 0.2, 0, 0.01);
      blip('triangle', 311.1, 0, 0.32, 0.2, 0.19, 0.01);
      blip('triangle', 261.6, 0, 0.4, 0.2, 0.38, 0.01);
      blip('sine', 98, 96, 1.1, 0.12, 0, 0.05);
    },
    /* 手机报废（强超载烧机）：失谐下坠 + 高频滋滋 */
    broken: function () {
      blip('sawtooth', 110, 52, 0.95, 0.17, 0, 0.01);
      blip('sawtooth', 116.5, 55, 0.95, 0.17, 0, 0.01);
      blip('square', 60, 38, 0.4, 0.28);
      hiss(0.8, 0.18, { type: 'highpass', f0: 2600 }, 0, 0.03);
    },
    /* 应用孤岛开始：界面收窄的两声"咯噔" */
    isle: function () {
      blip('square', 329.6, 0, 0.09, 0.12);
      blip('square', 246.9, 0, 0.13, 0.12, 0.1);
    },
    /* 倒计时：短促哔 */
    tick: function () {
      blip('sine', 640, 0, 0.08, 0.22);
      blip('sine', 1280, 0, 0.05, 0.05);
    },
    /* 开串！：上扬啾 + 迸出的火花 */
    go: function () {
      blip('sine', 660, 1320, 0.16, 0.28);
      hiss(0.12, 0.1, { type: 'highpass', f0: 4000 });
    },
    /* 界面按钮：干脆一嗒 */
    click: function () {
      blip('square', 820, 640, 0.04, 0.12);
      hiss(0.025, 0.1, { type: 'bandpass', f0: 2500, q: 4 });
    },
  };

  /* 光束嗡鸣：双锯齿微失谐拍频 → 低通 → 增益，常驻但平时 0 音量 */
  function buildHum() {
    humOscA = ctx.createOscillator(); humOscA.type = 'sawtooth';
    humOscB = ctx.createOscillator(); humOscB.type = 'sawtooth';
    humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass'; humFilter.Q.value = 2.5;
    humGain = ctx.createGain(); humGain.gain.value = 0;
    humOscA.connect(humFilter); humOscB.connect(humFilter);
    humFilter.connect(humGain); humGain.connect(master);
    humOscA.frequency.value = 60; humOscB.frequency.value = 60.5;
    humOscA.start(); humOscB.start();
  }

  /* —— BGM 乐谱（全部即时合成，无采样文件）——
   * 进行 Cmaj7 → Am7 → Fmaj7 → G6：慵懒下行动线；音高均为频率 Hz。
   * 每个和弦 8 个八分音符（4s），四和弦一轮 16s，循环往复。 */
  var BGM_STEP = 0.5;            // 八分音符时长 s（≈ 60BPM 的慢八分，够悠闲）
  var BGM_STEPS_PER_CHORD = 8;
  var BGM_CHORDS = [
    { pad: [261.63, 329.63, 392.0, 493.88], bass: 65.41 },   // Cmaj7  C4 E4 G4 B4 / C2
    { pad: [220.0, 261.63, 329.63, 392.0], bass: 55.0 },     // Am7    A3 C4 E4 G4 / A1
    { pad: [174.61, 220.0, 261.63, 329.63], bass: 87.31 },   // Fmaj7  F3 A3 C4 E4 / F2
    { pad: [196.0, 246.94, 293.66, 329.63], bass: 98.0 },    // G6     G3 B3 D4 E4 / G2
  ];
  /* 琶音声部：索引 [0..3]=和弦音、4=根音高八度，null=休止留白；重拍稍响 */
  var BGM_ARP = [4, 2, 3, null, 4, 2, 1, null];

  function bgmPiano(t, f, vol, dur) {
    /* FM 电钢：正弦载波 + 2 倍频调制，调制深度快衰 = 起音亮、尾音纯 */
    var car = ctx.createOscillator();
    car.type = 'sine'; car.frequency.value = f;
    var mod = ctx.createOscillator();
    mod.type = 'sine'; mod.frequency.value = f * 2;
    var modG = ctx.createGain();
    modG.gain.setValueAtTime(f * 1.6, t);
    modG.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.05), t + dur * 0.6);
    mod.connect(modG); modG.connect(car.frequency);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    car.connect(g); g.connect(bgmGain);
    car.start(t); car.stop(t + dur + 0.05);
    mod.start(t); mod.stop(t + dur + 0.05);
    bgmNotes++;
  }

  function bgmBass(t, f) {
    var o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = f;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    o.connect(g); g.connect(bgmGain);
    o.start(t); o.stop(t + 3.3);
    bgmNotes++;
  }

  function bgmPad(t, freqs) {
    /* 整和弦长垫：缓起缓收 + 微失谐，铺在底下当"空气" */
    var hold = BGM_STEPS_PER_CHORD * BGM_STEP;   // 4s
    for (var i = 0; i < freqs.length; i++) {
      var o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = freqs[i];
      o.detune.value = Math.random() * 8 - 4;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.014, t + 1.4);
      g.gain.setValueAtTime(0.014, t + hold - 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + hold + 0.2);
      o.connect(g); g.connect(bgmGain);
      o.start(t); o.stop(t + hold + 0.3);
      bgmNotes++;
    }
  }

  /* 排一步（一个八分音符）：和弦头铺低音与垫，琶音声部按 BGM_ARP 走 */
  function bgmNote(t, step) {
    var ch = BGM_CHORDS[((step / BGM_STEPS_PER_CHORD) | 0) % BGM_CHORDS.length];
    var k = step % BGM_STEPS_PER_CHORD;
    if (k === 0) { bgmBass(t, ch.bass); bgmPad(t, ch.pad); }
    /* 每两轮在最后一个和弦里点缀一颗高八度亮音，打破重复感 */
    if (step % 64 === 60) { bgmPiano(t, ch.pad[1] * 2, 0.045, 1.5); return; }
    var idx = BGM_ARP[k];
    if (idx == null) return;
    var f = (idx < 4 ? ch.pad[idx] : ch.pad[0] * 2) * (1 + (Math.random() * 0.006 - 0.003));
    bgmPiano(t, f, 0.07 + (k % 4 === 0 ? 0.025 : 0) + Math.random() * 0.012, 1.15);
  }

  /* 前瞻调度：每 200ms 把未来 0.8s 内的音符排上，保证节奏零抖动 */
  function bgmSchedule() {
    if (!ctx) { bgmHalt(); return; }
    var t = now();
    if (bgmNext < t - 0.1) bgmNext = t + 0.05;   // 切后台冻结过后跳过落后的拍，不追播
    var horizon = t + 0.8;
    while (bgmNext < horizon) {
      bgmNote(bgmNext, bgmStep);
      bgmStep++;
      bgmNext += BGM_STEP;
    }
  }

  function bgmEnsure() {
    if (bgmTimer || !ctx) return;
    bgmStep = 0;
    bgmNext = now() + 0.15;
    bgmTimer = setInterval(bgmSchedule, 200);
    bgmSchedule();
  }

  function bgmHalt() {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
  }

  /* BGM 总线：低通柔化后进 master（静音时 master 归零双保险） */
  function buildBgm() {
    bgmGain = ctx.createGain();
    bgmGain.gain.value = 0;
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2200; lp.Q.value = 0.5;
    bgmGain.connect(lp); lp.connect(master);
  }

  /* 首次用户手势：建图 + 唤醒（部分移动浏览器挂起后要在手势里重新 resume） */
  function unlock() {
    if (!AC) return;
    if (!ctx) {
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : MASTER_VOL;
        var comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 6;
        master.connect(comp); comp.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        var d = noiseBuf.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        buildHum();
        buildBgm();
      } catch (e) { ctx = null; return; }   // 极老浏览器：静默无音效，不影响游戏
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  window.Sfx = {
    init: function () {
      try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { /* file:// 或隐私模式 */ }
      window.addEventListener('pointerdown', unlock, { passive: true });
      window.addEventListener('keydown', unlock);
      /* 切后台挂起音频（rAF 已停，嗡鸣别干响），回前台再唤醒 */
      document.addEventListener('visibilitychange', function () {
        if (!ctx) return;
        if (document.hidden) ctx.suspend();
        else ctx.resume();
      });
      lastSnapSeq = G.snapSeq || 0;
      lastIsleSeq = G.isleSeq || 0;
    },

    /* 每帧一次（main 循环）：排空事件队列 + 轮询序号 + 推进嗡鸣 */
    update: function (dt) {
      var i;
      /* 1) 事件音：没解锁/静音也要排空，防止队列堆积 */
      var q = G.sfxQueue;
      if (q && q.length) {
        for (i = 0; i < q.length; i++) Sfx.play(q[i].name, q[i].v);
        q.length = 0;
      }
      if (!ctx) return;

      /* 2) 铰链磁吸：input 松手把 foldTarget 精确设成 0/1 再递增 snapSeq，据此选音色 */
      if (G.snapSeq !== lastSnapSeq) {
        lastSnapSeq = G.snapSeq;
        Sfx.play('snap', (G.foldTarget || 0) < 0.5 ? 0 : 1);
      }
      /* 3) 应用孤岛开始 */
      if (G.isleSeq !== lastIsleSeq) {
        lastIsleSeq = G.isleSeq;
        Sfx.play('isle');
      }

      /* 4) 光束嗡鸣：playing/countdown 常亮；fold 定音高、开合差速定响度、超载加激励 */
      var active = !muted && (G.state === 'playing' || G.state === 'countdown');
      var fold = clamp01(G.fold || 0);
      var f = 105 + fold * 155;   // 合上 105Hz → 全开 260Hz：开得越大音越高
      if (G.overload > 0) f *= 1.4;
      var target = active
        ? 0.045 + Math.min(0.09, Math.abs((G.foldTarget || 0) - fold) * 0.4) + (G.overload > 0 ? 0.035 : 0)
        : 0;
      humLevel += (target - humLevel) * (1 - Math.exp(-10 * (dt || 0.016)));
      humGain.gain.setTargetAtTime(humLevel, now(), 0.05);
      if (Math.abs(f - humLastF) > 0.5) {
        humLastF = f;
        humOscA.frequency.setTargetAtTime(f, now(), 0.08);
        humOscB.frequency.setTargetAtTime(f * 1.008, now(), 0.08);
        humFilter.frequency.setTargetAtTime(Math.max(300, f * 7), now(), 0.1);
      }

      /* 5) 背景音乐：解锁且未静音就一直慢悠悠循环；暂停压到"咖啡馆音量"，静音即停 */
      var bgmTarget = muted ? 0 : (G.state === 'paused' ? 0.26 : 0.7);
      bgmLevel += (bgmTarget - bgmLevel) * (1 - Math.exp(-3 * (dt || 0.016)));
      bgmGain.gain.setTargetAtTime(bgmLevel, now(), 0.4);
      if (bgmTarget > 0) bgmEnsure(); else bgmHalt();
    },

    play: function (name, v) {
      if (!ctx || muted) return;
      var fn = SOUNDS[name];
      if (fn) { played++; try { fn(v); } catch (e) { /* 单个音效失败不影响其余 */ } }
    },

    toggleMuted: function () {
      muted = !muted;
      try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* 禁写则仅本局生效 */ }
      if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : MASTER_VOL, now(), 0.03);
      return muted;
    },

    muted: function () { return muted; },

    /* 验证用：真实状态快照（未解锁/未建图都如实报告） */
    debug: function () {
      return {
        supported: !!AC,
        unlocked: !!ctx,
        ctxState: ctx ? ctx.state : null,
        muted: muted,
        played: played,
        humLevel: +humLevel.toFixed(3),
        humFreq: +humLastF.toFixed(1),
        bgm: { on: !!bgmTimer, level: +bgmLevel.toFixed(3), notes: bgmNotes },
      };
    },
  };
})();
