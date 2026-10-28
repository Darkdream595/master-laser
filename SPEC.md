# SPEC —— 《激光大师 · Master Laser》模块接口契约

> 版本 1.3 · 任何模块（人或 AI）动代码前必须先读完本文件。
> v1.3 变更：手机改为**非对称折叠**——右屏固定为基准，左屏绕折线向右合拢到右屏上；合上为 5.4 英寸比例（高:宽 19.5:9）的窄长矩形，展开为 1.4:1 矩形；折线（光束出口）偏左，不在展开后中线。`PHONE_W` 移除，宽度全部由 `PHONE_OPEN_RATIO`/`PHONE_CLOSED_RATIO`/`PHONE_H_FRAC` 按当帧屏高推导，逻辑层经 `G.phoneW` 使用。
> v1.2 变更：手机改为**内屏面向用户**的开合（合上见浅灰背壳、展开见深色内屏，开合线性插值）；整机上移 `PHONE_LIFT_FRAC`，光束出口位于手机中线偏下、射线仍保持屏幕中心线；内屏各留一块内容占位区 `CFG.SCREEN_CONTENT`（现虚线 IMG 框，之后放梗图/文字）。
> v1.1 变更：① 拖拽操控区扩大到全屏；② 手机双屏绕铰链开合动画，光束自铰链（折痕）射出；③ 取消"碰尖/甩尖"惩罚——光束任何部位（根部到尖端）穿越都算穿刺得分，移除 `TIP_SAFE_FRAC`。
> 梗背景：折叠屏手机折痕处漏液射出"光束"。本游戏把漏光当烤串签子用。

## 0. 技术红线（不可违反）

1. 纯 HTML + CSS + 原生 JavaScript。**零依赖、零构建、零网络请求**。
   必须支持双击 `index.html`（file:// 协议）直接运行，以便跨设备开发。
2. **禁止 ES Modules**（`import`/`export`），file:// 下会被浏览器 CORS 拦截。
   一律普通 `<script>` 标签 + 全局对象通信。
3. 全局对象只有四个，职责严格分离：
   - `window.CFG` —— 全部可调常量（config.js 定义）
   - `window.G`   —— 运行时状态容器（config.js 建壳，game.js 的 `G.reset()` 填充）
   - `window.Game` / `window.Input` / `window.Render` —— 三个模块
4. 每个文件在**顶层只做定义**，加载时不调用其他模块（初始化时序归 main.js）。
5. 逻辑与渲染分离：**game.js 禁止碰 DOM / canvas**（唯一例外：localStorage 最佳成绩）；
   **render.js 禁止修改游戏数值与规则**；main.js 只做接线和 DOM 覆盖层切换。
6. 注释用中文，简洁；不写"证明自己正确"的注释。

## 1. 文件结构与页面契约（index.html 归渲染模块负责）

```
master-laser/
├─ index.html
├─ SPEC.md          ← 本文件（接口契约，跨设备协作的根据）
├─ README.md        ← 说明文件（面向接手开发的人）
├─ css\style.css
└─ js\
   ├─ config.js     ← CFG 常量 + G 壳
   ├─ game.js       ← 游戏逻辑（生成/物理/判定/计分/扣血）
   ├─ input.js      ← 指针拖拽 + 键盘输入 → 写 G.foldTarget
   ├─ render.js     ← 双层画布渲染 + 模糊
   └─ main.js       ← 主循环 + DOM 覆盖层接线（集成者负责）
```

- `<canvas id="world">` 在下层（**会被 CSS blur**），`<canvas id="fx">` 在上层（永远清晰）。
- DOM 覆盖层（css/style.css 用 `.hidden` 类控制显隐，main.js 切换）：
  - `#overlay-menu`：含 `#btn-start`、`#menu-best`
  - `#overlay-gameover`：含 `#score-final`、`#best-final`、`#gameover-line`、`#btn-restart`
  - `#overlay-pause`
- 脚本加载顺序（**普通 script 标签、无 defer 无 module**）：
  `js/config.js → js/game.js → js/input.js → js/render.js → js/main.js`
- UI 文案为中文，风格：发布会式深色 + 一点梗，但克制。

## 2. 运行时状态 `G`（game.js 的 `G.reset()` 负责填充/清零）

| 字段 | 类型/初值 | 说明 |
|---|---|---|
| `state` | `'menu'` | `'menu'` \| `'playing'` \| `'paused'` \| `'gameover'` |
| `t` | 0 | 本局经过秒数（难度曲线用） |
| `fold` | 0.85 | 当前开合度 0..1（判定与渲染都用它） |
| `foldTarget` | 0.85 | 输入目标值，`fold` 指数平滑逼近它 |
| `W`,`H` | 0 | 视口 CSS 像素尺寸（Render.resize 写入） |
| `beamY` | 0 | 光束水平线 y = `H*CFG.BEAM_Y_FRAC` |
| `beamLen`,`prevBeamLen` | 0 | 当前/上一帧光束长度 px（尖端扫过判定需要） |
| `hp`,`score`,`best`,`combo`,`comboTimer` | — | hp≤0 → gameover；best 存 localStorage |
| `spawnTimer` | 0 | 生成倒计时 |
| `fruits` | `[]` | 飞行物，元素见下 |
| `skewers` | `[]` | `{ x, emoji, r, life, maxLife }` 被串住的水果，挂在光束线上 |
| `particles` | `[]` | `{ x,y,vx,vy,life,maxLife,size,color,g }` |
| `popups` | `[]` | `{ x,y,text,color,life,maxLife }` 上飘弹字 |
| `flashRed`,`flashGray`,`shake` | 0 | 伤害反馈，随时间衰减 |
| `fruitSeq` | 1 | 自增 id |

`fruits` 元素：`{ id, type:'fruit'|'bomb', emoji, r, x, y, vx, vy, pierced:false, dead:false }`

## 3. 模块 API

- **config.js**：`window.CFG = {…}`；`window.G = { state:'menu' }`（仅此而已）。
- **game.js** → `window.Game = { init(), update(dt), startGame(), togglePause() }`，并定义 `G.reset()`。
  `init()`：读 localStorage 初始化 `G.best`，调 `G.reset()`。
  `startGame()`：`G.reset()` 后 `G.state='playing'`（保留上次 fold 位置作为手感延续）。
  `update(dt)`：按 state 分支（见 §5 状态表），**纯逻辑**。
- **input.js** → `window.Input = { init(), update(dt) }`。
  屏幕任意位置按下即开始拖拽（v1.1 起全屏操控），按住期间横向移动：
  `G.foldTarget += dx / (G.W*CFG.DRAG_PIXELS_FULL)`，clamp 0..1。
  画布光标固定 `ew-resize`。
  方向键 ←/→：按住时在 `update(dt)` 里持续调整 foldTarget（可作调试/无障碍）。
- **render.js** → `window.Render = { init(), resize(), draw(dt) }`。
  `resize()` 同步两个画布的 DPR 尺寸并写 `G.W/G.H`（window resize 时 main 调用）。
  `draw(dt)` 每帧把 `#world` 的 `style.filter` 设为
  `blur(Npx)`，`N = CFG.BLUR_MAX * (1 - |2*fold - 1|)`（两端清晰、中间最糊、线性）。
- **main.js**：rAF 主循环 `dt → Input.update → Game.update → Render.draw → 覆盖层同步`；
  绑定按钮；Space=开始/重来，P=暂停；localStorage 文本展示；gameover 随机语录。

## 4. 几何与坐标系

- 逻辑坐标一律 CSS 像素；画布 DPR 缩放由 render 内部处理。
- 手机：**v1.3 非对称折叠**——右屏为固定基准，左屏绕折线向右合拢到右屏上。
  高 `phoneH = H*PHONE_H_FRAC`；合上宽 `closedW = phoneH/PHONE_CLOSED_RATIO`（19.5:9，5.4 英寸 mini 比例）；
  展开宽 `openW = phoneH/PHONE_OPEN_RATIO`（1.4:1）；左屏宽 `leftW = openW − closedW`；
  折线（铰链、光束出口）在 `x = leftW`，偏左、并非展开后中线。手机右缘固定在 `x = openW`，
  逻辑层每帧写 `G.phoneW = openW`（碰撞与生成用）。
- 光束：从折线 (leftW, beamY) 水平向右射出，长度
  `beamLen = W * (BEAM_LEN_MIN + fold*(BEAM_LEN_MAX-BEAM_LEN_MIN))`。

## 5. 判定规则（game.js 逐字实现以下语义）

### 状态行为
| state | update 行为 |
|---|---|
| menu | 不生成；foldTarget 自动缓摆 `0.85 + 0.05*sin(t*0.7)`（标题页顺便演示模糊机制） |
| playing | 完整模拟 |
| paused | 全部冻结（渲染继续出静帧） |
| gameover | 不再生成/积分；粒子、弹字、串签继续衰减到消失 |

### 生成（抛物线必须"指哪打哪"，玩家永远有机会接住）
- 间隔：`lerp(SPAWN_INTERVAL0, SPAWN_INTERVAL_MIN, min(1, t/SPAWN_RAMP_TIME))`；
  `t > 45s` 后每次生成有 20% 概率多生成 1 个。
- 每个投射物：先抽 `type`（`BOMB_CHANCE` 概率为炸弹，0 则纯净模式）；
  再抽穿越点 `xc ∈ [CROSS_X_MIN, CROSS_X_MAX]*W`（但 ≥ 手机右缘+40px）与
  顶点高出光束线 `peak ∈ [PEAK_MIN, PEAK_MAX]`。
- 由抛物线反解初速：出生点 `(x0, H+40)`，令 `h = (H+40−beamY) + peak`，
  `vy0 = sqrt(2*g*h)`（保证顶点恰好高于光束线 peak），
  上升段穿越光束线时刻 `t1 = (vy0 − sqrt(vy0²−2*g*(H+40−beamY))) / g`，
  取 `vx ∈ [VX_MIN, VX_MAX]`（随机正负），`x0 = xc − vx*t1`；
  若 `x0` 落在 [手机右缘+30, 0.95W] 之外则换 vx/xc 重抽（≤20 次，兜底取最近值）。
- 效果：每个投射物先从下往上**升穿**光束线（第一判定点），越过顶点后还会**落穿**一次（第二判定点）——两次都可穿刺，给玩家补救机会。

### 逐帧判定（对每个 `!pierced && !dead` 的投射物）
```
prevY = y;  vy += GRAVITY*dt;  y += vy*dt;  x += vx*dt
若 (prevY−beamY) 与 (y−beamY) 异号 且 |vy| ≥ PIERCE_MIN_VY:      # 穿越光束线
    xc = x − (y−beamY)*vx/vy                                    # 线性插值穿越点
    若 type == bomb:
        若 xc ∈ [手机右缘, beamLen]:  爆炸 → hp−1, 震屏+红闪, 弹字 "-1 💥", dead
        否则: 无惩罚，继续飞（炸弹漏掉不罚）
    否则(水果):
        若 xc ∈ [手机右缘+4, beamLen]:  ★穿刺★（光束任何部位：根部到尖端都算）
            得分 = SCORE_PER_PIERCE × combo倍率; combo 在 COMBO_WINDOW 内递增(上限 COMBO_MAX×)
            pierced=true; skewers.push({x:xc, emoji, r, life:SKEWER_LIFE,…})
            果汁粒子 + 金色弹字
        否则: 越过尖端飞过（不处理，等落穿或坠出屏幕）
出界: y > H+80:
    水果未 pierced → hp−1, 灰闪, 弹字 "-1 漏接"；炸弹 → 无罚；移除
```
- v1.1 起没有碰尖/甩尖惩罚：光束每一处都能得分，扣血只剩**漏接**与**炸弹**。
- 光束扫过（甩尖）不判罚——投射物穿越光束线的瞬间自会按上面规则判定。
- `hp ≤ 0` → `G.state='gameover'`，`G.best = max(best, score)` 并写 localStorage（main 负责显示）。

## 6. 视觉分层契约

- **world 画布（会被模糊）**：背景深色渐变与氛围光斑、飞行中的水果/炸弹、飞行粒子。
- **fx 画布（永远清晰）**：折叠手机、光束（白核+青色辉光+端部亮球+沿途微粒）、
  串在光束上的水果（skewers）、HUD（左上 ❤️/🖤 ×3、右上分数与最佳、顶中连击）、
  伤害红闪/灰闪与暗角、弹字。
- 两层都要响应 `G.shake`（绘制前 `ctx.translate` 随机抖动）。
- 手机：内屏面向用户的开合——合上见浅灰背壳（带摄像头点），展开见深色玻璃内屏，
  每块屏投影宽度 = halfW×(0.5+0.5×fold) 线性变化；整机上移 `PHONE_LIFT_FRAC×手机高`，
  使光束出口（铰链折痕、越靠下越亮）位于手机中线偏下；内屏各留 `CFG.SCREEN_CONTENT`
  内容占位区（空=虚线 IMG 框）。铰链即光束发射源。
- 水果/炸弹用系统 emoji（CFG 里的列表），禁用外部图片/字体。

## 7. 数值纪律

- 魔法数字一律进 `CFG`；模块内自用的纯表现常量（颜色、粒子数）除外。
- 若确需新增 CFG 键，可以加，但要在交付说明里注明。

## 8. 兼容目标

- 主流现代浏览器最新版，桌面 + 移动（Pointer Events + body `touch-action:none`）。
- 不依赖网络、外部字体、图片；emoji 走系统字体。
