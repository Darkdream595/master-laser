/* ============================================================
 * 《激光大师 · Master Laser》全局配置
 * 所有玩法数值集中在此：改完保存、刷新页面即生效，无需构建。
 * 各键含义详见 README.md「调参指南」。
 * ============================================================ */
(function () {
  'use strict';

  window.CFG = {
    VERSION: '2.6.1',
    TITLE: '激光大师 · Master Laser',

    /* —— 布局（v2.1：游戏装进手机屏幕 + 真 3D 翻盖）——
     * 右半机身固定，内屏 = 战场；左半机身绕铰链翻转：内屏 = HUD，背面外屏合上时显示战场。
     * 战场内所有逻辑坐标以战场左上角（折痕顶端）为原点，见 G.AW / G.AH。 */
    PHONE_CLOSED_RATIO: 19.5 / 9, // 单片 高:宽 = 19.5:9；展开宽 = 2 × 单片宽（对称书本折）
    PHONE_H_FRAC: 0.66,   // 手机高度 / 视口高（翻起的半边离视点更近会放大，需留余量）
    PHONE_W_FRAC: 0.5,    // 宽屏：展开整机宽度上限 / 视口宽
    PHONE_W_FRAC_NARROW: 0.92, // 竖屏窄视口：展开整机宽度上限 / 视口宽
    PHONE_THICK_FRAC: 0.036,   // 单片机身厚度 / 手机高（略夸张以显立体）
    ARENA_REF_H: 640,     // 物理数值的参考战场高度 px：实际战场按 高/该值 等比缩放重力、速度、半径
    BEAM_Y_FRAC: 0.5,     // 光束水平线 / 战场高
    BEAM_LEN_MIN: 0.12,   // 全闭(fold=0)光束长 / 战场宽
    BEAM_LEN_MAX: 0.94,   // 全开(fold=1)光束长 / 战场宽

    /* —— 开合 —— */
    DRAG_FLAP_SPAN: 1.5,  // 按住翻盖拖过 单片宽×该值 = fold 全程 0→1（1.5 ≈ 翻盖外缘真实行程，跟手）
    FOLD_SMOOTH: 10,      // fold 逼近 foldTarget 的指数平滑系数，越大越跟手
    SNAP_ZONE: 0.08,      // 松手时距端点小于该值则磁吸到端点

    /* —— 悬浮玻璃（逆投影模糊，移植自 MIT 许可的第三方着色器，见 THIRD_PARTY_NOTICES；参数沿用其默认配置）——
     * 内容固定在平面上，屏幕是绕铰链转动的玻璃：玻璃离内容平面越远越糊越暗，视线出界为黑。 */
    EYE_DIST_H: 2.0,      // eye_dist_h：视点到屏幕平面距离 / 手机高
    GLASS_SPREAD: 0.42,   // blur_spread：玻璃与内容间隙 1px → 模糊半径 0.42px
    GLASS_DARK: 0.001,    // darkening：每 px 模糊半径损失的光量
    GLASS_TAPS: 32,       // max_taps：Vogel 盘采样数上限

    /* —— 投射物 —— */
    GRAVITY: 900,         // px/s²
    FRUIT_R: 30,          // 水果碰撞半径 px
    BOMB_R: 27,           // 炸弹碰撞半径 px
    SPAWN_INTERVAL0: 1.5, // 开局生成间隔 s
    SPAWN_INTERVAL_MIN: 0.55, // 满节奏后的最小间隔 s
    SPAWN_RAMP_TIME: 120, // 从开局间隔渐变到最小间隔所用秒数
    BOMB_CHANCE: 0.16,    // 炸弹概率；设 0 = 纯净水果模式（无脑全开即可，会变休闲）
    CROSS_X_MIN: 0.10,    // 穿越点横坐标下限 / 战场宽
    CROSS_X_MAX: 0.92,    // 穿越点横坐标上限 / 战场宽
    VX_MIN: 30,           // 水平初速绝对值范围 px/s（正负随机）
    VX_MAX: 130,
    PEAK_MIN: 60,         // 抛物线顶点高出光束线的范围 px
    PEAK_MAX: 260,
    PIERCE_MIN_VY: 40,    // 穿刺所需最小竖直速度，防贴线蹭穿
    WALL_BOUNCE: 0.8,     // 碰左右边缘反弹后的水平速度保留比例（0~1）；墙位于 x = r 与 AW - r
    BUZZ_TIME: 0.5,       // 被炸弹炸到时整机震动时长 s（线性衰减到 0）
    BUZZ_AMP: 8,          // 震动峰值位移 px，按机身高 560px 标定，小屏等比缩小
    BUZZ_HZ: 18,          // 震动频率，0.5s 内约抖 9 下

    /* 生成策略：'classic' 炸弹偏向右侧且避开最短光束；'random' 纯随机（预留给挑战模式）。
     * 新模式可通过 Game.registerSpawnMode(name, fn) 注册，见 game.js SPAWN_MODES */
    SPAWN_MODE: 'classic',
    BOMB_CROSS_X_MIN: 0.45, // classic：炸弹穿越点下限 / 战场宽（且总在最短光束尖端之外）
    BOMB_RIGHT_BIAS: 0.55,  // classic：穿越点分布指数，<1 越偏右

    /* —— 规则数值 —— */
    HP_MAX: 100,
    DMG_BOMB: 20,         // 炸到炸弹（挂机全开约 30~40s 被炸死，见 README 平衡说明）
    DMG_MISS: 5,          // 漏接
    STREAK_MIN: 3,        // 连串（连续串到、未被炸弹/漏接打断）达到该数起，每串 1 个回血
    HEAL_STREAK: 1,
    GRAZE_H: 30,          // 擦弹带高度 px（光束正上方）；炸弹进带后从尖端外落下、没被引爆即擦弹。设 0 关闭
    GRAZE_HEAL: 1,        // 每次擦弹回血；不影响连击与连串
    DMG_BOMB_STREAK: 25,  // 连串中被炸：一次性重罚并清零连串
    DMG_MISS_STREAK: 10,  // 连串中漏接：同上
    SCORE_PER_PIERCE: 10,
    COMBO_WINDOW: 2.0,    // 连击窗口 s，超时归零
    COMBO_MAX: 5,         // 连击倍率上限 ×5
    SKEWER_LIFE: 0.9,     // 水果串在光束上的停留时间 s

    /* —— 激光超载 —— 合上→全开→合上（或反向）计 1 次完整开合，攒满触发 */
    FOLD_CLOSED_T: 0.1,   // fold 低于该值视为合上
    FOLD_OPEN_T: 0.9,     // fold 高于该值视为全开
    OVERLOAD_CYCLES: 6,
    OVERLOAD_TIME: 5,     // 持续 s
    OVERLOAD_SCORE_MULT: 2,
    OVERLOAD_BEAM: 1.25,  // 超载光束长 / 战场宽（>1 即射出右屏）
    OVERLOAD_CHARGES: 3,  // 一局可超载次数；用完后再攒满开合 = 手机直接损坏（另一种结局）
    OVERLOAD_RESTORE_STREAK: 15, // 连串每达到该数的整数倍，恢复 1 次超载（不超过上限）
    OVERLOAD_BLUR_TIME: 3,       // 超载结束后整机模糊 s；期间所有投射物都显示成炸弹
    BLUR_FRUIT_MULT: 3,          // 模糊期间水果期望数量 = 平常的该倍数（额外补纯水果，炸弹数量不变）；1 = 关闭
    COUNTDOWN: 3,                // 开局倒计时 s（3-2-1），期间可开合、不生成投射物

    /* —— 随机事件「应用孤岛」—— 展开后游戏只开成单屏宽、骑在折痕上，两侧外半屏全黑（判定照常） */
    ISLE_COOLDOWN: 15,    // 开局 / 上次事件结束后的冷却 s（只在 playing 计时）
    ISLE_CHANCE: 0.35,    // 冷却结束后，每次从合上开始展开时的触发概率
    ISLE_ROUNDS: 3,       // 持续回合数：全开→合上算 1 回合，第 N 次合上时结束

    /* —— 表现 —— */
    EMOJI_FRUITS: ['🍉', '🍌', '🍓', '🍊', '🍇', '🥝', '🍑', '🍍', '🥭'],
    EMOJI_BOMB: '💣',

    /* —— 存储 —— */
    BEST_KEY: 'crease_pierce_best_v1',   // 沿用改名前的键，保住玩家已有的历史最佳
  };

  /* 运行时状态容器（壳）。完整字段由 game.js 的 G.reset() 填充，见 SPEC §2。 */
  window.G = {
    state: 'menu',
  };
})();
