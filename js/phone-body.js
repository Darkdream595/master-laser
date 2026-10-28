/* ============================================================
 * phone-body.js —— 折叠手机 3D 机身 + 悬浮玻璃屏（渲染层私有，PhoneArt 的另一半）
 * 机身：两片圆角金属板（轮廓挤出 + 圆倒角）+ 铰链书脊，WebGL2 实时光照。
 *   右半固定，内屏 = 战场；左半绕铰链翻转 ψ=(1-fold)·π：
 *   正面内屏 = HUD，背面外屏（合上时朝向玩家）= 战场。
 * 屏幕：移植自 MIT 许可的第三方逆投影着色器（版权声明与许可原文见 THIRD_PARTY_NOTICES）——
 *   内容停在静止平面上不动，翻动的只是玻璃；视线穿过玻璃像素落到内容平面采样，
 *   玻璃离内容平面越远越糊越暗，整个采样核出界即为黑。
 * 坐标：世界单位 = CSS px，X 向右、Y 向下、Z 指向玩家；屏幕平面 Z=0。
 * ============================================================ */
(function () {
  'use strict';
  const PA = window.PhoneArt = window.PhoneArt || {};

  const ARC_SEG = 8;        // 每个圆角的分段数
  const BEVEL_SEG = 4;      // 倒角每段 1/4 圆弧的分段数
  const SPINE_SEG = 14;     // 书脊半圆柱分段数
  const HINGE_GAP = 0.08;   // 铰链轴离正面的距离 / 单片厚：合上时两块内屏留一道缝，避免共面 z-fighting
  const TAPS_CAP = 64;     // 着色器循环上限（GLSL 要常量上界），实际次数取 CFG.GLASS_TAPS

  /* 布局只依赖视口，与 fold 无关：战场逻辑尺寸因此在开合中保持稳定 */
  PA.layout = function (W, H) {
    const ratio = CFG.PHONE_CLOSED_RATIO;
    const wFrac = W > H * 1.2 ? CFG.PHONE_W_FRAC : CFG.PHONE_W_FRAC_NARROW;
    const ph = Math.max(120, Math.min(H * CFG.PHONE_H_FRAC, W * wFrac * ratio / 2));
    const cw = ph / ratio;
    const m = PA.panelMetrics(cw, ph);
    const e = m.rim + m.bez;
    return {
      ph: ph, cw: cw, m: m, e: e, t: ph * CFG.PHONE_THICK_FRAC,
      y0: (H - ph) / 2, dispW: cw - e, dispH: ph - e * 2,
    };
  };

  /* ——— 着色器 ——— */
  const VS = `#version 300 es
layout(location = 0) in vec3 aPos;   // 局部 (a 自铰链, b 自顶, k 自正面向里)
layout(location = 1) in vec3 aNrm;
uniform vec3 uOrigin;
uniform mat3 uBasis;                 // 局部 → 世界（正交，法线可直接乘）
uniform vec3 uEye;                   // 视点：透视中心
uniform vec2 uView;                  // 视口 CSS px
out vec3 vWorld;
out vec3 vNrm;
out vec2 vLocal;
void main() {
  vec3 P = uOrigin + uBasis * aPos;
  vWorld = P;
  vNrm = uBasis * aNrm;
  vLocal = aPos.xy;
  // 单点透视 s = D/(D-Z)，写成齐次 w=(D-Z)/D，交给光栅化做透视校正插值
  float D = uEye.z;
  float w = (D - P.z) / D;
  float xs = uEye.x * w + (P.x - uEye.x);
  float ys = uEye.y * w + (P.y - uEye.y);
  gl_Position = vec4(2.0 * xs / uView.x - w, w - 2.0 * ys / uView.y, -P.z / D, w);
}`;

  const FS_HEAD = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNrm;
in vec2 vLocal;
uniform int uMat;          // 0 金属中框/书脊  1 黑玻璃面  2 磨砂背板
uniform int uDispOn;       // 该面是否带显示屏
uniform vec4 uDisp;        // 显示区（局部 a0,b0,a1,b1）
uniform vec2 uDispR;       // 显示区圆角：铰链侧 / 外侧
uniform vec3 uEye;
uniform vec3 uLight;
uniform vec3 uRim0;        // 金属基色
uniform vec3 uRim1;        // 金属反射色
uniform vec3 uBack;        // 背板色
uniform float uFlash;      // 磁吸闪光
uniform sampler2D uTex;
uniform vec2 uTexRes;      // 贴图 px
uniform vec4 uRect;        // 内容平面上的内容矩形 (x0,y0,x1,y1)，世界 px
uniform float uPlaneZ;     // 内容平面 Z
uniform float uSpread;
uniform float uDark;
uniform int uTaps;
uniform vec2 uAO;          // 合拢时铰链附近的遮蔽：强度 / 衰减宽度（局部 px）
out vec4 outColor;

const float GOLDEN = 2.39996322972865332;
const float TWO_PI = 6.28318530717958648;

float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// 假摄影棚环境：顶部柔光箱 + 右侧暖色补光（夜市摊位的灯），金属与玻璃都靠它出反射
vec3 env(vec3 r) {
  float sky = smoothstep(-0.3, 0.9, -r.y);
  float box = pow(max(dot(r, normalize(vec3(-0.45, -0.75, 0.5))), 0.0), 10.0);
  float ember = pow(max(dot(r, normalize(vec3(0.85, 0.15, 0.35))), 0.0), 6.0);
  return vec3(0.03) + vec3(0.22, 0.21, 0.2) * sky
       + vec3(1.0, 0.97, 0.92) * box * 1.3 + vec3(1.0, 0.5, 0.2) * ember * 0.7;
}
`;

  /* 与上游着色器同一套逆投影：玻璃像素 → 视线延长交内容平面 → 间隙定模糊半径。
   * 原实现铰链固定在屏幕底边、内容平面固定在 z=0；这里玻璃位置直接取光栅化出的世界坐标，
   * 内容平面 Z 由 uPlaneZ 给出，因此绕竖直铰链翻转的内屏、背面外屏共用一份代码。
   * 半径/LOD/采样数公式保持原样（含 effR 按全分辨率偏移的写法），参数才能沿用其 config.json；
   * 唯一换算：原实现 1 texel = 1 屏幕 px，这里贴图按 DPR 超采样，取 mip 时补上 log2(texel/px)。 */
  const FS_GLASS = `
vec3 glassSample(vec3 g, vec2 gdx, vec2 gdy) {
  float depth = uEye.z - g.z;
  if (depth <= 1e-3) return vec3(0.0);
  float t = (uEye.z - uPlaneZ) / depth;
  vec2 hit = uEye.xy + (g.xy - uEye.xy) * t;
  float gap = abs(g.z - uPlaneZ);
  float radius = uSpread * gap;
  // 整个模糊核都在内容之外 → 黑
  if (hit.x < uRect.x - radius || hit.x > uRect.z + radius ||
      hit.y < uRect.y - radius || hit.y > uRect.w + radius) return vec3(0.0);
  // 磨砂玻璃吸光：与散射成正比地变暗
  float att = max(1.0 - uDark * radius, 0.0);
  vec2 size = uRect.zw - uRect.xy;
  vec2 uvHit = (hit - uRect.xy) / size;
  // 贴合时按屏幕导数取 mip：透视斜看的屏幕也不闪烁（导数在 main 的统一控制流里求）
  if (radius < 0.5) return textureGrad(uTex, clamp(uvHit, 0.0, 1.0), gdx / size, gdy / size).rgb * att;
  // mip LOD：大半径先降到低分辨率 mip 再盘式采样
  float lod = clamp(log2(max(radius, 1.0) / 16.0), 0.0, 6.0);
  float effR = radius / exp2(lod);
  float texLod = lod + log2(max(uTexRes.x / size.x, 1.0));
  // Vogel 盘：sqrt 均匀面密度 + 黄金角 + 每像素随机旋转 → 磨砂颗粒
  int taps = int(clamp(effR * 2.0, 6.0, float(uTaps)));
  float rot = hash21(gl_FragCoord.xy) * TWO_PI;
  // 边缘覆盖率：采样核出界部分按比例衰减，不出现硬边
  vec2 foot = (radius + 1.0) / size;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${TAPS_CAP}; ++i) {
    if (i >= taps) break;
    float r = effR * sqrt((float(i) + 0.5) / float(taps));
    float a = float(i) * GOLDEN + rot;
    vec2 uv = uvHit + r * vec2(cos(a), sin(a)) / size;
    float cx = smoothstep(0.0, foot.x, uv.x) * (1.0 - smoothstep(1.0 - foot.x, 1.0, uv.x));
    float cy = smoothstep(0.0, foot.y, uv.y) * (1.0 - smoothstep(1.0 - foot.y, 1.0, uv.y));
    sum += textureLod(uTex, uv, texLod).rgb * cx * cy;
  }
  return sum / float(taps) * att;
}
`;

  const FS_MAIN = `
// 显示区圆角矩形覆盖率（铰链侧、外侧圆角不同），fwidth 抗锯齿
float dispMask() {
  vec2 c = (uDisp.xy + uDisp.zw) * 0.5, hs = (uDisp.zw - uDisp.xy) * 0.5;
  float r = vLocal.x < c.x ? uDispR.x : uDispR.y;
  vec2 q = abs(vLocal - c) - hs + r;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  return clamp(0.5 - d / max(fwidth(d), 1e-4), 0.0, 1.0);
}

void main() {
  vec2 gdx = dFdx(vWorld.xy), gdy = dFdy(vWorld.xy);
  float dm = uDispOn == 1 ? dispMask() : 0.0;
  vec3 N = normalize(vNrm);
  vec3 V = normalize(uEye - vWorld);
  vec3 L = normalize(uLight);
  vec3 H = normalize(L + V);
  vec3 R = reflect(-V, N);
  float ndl = max(dot(N, L), 0.0);
  float ndh = max(dot(N, H), 0.0);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 c;
  if (uMat == 0) {
    c = uRim0 * (0.18 + 0.55 * ndl) + uRim1 * env(R) * 0.75 + vec3(pow(ndh, 60.0)) * 0.7;
    c += vec3(1.0, 0.72, 0.42) * uFlash * (0.35 + fres);
  } else if (uMat == 1) {
    vec3 refl = env(R) * (0.04 + 0.5 * fres) + vec3(pow(ndh, 160.0)) * 0.6;
    c = vec3(0.012) + refl;
    // 屏幕和黑边同属一块盖板玻璃：只把发光内容叠在下面，反射连续
    if (dm > 0.0) {
      vec3 scr = glassSample(vWorld, gdx, gdy) * (1.0 - uAO.x * exp(-vLocal.x / max(uAO.y, 1.0)));
      c = mix(c, scr + refl * 0.45, dm);
    }
  } else {
    c = uBack * (0.25 + 0.6 * ndl) + env(R) * (0.05 + 0.3 * fres) + vec3(pow(ndh, 24.0)) * 0.12;
  }
  outColor = vec4(c, 1.0);
}
`;

  /* ——— 网格（局部坐标：a 自铰链向外、b 自顶向下、k 自正面向里）——— */

  /* 圆角矩形轮廓点（带外法线）：外侧两角半径 rOut，铰链侧两角半径 rHinge */
  function roundPts(a0, b0, a1, b1, rOut, rHinge) {
    rOut = Math.max(0, rOut); rHinge = Math.max(0, rHinge);
    const cs = [
      [a1 - rOut, b0 + rOut, -Math.PI / 2, rOut], [a1 - rOut, b1 - rOut, 0, rOut],
      [a0 + rHinge, b1 - rHinge, Math.PI / 2, rHinge], [a0 + rHinge, b0 + rHinge, Math.PI, rHinge],
    ];
    const pts = [];
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i <= ARC_SEG; i++) {
        const th = cs[c][2] + (i / ARC_SEG) * Math.PI / 2;
        const ca = Math.cos(th), sa = Math.sin(th);
        pts.push({ a: cs[c][0] + ca * cs[c][3], b: cs[c][1] + sa * cs[c][3], na: ca, nb: sa });
      }
    }
    return pts;
  }

  /* 每个轮廓点的倒角半径：铰链侧几乎不倒角——柔性内屏跨铰链连续，展开时只留一道发丝细的折痕 */
  function bevelAt(p, bev) { return bev * (p.na < 0 ? 1 - 0.9 * -p.na : 1); }

  /* 侧壁：轮廓沿"前倒角 → 直壁 → 后倒角"截面挤出，法线随截面平滑过渡，读起来是圆润的金属边 */
  function buildWalls(g, base) {
    const n = base.length, m = (BEVEL_SEG + 1) * 2, v = [], idx = [];
    for (let i = 0; i < n; i++) {
      const p = base[i], bv = bevelAt(p, g.bev);
      for (let j = 0; j < m; j++) {
        const back = j > BEVEL_SEG;
        const f = (back ? 1 + (j - BEVEL_SEG - 1) / BEVEL_SEG : j / BEVEL_SEG) * Math.PI / 2;
        const inset = bv - bv * Math.sin(f);
        const k = (back ? g.t - bv : bv) - bv * Math.cos(f);
        v.push(p.a - p.na * inset, p.b - p.nb * inset, k, p.na * Math.sin(f), p.nb * Math.sin(f), -Math.cos(f));
      }
    }
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      for (let j = 0; j < m - 1; j++) {
        const A = i * m + j, B = i2 * m + j, C = i2 * m + j + 1, D = i * m + j + 1;
        idx.push(A, B, C, A, C, D);
      }
    }
    return { v: v, idx: idx };
  }

  /* 正/背面：轮廓按各点倒角内缩，与侧壁首尾环严丝合缝 */
  function insetPts(base, bev) {
    return base.map(function (p) { const bv = bevelAt(p, bev); return { a: p.a - p.na * bv, b: p.b - p.nb * bv }; });
  }

  /* 平面（凸多边形扇形三角化），nk = ±1 为沿 k 的法线 */
  function buildFlat(pts, k, nk) {
    let ca = 0, cb = 0;
    for (let i = 0; i < pts.length; i++) { ca += pts[i].a; cb += pts[i].b; }
    ca /= pts.length; cb /= pts.length;
    const v = [ca, cb, k, 0, 0, nk], idx = [];
    for (let i = 0; i < pts.length; i++) {
      v.push(pts[i].a, pts[i].b, k, 0, 0, nk);
      idx.push(0, 1 + i, 1 + (i + 1) % pts.length);
    }
    return { v: v, idx: idx };
  }

  /* 书脊：以铰链轴 (hx, zc) 为心、半径 = 单片厚 + 轴距的圆柱面，只铺满两片背面之间张开的那段弧
   * （ψ=0 时为零，合上时为半圆），两端恰好接上两片背面的铰链边 */
  function buildSpine(hx, zc, yTop, yBot, rad, psi) {
    const v = [], idx = [];
    const seg = Math.max(2, Math.ceil(SPINE_SEG * psi / Math.PI));
    for (let i = 0; i <= seg; i++) {
      const f = psi * i / seg;
      const dx = -Math.sin(f), dz = -Math.cos(f);
      v.push(hx + dx * rad, yTop, zc + dz * rad, dx, 0, dz);
      v.push(hx + dx * rad, yBot, zc + dz * rad, dx, 0, dz);
    }
    for (let i = 0; i < seg; i++) {
      const A = i * 2;
      idx.push(A, A + 1, A + 3, A, A + 3, A + 2);
    }
    /* 上下端盖 */
    for (let s = 0; s < 2; s++) {
      const y = s ? yBot : yTop, ny = s ? 1 : -1;
      const c0 = v.length / 6;
      v.push(hx, y, zc, 0, ny, 0);
      for (let i = 0; i <= seg; i++) {
        const f = psi * i / seg;
        v.push(hx - Math.sin(f) * rad, y, zc - Math.cos(f) * rad, 0, ny, 0);
      }
      for (let i = 0; i < seg; i++) idx.push(c0, c0 + 1 + i, c0 + 2 + i);
    }
    return { v: v, idx: idx };
  }

  /* ——— WebGL 状态 ——— */
  let gl = null, cvGL = null, prog = null, ready = false;
  const U = {};
  let panel = null, panelKey = '';     // 两片机身共用一份局部网格，只换基底
  let spine = null;                    // 书脊随 ψ 每帧重建
  const tex = { arena: null, hud: null };
  const UNIFORMS = ['uOrigin', 'uBasis', 'uEye', 'uView', 'uMat', 'uDispOn', 'uDisp', 'uDispR', 'uLight',
    'uRim0', 'uRim1', 'uBack', 'uFlash', 'uTex', 'uTexRes', 'uRect', 'uPlaneZ', 'uSpread', 'uDark', 'uTaps', 'uAO'];

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[phone-body] shader:', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function makeTex() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const an = gl.getExtension('EXT_texture_filter_anisotropic');
    if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, 4);  // 斜看的屏幕不糊成一片
    return t;
  }

  /* 程序、贴图都挂在上下文上：上下文丢失恢复后整套重建 */
  function setup() {
    ready = false;
    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, FS_HEAD + FS_GLASS + FS_MAIN);
    if (!vs || !fs) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[phone-body] link:', gl.getProgramInfoLog(prog));
      return false;
    }
    for (let i = 0; i < UNIFORMS.length; i++) U[UNIFORMS[i]] = gl.getUniformLocation(prog, UNIFORMS[i]);
    tex.arena = makeTex();
    tex.hud = makeTex();
    panel = null; panelKey = ''; spine = null;
    ready = true;
    return true;
  }

  /* 返回 false 表示不支持 WebGL2 / 着色器失败，调用方走 2D 降级 */
  PA.initGL = function (canvas) {
    cvGL = canvas;
    gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) return false;
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); ready = false; });
    canvas.addEventListener('webglcontextrestored', function () { setup(); });
    return setup();
  };
  PA.glReady = function () { return ready && gl && !gl.isContextLost(); };

  function upload(mesh) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.v), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao: vao, vb: vb, ib: ib, n: mesh.idx.length, parts: mesh.parts };
  }
  function free(o) {
    if (!o) return;
    gl.deleteVertexArray(o.vao); gl.deleteBuffer(o.vb); gl.deleteBuffer(o.ib);
  }

  /* 多段网格合并进一个缓冲，parts 记录各段索引区间（按材质分次绘制） */
  function merge(list) {
    const v = [], idx = [], parts = [];
    for (let i = 0; i < list.length; i++) {
      const off = v.length / 6;
      parts.push({ first: idx.length, count: list[i].idx.length });
      for (let j = 0; j < list[i].v.length; j++) v.push(list[i].v[j]);
      for (let j = 0; j < list[i].idx.length; j++) idx.push(list[i].idx[j] + off);
    }
    return { v: v, idx: idx, parts: parts };
  }

  /* 单片机身的形体参数：两片共用，左片只是换一个基底 */
  function shape(L) {
    return { bev: L.t * 0.45, t: L.t, r: L.m.r, rh: L.m.r * 0.12, g: L.t * HINGE_GAP };
  }

  function ensurePanel(L) {
    const key = L.cw.toFixed(2) + 'x' + L.ph.toFixed(2);
    if (panel && panelKey === key) return;
    free(panel); free(spine); spine = null;
    const s = shape(L);
    const base = roundPts(0, 0, L.cw, L.ph, s.r, s.rh);
    const ins = insetPts(base, s.bev);
    panel = upload(merge([buildWalls(s, base), buildFlat(ins, 0, -1), buildFlat(ins, s.t, 1)]));
    panelKey = key;
  }

  /* 书脊局部坐标以铰链轴为原点，只随 ψ 变化重建；平移由 uOrigin 负责 */
  let spinePsi = -1;
  function ensureSpine(L, psi) {
    if (spine && Math.abs(psi - spinePsi) < 1e-4) return;
    free(spine);
    const s = shape(L);
    const m = buildSpine(0, 0, s.rh * 0.5, L.ph - s.rh * 0.5, s.t + s.g, psi);
    m.parts = [{ first: 0, count: m.idx.length }];
    spine = upload(m);
    spinePsi = psi;
  }

  /* 左片基底：绕竖直铰链轴转 ψ。列向量 a/b/k（局部 → 世界），ψ=0 平铺、ψ=π 合上 */
  function leftBasis(psi) {
    const c = Math.cos(psi), s = Math.sin(psi);
    return { a: [-c, 0, s], b: [0, 1, 0], k: [-s, 0, -c] };
  }
  const RIGHT_BASIS = { a: [1, 0, 0], b: [0, 1, 0], k: [0, 0, -1] };

  /* 左片正面四角的世界坐标（供 render 画投影到桌面的阴影） */
  PA.flapCorners = function (L, hx, psi) {
    const B = leftBasis(psi), s = shape(L);
    const o = [hx - s.g * Math.sin(psi), L.y0, s.g - s.g * Math.cos(psi)];
    const pts = [[0, 0], [L.cw, 0], [L.cw, L.ph], [0, L.ph]];
    return pts.map(function (p) {
      return [o[0] + B.a[0] * p[0], o[1] + p[1], o[2] + B.a[2] * p[0]];
    });
  };

  let vw = 1, vh = 1;
  PA.resizeGL = function (W, H, dpr) {
    if (!cvGL) return;
    cvGL.width = Math.max(1, Math.round(W * dpr));
    cvGL.height = Math.max(1, Math.round(H * dpr));
    vw = W; vh = H;
  };

  function upTex(t, cv) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  function basis(B) {
    gl.uniformMatrix3fv(U.uBasis, false, [B.a[0], B.a[1], B.a[2], B.b[0], B.b[1], B.b[2], B.k[0], B.k[1], B.k[2]]);
  }

  /* 画网格的一段；scr 为 null 时是不发光的面，否则 {tex, cv, rect, z, ao} 描述该面显示的内容平面 */
  function part(mesh, i, mat, scr) {
    gl.uniform1i(U.uMat, mat);
    gl.uniform1i(U.uDispOn, scr ? 1 : 0);
    if (scr) {
      gl.uniform4fv(U.uDisp, scr.mask);
      gl.uniform2fv(U.uDispR, scr.r);
      gl.bindTexture(gl.TEXTURE_2D, scr.tex);
      gl.uniform2f(U.uTexRes, scr.cv.width, scr.cv.height);
      gl.uniform4fv(U.uRect, scr.rect);
      gl.uniform1f(U.uPlaneZ, scr.z);
      gl.uniform2f(U.uAO, scr.ao || 0, scr.aoW || 1);
    }
    const p = mesh.parts[i];
    gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_SHORT, p.first * 2);
  }

  /* 每帧绘制。o: { L, hx, psi, eyeX, eyeY, flash, arena, hud }，arena/hud 为 2D 内容画布（hud 可为 null 表示看不见、不必上传）
   * 返回 false 时调用方走 2D 降级 */
  PA.drawGL = function (o) {
    if (!PA.glReady() || !o.arena || !o.arena.width) return false;
    const L = o.L, psi = Math.max(0, Math.min(Math.PI, o.psi));
    ensurePanel(L);
    ensureSpine(L, psi);
    const s = shape(L), f = PA.finish().gl, sn = Math.sin(psi), cs = Math.cos(psi);

    gl.viewport(0, 0, cvGL.width, cvGL.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);   // 左片基底是镜像手性，两片绕序相反，统一靠深度测试
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    upTex(tex.arena, o.arena);
    if (o.hud && o.hud.width) upTex(tex.hud, o.hud);

    gl.uniform3f(U.uEye, o.eyeX, o.eyeY, L.ph * CFG.EYE_DIST_H);
    gl.uniform2f(U.uView, vw, vh);
    gl.uniform3f(U.uLight, -0.42, -0.7, 0.58);
    gl.uniform3fv(U.uRim0, f.rim0);
    gl.uniform3fv(U.uRim1, f.rim1);
    gl.uniform3fv(U.uBack, f.back);
    gl.uniform1f(U.uFlash, o.flash || 0);
    gl.uniform1i(U.uTex, 0);
    gl.uniform1f(U.uSpread, CFG.GLASS_SPREAD);
    gl.uniform1f(U.uDark, CFG.GLASS_DARK);
    gl.uniform1i(U.uTaps, Math.min(TAPS_CAP, CFG.GLASS_TAPS | 0));

    const y0 = L.y0, ya = y0 + L.e, yb = ya + L.dispH;
    const inner = [0, L.e, L.dispW, L.e + L.dispH];          // 内屏：铰链侧无黑边，跨铰链连续
    const cover = [L.e, L.e, L.dispW, L.e + L.dispH];        // 外屏：四周都有黑边
    const rOut = Math.max(1, L.m.r - L.e * 0.7);
    const innerR = [s.rh, rOut], coverR = [rOut, rOut];
    /* 合拢中两块内屏相互遮光：铰链处最暗，向外指数衰减 */
    const ao = 0.75 * (1 - cs) / 2, aoW = L.cw * (0.15 + 0.5 * sn);
    const arenaRect = [o.hx, ya, o.hx + L.dispW, yb];
    /* 外屏铰链侧也有黑边，比内屏窄 e：战场整幅压进外屏（横向约 3% 形变），保证光束根部在合上时可见 */
    const coverRect = [o.hx + L.e, ya, o.hx + L.dispW, yb];

    gl.bindVertexArray(panel.vao);
    /* 右片：固定，内屏 = 战场（贴合内容平面，gap 恒 0，永远清晰） */
    basis(RIGHT_BASIS);
    gl.uniform3f(U.uOrigin, o.hx, y0, 0);
    part(panel, 0, 0, null);
    part(panel, 1, 1, { tex: tex.arena, cv: o.arena, mask: inner, r: innerR, rect: arenaRect, z: 0, ao: ao, aoW: aoW });
    part(panel, 2, 2, null);

    /* 左片：绕铰链轴 (hx, zc) 转 ψ。内屏的内容平面 = 平铺位置，外屏的内容平面 = 合上位置 */
    basis(leftBasis(psi));
    gl.uniform3f(U.uOrigin, o.hx - s.g * sn, y0, s.g - s.g * cs);
    part(panel, 0, 0, null);
    part(panel, 1, 1, o.hud ? { tex: tex.hud, cv: o.hud, mask: inner, r: innerR, rect: [o.hx - L.dispW, ya, o.hx, yb], z: 0, ao: ao, aoW: aoW } : null);
    part(panel, 2, 1, { tex: tex.arena, cv: o.arena, mask: cover, r: coverR, rect: coverRect, z: 2 * s.g + s.t, ao: 0 });

    if (psi > 1e-3) {
      gl.bindVertexArray(spine.vao);
      basis({ a: [1, 0, 0], b: [0, 1, 0], k: [0, 0, 1] });
      gl.uniform3f(U.uOrigin, o.hx, y0, s.g);
      part(spine, 0, 0, null);
    }
    gl.bindVertexArray(null);
    return true;
  };
})();
