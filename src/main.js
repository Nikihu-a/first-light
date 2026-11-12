// 初光 First Light — live version. The first five seconds match the film; after that the scene keeps living.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

const q = new URLSearchParams(location.search);
const TEST = q.has('test');
const stage = document.getElementById('stage');
let qScale = 1;                       // lowered automatically when the GPU can't keep up
function pickSize() {
  if (TEST) return [+(q.get('w') || 960), +(q.get('h') || 540)];
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(stage.clientWidth, 1) * dpr * qScale, h = Math.max(stage.clientHeight, 1) * dpr * qScale;
  const k = Math.min(1, Math.sqrt(2.3e6 / (w * h)));
  return [Math.max(2, Math.round(w * k / 2) * 2), Math.max(2, Math.round(h * k / 2) * 2)];
}
let [W, H] = pickSize();
const DURATION = 5.0;
const D2R = Math.PI / 180;

// ---------------------------------------------------------------- utils
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(1 - r() * 0.999999)) * Math.cos(6.2831853 * r()); }
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- renderer
if (!document.createElement('canvas').getContext('webgl2')) throw new Error('WebGL2 unavailable');
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: TEST, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, W / H, 0.3, 5000);
const U_STAR = { value: H / 1080 };
function fitCamera() {
  // keep the film's horizontal field of view; narrow windows get more sky and water instead of a crop
  camera.aspect = W / H;
  camera.fov = Math.min(75, Math.max(34, 2 * Math.atan(0.5435 / camera.aspect) / D2R));
  camera.updateProjectionMatrix();
  U_STAR.value = (H / 1080) * (34 / camera.fov);
}

// ---------------------------------------------------------------- shared state
const SUN_AZ = 5.5 * D2R;
const SUN_R = 0.6;        // deg, artistic (telephoto feel)
const SADDLE = 0.75;      // deg, ridge height where the sun comes up
const MOON_DIR = (() => { const az = SUN_AZ + 12.5 * D2R, e = 15.2 * D2R; return V3(Math.sin(az) * Math.cos(e), Math.sin(e), -Math.cos(az) * Math.cos(e)); })();
const CAM0 = V3(0.5, 1.15, 22.6);

const G = {
  uTime: { value: 0 },
  uSunDir: { value: V3(0, 0, -1) },
  uSunVis: { value: 0 },
  uDawn: { value: 0 },
  uMoonDir: { value: MOON_DIR },
  uSunCol: { value: V3(2.1, 0.90, 0.50) },
};

const SKY_GLSL = /* glsl */`
uniform float uTime;
uniform vec3 uSunDir;
uniform float uSunVis;
uniform float uDawn;

float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1.,0.)), f.x), mix(hash21(i+vec2(0.,1.)), hash21(i+vec2(1.,1.)), f.x), f.y);
}
float fbm(vec2 p){ float a = 0.5, s = 0.0; for(int i=0;i<5;i++){ s += a*vnoise(p); p = p*2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }

// smooth twilight gradient: cool zenith + stacked warm layers hugging the horizon near the sun
vec3 skyGlow(vec3 d){
  float e = max(degrees(asin(clamp(d.y, -1.0, 1.0))), 0.0);
  vec2 dh = normalize(d.xz + vec2(0.0, -1e-5));
  vec2 sh = normalize(uSunDir.xz);
  float az = max(dot(dh, sh), 0.0);
  float toward = pow(az, 10.0);
  float warm = (0.16 + 0.84*toward) * (0.70 + 0.50*uDawn);
  float cool = 1.0 - 0.6*exp(-e/3.0);
  vec3 c = (vec3(0.006, 0.012, 0.040) + vec3(0.018, 0.036, 0.112) * exp(-e/18.0)) * cool;
  c += vec3(0.26, 0.078, 0.155) * exp(-e/5.5) * (1.0 - exp(-e/2.2)) * (0.55 + 0.45*toward) * (0.85 + 0.30*uDawn);
  c += vec3(0.17, 0.06, 0.10) * exp(-e/4.5) * (1.0 - toward);
  c += vec3(0.85, 0.20, 0.07) * exp(-e/3.0) * warm;
  c += vec3(1.10, 0.42, 0.03) * exp(-e/1.3) * warm;
  return c;
}
`;

// ---------------------------------------------------------------- sky dome
const skyMat = new THREE.ShaderMaterial({
  uniforms: { ...G },
  side: THREE.BackSide, depthWrite: false, depthTest: false,
  vertexShader: /* glsl */`
    varying vec3 vWorld;
    void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: SKY_GLSL + /* glsl */`
    uniform vec3 uMoonDir;
    varying vec3 vWorld;
    void main(){
      vec3 d = normalize(vWorld - cameraPosition);
      float e = degrees(asin(clamp(d.y, -1.0, 1.0)));
      float mu = dot(d, uSunDir);
      vec3 col = skyGlow(d);

      // high thin clouds, lit from underneath
      float yy = max(d.y, 0.0) + 0.055;
      vec2 cuv = d.xz / yy;
      cuv = cuv * vec2(0.085, 0.36) + vec2(uTime*0.010 + 3.7, 1.3);
      float n = fbm(cuv) * 0.75 + fbm(cuv*2.7 + 5.0) * 0.25;
      float cov = smoothstep(0.45, 0.70, n) * smoothstep(0.8, 3.4, e) * (1.0 - 0.6*smoothstep(12.0, 24.0, e));
      float sunProx = exp((mu - 1.0) * 7.0);
      float low = exp(-max(e,0.0)/10.0);
      vec3 ccol = mix(vec3(0.034, 0.032, 0.085), vec3(1.05, 0.30, 0.20), sunProx*low*(0.70+0.40*uDawn));
      ccol += vec3(1.2, 0.55, 0.12) * exp((mu - 1.0) * 70.0) * (0.35 + 0.9*uSunVis);
      float ca = cov * 0.78;

      // glow around the sun
      float halo = 0.26 + 0.20*uDawn + 0.50*uSunVis;
      col += vec3(1.0, 0.42, 0.10) * (0.45*exp((mu-1.0)*90.0) + 1.4*exp((mu-1.0)*900.0)) * halo;

      // sun disc
      float cr = cos(radians(${SUN_R.toFixed(3)}));
      float disc = smoothstep(cr - 0.000018, cr + 0.000018, mu);
      col += disc * vec3(20.0, 9.0, 2.4) * (1.0 - ca*0.9);

      // crescent moon with earthshine
      vec3 mx = normalize(cross(vec3(0.0,1.0,0.0), uMoonDir));
      vec3 my = cross(uMoonDir, mx);
      float mr = radians(0.80);
      vec2 mq = vec2(dot(d, mx), dot(d, my)) / mr;
      float md = length(mq);
      if (md < 6.0 && dot(d, uMoonDir) > 0.0) {
        vec2 s = normalize(vec2(dot(uSunDir, mx), dot(uSunDir, my)));
        float along = dot(mq, s), perp = dot(mq, vec2(-s.y, s.x));
        float mdisc = 1.0 - smoothstep(0.96, 1.03, md);
        float term = sqrt(max(1.0 - perp*perp, 0.0)) * 0.62;
        float lit = smoothstep(term - 0.05, term + 0.05, along) * mdisc;
        vec3 mcol = lit * vec3(2.4, 2.25, 1.95) + mdisc * (1.0 - lit) * vec3(0.012, 0.015, 0.032);
        col = mix(col, col*0.55, mdisc*(1.0-lit)*0.0) + mcol * (1.0 - ca);
        col += vec3(0.20, 0.22, 0.36) * exp(-md*1.1) * 0.07;
      }

      col = mix(col, ccol, ca);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), skyMat);
sky.renderOrder = -10; sky.frustumCulled = false;
scene.add(sky);

// ---------------------------------------------------------------- stars
{
  const r = mulberry32(11);
  const N = 2600;
  const pos = new Float32Array(N * 3), dat = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const az = (r() * 2 - 1) * 75 * D2R, el = Math.asin(0.03 + r() * 0.9);
    pos[i*3] = Math.sin(az) * Math.cos(el) * 2800; pos[i*3+1] = Math.sin(el) * 2800; pos[i*3+2] = -Math.cos(az) * Math.cos(el) * 2800;
    const m = Math.pow(r(), 5.0);
    dat[i*3] = 1.3 + m * 2.6;               // size px
    dat[i*3+1] = 0.45 + m * 2.8;            // brightness
    dat[i*3+2] = r() * 6.283;               // twinkle phase
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aDat', new THREE.BufferAttribute(dat, 3));
  const m = new THREE.ShaderMaterial({
    uniforms: { ...G, uScale: U_STAR },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: SKY_GLSL + /* glsl */`
      attribute vec3 aDat; uniform float uScale; varying float vB; varying vec3 vC;
      void main(){
        vec3 d = normalize(position);
        float e = degrees(asin(d.y));
        vec3 bg = skyGlow(d);
        float lum = dot(bg, vec3(0.3, 0.5, 0.2));
        float yy = max(d.y, 0.0) + 0.055;
        vec2 cuv = d.xz / yy * vec2(0.085, 0.36) + vec2(uTime*0.010 + 3.7, 1.3);
        float n = fbm(cuv) * 0.75 + fbm(cuv*2.7 + 5.0) * 0.25;
        float cov = smoothstep(0.45, 0.70, n) * smoothstep(0.8, 3.4, e);
        float tw = 0.78 + 0.22*sin(uTime*(2.0 + aDat.z) + aDat.z*7.0);
        vB = aDat.y * tw * (1.0 - smoothstep(0.03, 0.13, lum)) * (1.0 - cov) * (1.0 - 0.35*uDawn);
        vC = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.92, 0.82), fract(aDat.z*3.3));
        gl_PointSize = aDat.x * uScale;
        gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition * vec3(1.0, 0.0, 1.0), 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying float vB; varying vec3 vC;
      void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float a = 1.0 - smoothstep(0.0, 1.0, r); gl_FragColor = vec4(vC * vB * a * a, 1.0); }`,
  });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = -9;
  scene.add(pts);
}

// ---------------------------------------------------------------- mountains (angular ridgelines around the camera)
{
  const noise1 = (seed) => {
    const r = mulberry32(seed); const v = Array.from({ length: 512 }, () => r());
    const n = (x) => { const i = Math.floor(x), f = x - i; const u = f*f*(3-2*f); return v[i & 511] * (1-u) + v[(i+1) & 511] * u; };
    return (x) => { let s = 0, a = 0.5, fq = 1; for (let o = 0; o < 6; o++) { s += a * n(x * fq + o * 31.7); a *= 0.5; fq *= 2.07; } return s; };
  };
  const layers = [
    { D: 1500, base: 1.25, amp: 4.6, f: 0.050, seed: 3, dip: [0.45, 1.0, 12.0], col: V3(0.030, 0.030, 0.085), haze: 0.66, ridged: 0.6 },
    { D: 950,  base: 0.55, amp: 3.3, f: 0.062, seed: 8, dip: [SADDLE, 0.0, 9.5], col: V3(0.020, 0.020, 0.062), haze: 0.44, ridged: 0.5 },
    { D: 520,  base: 0.25, amp: 1.5, f: 0.085, seed: 21, dip: [0.30, 0.0, 8.0], col: V3(0.011, 0.012, 0.040), haze: 0.24, ridged: 0.2 },
  ];
  for (const L of layers) {
    const fn = noise1(L.seed);
    const N = 900, span = 80;
    const pos = new Float32Array((N + 1) * 2 * 3), idx = [];
    for (let i = 0; i <= N; i++) {
      const th = (-span + 2 * span * i / N);       // deg, azimuth from -z
      let nn = fn((th + 200) * L.f);
      const rg = 1 - Math.abs(2 * fn((th + 500) * L.f * 0.8) - 1);
      nn = nn * (1 - L.ridged) + rg * rg * L.ridged * 0.9;
      let E = L.base + L.amp * Math.max(nn - 0.22, 0) * 1.4;
      const dAz = Math.abs(th - SUN_AZ / D2R);
      E = L.dip[0] + (E - L.dip[0]) * sstep(L.dip[1], L.dip[2], dAz);
      const x = CAM0.x + L.D * Math.sin(th * D2R), z = CAM0.z - L.D * Math.cos(th * D2R);
      const y = L.D * Math.tan(E * D2R) + CAM0.y;
      pos.set([x, -3, z, x, y, z], i * 6);
      if (i < N) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...G, uBase: { value: L.col }, uHaze: { value: L.haze } },
      side: THREE.DoubleSide,
      vertexShader: /* glsl */`varying vec3 vWorld; void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vWorld = wp.xyz; gl_Position = projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: SKY_GLSL + /* glsl */`
        uniform vec3 uBase; uniform float uHaze; varying vec3 vWorld;
        void main(){
          vec3 d = normalize(vWorld - cameraPosition);
          float e = abs(degrees(asin(clamp(d.y, -1.0, 1.0))));
          vec3 hz = skyGlow(normalize(vec3(d.x, 0.050, d.z)));
          vec3 ms = skyGlow(normalize(vec3(d.x, 0.014, d.z)));
          float mu = dot(normalize(vec3(d.x, uSunDir.y, d.z)), uSunDir);
          ms += vec3(1.0, 0.42, 0.10) * 0.22 * exp((mu - 1.0) * 90.0) * (0.3 + 0.25*uDawn + 0.6*uSunVis);
          vec3 col = mix(uBase, hz, uHaze);
          float mist = exp(-e / 0.30) * 0.72;
          col = mix(col, ms * 0.90, mist);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; scene.add(mesh);
  }
}

// ---------------------------------------------------------------- the tree
const TREE = V3(-2.7, 0.30, 0.0);
function buildTree(seed) {
  const rnd = mulberry32(seed);
  const R = (a, b) => a + rnd() * (b - a);
  const MAXD = 5;
  const SIDE = [0, 0.50, 0.50, 0.42, 0.28, 0];
  const tubes = [], anchors = [];
  const randPerp = (d) => { const a = V3(R(-1,1), R(-1,1), R(-1,1)); a.addScaledVector(d, -a.dot(d)); return a.normalize(); };
  function grow(pos, dir, len, rad, depth, nseg) {
    const pts = [pos.clone()], radii = [rad];
    let p = pos.clone(); const d = dir.clone().normalize();
    const sl = len / nseg, kids = [];
    for (let i = 1; i <= nseg; i++) {
      const wob = depth === 0 ? 0.11 : 0.15 + 0.035 * depth;
      d.addScaledVector(randPerp(d), wob * R(0.3, 1));
      if (depth === 1) d.y += 0.040;
      if (depth === 2) d.y += 0.015;
      if (depth >= 4) d.y -= 0.030;
      d.normalize();
      p = p.clone().addScaledVector(d, sl);
      const r = Math.max(rad * (1 - 0.45 * i / nseg), 0.006);
      pts.push(p.clone()); radii.push(r);
      if (depth >= 2) anchors.push({ p: p.clone(), depth });
      if (depth >= 1 && depth < MAXD && i < nseg && rnd() < SIDE[depth]) {
        const sd = d.clone().multiplyScalar(0.5).addScaledVector(randPerp(d), 0.9); sd.y = sd.y * 0.55 + 0.10; sd.normalize();
        kids.push([p.clone(), sd, len * R(0.42, 0.62), r * 0.58, depth + 1]);
      }
    }
    tubes.push({ pts, radii });
    if (depth < MAXD) {
      const k = 2 + (rnd() < 0.28 ? 1 : 0);
      const base = randPerp(d);
      for (let j = 0; j < k; j++) {
        const perp = base.clone().applyAxisAngle(d, (j / k) * Math.PI * 2 + R(-0.5, 0.5));
        const tilt = R(0.33, 0.72);
        const nd = d.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(perp, Math.sin(tilt));
        nd.y = nd.y * 0.72 + 0.07; nd.normalize();
        kids.push([p.clone(), nd, len * R(0.62, 0.78), radii[nseg] * 0.74, depth + 1]);
      }
    }
    for (const k of kids) grow(k[0], k[1], k[2], k[3], k[4], Math.max(3, nseg - 1));
  }
  // trunk — hand placed, leaning a little toward the light
  const trunkPts = [V3(-0.10, -0.35, 0), V3(-0.06, 0.20, 0.01), V3(0.02, 0.60, 0.03), V3(0.16, 1.00, 0.03), V3(0.30, 1.38, 0.0), V3(0.38, 1.72, -0.03), V3(0.41, 1.98, -0.04)];
  const trunkR = [0.40, 0.28, 0.235, 0.21, 0.195, 0.185, 0.18];
  tubes.push({ pts: trunkPts, radii: trunkR });
  const top = trunkPts[trunkPts.length - 1];
  const boughs = [
    [V3(0.96, 0.30, 0.12), 2.95, 0.125, 0.55],   // the long arm reaching out over the water, toward the light
    [V3(-0.86, 0.46, -0.08), 2.45, 0.120, 0.30],
    [V3(0.10, 1.00, -0.12), 2.25, 0.115, 0.0],   // leader
    [V3(0.55, 0.78, -0.50), 2.10, 0.100, 0.10],
    [V3(-0.42, 0.80, 0.46), 2.00, 0.100, 0.15],
    [V3(-0.50, 0.66, -0.58), 1.95, 0.095, 0.25],
    [V3(0.52, 0.56, 0.62), 1.95, 0.095, 0.35],
  ];
  for (const b of boughs) {
    // b[3] walks the attachment point down from the crown of the trunk
    const t = b[3] * 2, n = trunkPts.length - 1, i = Math.min(Math.floor(t), 1), f = Math.min(t - i, 1);
    grow(trunkPts[n - i].clone().lerp(trunkPts[n - i - 1], f), b[0], b[1], b[2], 1, 5);
  }
  return { tubes, anchors };
}
function tubesToGeometry(tubes, radial = 7) {
  const pos = [], nor = [], idx = [];
  for (const tb of tubes) {
    const n = tb.pts.length, base = pos.length / 3; let prev = null;
    for (let i = 0; i < n; i++) {
      const t = tb.pts[Math.min(n - 1, i + 1)].clone().sub(tb.pts[Math.max(0, i - 1)]).normalize();
      let nx = prev ? prev.clone().addScaledVector(t, -prev.dot(t)) : V3(1, 0, 0).cross(t);
      if (nx.lengthSq() < 1e-6) nx = V3(0, 0, 1).cross(t);
      nx.normalize(); prev = nx; const by = t.clone().cross(nx);
      for (let j = 0; j < radial; j++) {
        const an = j / radial * Math.PI * 2;
        const d = nx.clone().multiplyScalar(Math.cos(an)).addScaledVector(by, Math.sin(an));
        const pp = tb.pts[i].clone().addScaledVector(d, tb.radii[i]);
        pos.push(pp.x, pp.y, pp.z); nor.push(d.x, d.y, d.z);
      }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
      const a = base + i * radial + j, b = base + i * radial + (j + 1) % radial, c = a + radial, d = b + radial;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

const SWAY_GLSL = /* glsl */`
vec3 sway(vec3 p, float t, float gust){
  float h = smoothstep(1.6, 5.5, p.y);
  float a = (0.010 + 0.028*gust) * h;
  return vec3(sin(t*1.25 + p.x*0.7 + p.z*0.5) + 0.5*sin(t*2.7 + p.x*1.9), 0.25*sin(t*1.9 + p.z), cos(t*1.05 + p.x*0.45 + p.z*0.8)) * a;
}`;
const LIGHT_UNI = {
  uAmbSky: { value: V3(0.150, 0.150, 0.310) },
  uAmbLow: { value: V3(0.030, 0.024, 0.055) },
  uGlowCol: { value: V3(0.60, 0.22, 0.15) },
  uGlowDir: { value: V3(Math.sin(SUN_AZ), 0.12, -Math.cos(SUN_AZ)).normalize() },
  uGust: { value: 0 },
};

const TS = 0.84;
const treeGroup = new THREE.Group(); treeGroup.position.copy(TREE); treeGroup.scale.setScalar(TS); scene.add(treeGroup);
const tree = buildTree(+(q.get('seed') || 5));
{
  const g = tubesToGeometry(tree.tubes);
  const m = new THREE.ShaderMaterial({
    uniforms: { ...G, ...LIGHT_UNI },
    vertexShader: SWAY_GLSL + /* glsl */`
      uniform float uTime; uniform float uGust; varying vec3 vN; varying vec3 vWorld;
      void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); wp.xyz += sway(wp.xyz, uTime, uGust); vWorld = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunCol, uAmbSky, uGlowCol, uGlowDir; uniform float uSunVis, uDawn; varying vec3 vN; varying vec3 vWorld;
      void main(){
        vec3 N = normalize(vN), V = normalize(cameraPosition - vWorld);
        vec3 alb = vec3(0.10, 0.075, 0.085);
        float up = N.y*0.5 + 0.5;
        vec3 col = alb * (uAmbSky * (0.35 + 0.65*up) + uGlowCol * pow(max(dot(N, uGlowDir)*0.5+0.5, 0.0), 2.0) * (0.6 + 0.5*uDawn));
        float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * smoothstep(-0.35, 0.5, dot(N, uSunDir));
        col += uSunCol * uSunVis * (alb * max(dot(N, uSunDir), 0.0) * 1.2 + rim * 0.22);
        col += uGlowCol * rim * 0.05 * (0.5 + uDawn);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; treeGroup.add(mesh);
}

// ---------------------------------------------------------------- blossoms
function flowerGeometry() {
  // five cupped petals; aR = 0 at the heart, 1 at the petal tip
  const pos = [], nor = [], rr = [], idx = [];
  const prof = [[0, 0, 0], [-0.26, 0.30, 0.10], [-0.36, 0.66, 0.22], [0, 1.0, 0.30], [0.36, 0.66, 0.22], [0.26, 0.30, 0.10]];
  for (let k = 0; k < 5; k++) {
    const a = k / 5 * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), b = pos.length / 3;
    const pts = prof.map(([x, y, z]) => V3(x * ca - y * sa, x * sa + y * ca, z));
    const n = pts[2].clone().sub(pts[0]).cross(pts[4].clone().sub(pts[0])).normalize();
    pts.forEach((p, i) => { pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z); rr.push(Math.hypot(prof[i][0], prof[i][1])); });
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 3, b + 4, b, b + 4, b + 5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aR', new THREE.Float32BufferAttribute(rr, 1));
  g.setIndex(idx);
  return g;
}
function petalGeometry() {
  const P = [[0, 0.5, 0.02], [0, 0, 0], [-0.30, 0.30, 0.05], [-0.40, 0.66, 0.10], [-0.17, 0.97, 0.13], [0, 0.88, 0.10], [0.17, 0.97, 0.13], [0.40, 0.66, 0.10], [0.30, 0.30, 0.05]];
  const pos = [], nor = [], rr = [], idx = [];
  for (const p of P) { pos.push(p[0], p[1] - 0.5, p[2]); nor.push(0, 0, 1); rr.push(p[1]); }
  for (let i = 1; i < 9; i++) idx.push(0, i, i === 8 ? 1 : i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aR', new THREE.Float32BufferAttribute(rr, 1));
  g.setIndex(idx);
  return g;
}
function blossomMaterial(isFlower) {
  return new THREE.ShaderMaterial({
    uniforms: { ...G, ...LIGHT_UNI, uSwayOn: { value: isFlower ? 1 : 0 } },
    side: THREE.DoubleSide,
    vertexShader: SWAY_GLSL + /* glsl */`
      attribute float aR; attribute vec3 aTint; attribute vec2 aOcc; attribute vec3 aCN;
      uniform float uTime, uGust, uSwayOn;
      varying vec3 vN, vWorld, vTint, vCN; varying vec2 vOcc; varying float vR;
      void main(){
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vec3 anchor = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        wp.xyz += sway(anchor, uTime, uGust) * uSwayOn;
        float ph = dot(anchor, vec3(7.1, 3.3, 5.7));
        wp.xyz += uSwayOn * (wp.xyz - anchor) * 0.10 * sin(uTime*3.1 + ph) * (0.4 + uGust);
        vWorld = wp.xyz; vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        vTint = aTint; vOcc = aOcc; vR = aR; vCN = aCN;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunCol, uAmbSky, uAmbLow, uGlowCol, uGlowDir; uniform float uSunVis, uDawn;
      varying vec3 vN, vWorld, vTint, vCN; varying vec2 vOcc; varying float vR;
      void main(){
        vec3 Np = normalize(vN); if (!gl_FrontFacing) Np = -Np;
        float cw = step(0.5, dot(vCN, vCN));
        vec3 N = normalize(mix(Np, Np*0.55 + vCN, cw));
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 alb = mix(vec3(0.78, 0.13, 0.30), vTint, smoothstep(0.02, 0.50, vR));
        float up = N.y*0.5 + 0.5;
        vec3 light = mix(uAmbLow, uAmbSky, up*up) * mix(0.22, 1.0, vOcc.y);
        float wrap = dot(N, uGlowDir)*0.5 + 0.5;
        light += uGlowCol * (0.12 + 0.88*wrap*wrap) * mix(0.22, 1.0, vOcc.x) * (0.55 + 0.45*uDawn);
        float trans = pow(max(dot(-V, uSunDir), 0.0), 5.0);
        light += uSunCol * uSunVis * vOcc.x * (0.25*abs(dot(Np, uSunDir)) + 0.35*max(dot(N, uSunDir), 0.0) + 1.15*trans);
        gl_FragColor = vec4(alb * light, 1.0);
      }`,
  });
}

const flowerList = [];   // world-space (tree-local) flower positions for petal spawning
{
  const rnd = mulberry32(99);
  const per = [0, 0, 2, 6, 10, 13];
  const clusters = [];
  for (const a of tree.anchors) clusters.push(a);
  const items = [];
  for (const c of clusters) {
    const n = Math.round(per[c.depth] * (rnd() < 0.22 ? 0.25 : 0.7 + rnd() * 0.8));
    const rad = 0.075 + 0.016 * c.depth + rnd() * 0.05;
    for (let i = 0; i < n; i++) items.push({ p: V3(c.p.x + gauss(rnd) * rad, c.p.y + gauss(rnd) * rad * 0.8, c.p.z + gauss(rnd) * rad), c });
  }
  // occlusion toward the sun and toward the open sky, from cluster density along each ray
  const Ls = V3(Math.sin(SUN_AZ), 0.012, -Math.cos(SUN_AZ)).normalize(), Lu = V3(0.1, 1, 0.05).normalize();
  const cp = clusters.map(c => c.p), tmp = V3(0, 0, 0);
  const occ = (p, L) => { let s = 0; for (let i = 0; i < cp.length; i++) { tmp.subVectors(cp[i], p); const along = tmp.dot(L); if (along <= 0.05) continue; const d2 = tmp.lengthSq() - along * along; if (d2 < 0.10) s += 1 - d2 / 0.10; } return s; };
  const N = items.length;
  const mesh = new THREE.InstancedMesh(flowerGeometry(), blossomMaterial(true), N);
  const tint = new Float32Array(N * 3), oc = new Float32Array(N * 2), cn = new Float32Array(N * 3);
  const crown = V3(0.45, 3.1, 0.0);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = V3(1, 1, 1), E = new THREE.Euler();
  const palette = [[1.0, 0.87, 0.92], [1.0, 0.75, 0.85], [1.0, 0.93, 0.95], [0.99, 0.65, 0.79], [0.97, 0.53, 0.71]];
  for (let i = 0; i < N; i++) {
    const it = items[i];
    E.set(rnd() * 6.283, rnd() * 6.283, rnd() * 6.283); Q.setFromEuler(E);
    const s = 0.060 + rnd() * 0.040; S.set(s, s, s);
    M.compose(it.p, Q, S); mesh.setMatrixAt(i, M);
    const c = palette[Math.min(4, Math.floor(Math.pow(rnd(), 1.3) * 5))], j = 0.92 + rnd() * 0.16;
    tint.set([c[0] * j, c[1] * j, c[2] * j], i * 3);
    oc.set([Math.exp(-0.20 * occ(it.p, Ls)), Math.exp(-0.16 * occ(it.p, Lu))], i * 2);
    const nn = it.p.clone().sub(crown); nn.y *= 1.25; nn.normalize(); cn.set([nn.x, nn.y, nn.z], i * 3);
    flowerList.push(it.p);
  }
  mesh.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
  mesh.geometry.setAttribute('aOcc', new THREE.InstancedBufferAttribute(oc, 2));
  mesh.geometry.setAttribute('aCN', new THREE.InstancedBufferAttribute(cn, 3));
  mesh.frustumCulled = false; treeGroup.add(mesh);
  window.__flowers = N;
}

// ---------------------------------------------------------------- island + grass
const ISL = V3(-2.45, 0, 0.05), ISL_RX = 3.0, ISL_RZ = 1.9;
const islandH = (x, z) => {
  const u = (x - ISL.x) / ISL_RX, v = (z - ISL.z) / ISL_RZ, a = Math.atan2(v, u);
  const lobe = 1 + 0.16 * Math.sin(2 * a + 0.6) + 0.10 * Math.sin(3 * a + 2.1) + 0.07 * Math.sin(5 * a + 1.0) + 0.04 * Math.sin(9 * a);
  const r = Math.sqrt(u * u + v * v) / lobe, r2 = r * r;
  const bump = 0.03 * Math.sin(x * 3.1 + 1.0) * Math.cos(z * 2.7) + 0.018 * Math.sin(x * 7.3 + z * 5.1);
  return r2 < 1 ? 0.20 * Math.pow(1 - r2, 0.8) + 0.34 * Math.pow(1 - r2, 3.0) + bump * (1 - r2) - 0.012 : -0.03 - 0.3 * (r - 1);
};
{
  const RS = 20, AS = 72, pos = [], idx = [];
  for (let i = 0; i <= RS; i++) for (let j = 0; j < AS; j++) {
    const r = Math.pow(i / RS, 0.8) * 1.45, a = j / AS * Math.PI * 2;
    const x = ISL.x + Math.cos(a) * r * ISL_RX, z = ISL.z + Math.sin(a) * r * ISL_RZ;
    pos.push(x, islandH(x, z), z);
  }
  for (let i = 0; i < RS; i++) for (let j = 0; j < AS; j++) { const a = i * AS + j, b = i * AS + (j + 1) % AS, c = a + AS, d = b + AS; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.ShaderMaterial({
    uniforms: { ...G, ...LIGHT_UNI }, side: THREE.DoubleSide,
    vertexShader: /* glsl */`varying vec3 vN, vWorld; void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vWorld = wp.xyz; vN = normal; gl_Position = projectionMatrix*viewMatrix*wp; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunCol, uAmbSky, uGlowCol, uGlowDir; uniform float uSunVis, uDawn; varying vec3 vN, vWorld;
      void main(){ vec3 N = normalize(vN); if(N.y < 0.0) N = -N;
        vec3 alb = vec3(0.035, 0.05, 0.045);
        vec3 col = alb * (uAmbSky * (0.4 + 0.6*N.y) + uGlowCol * (dot(N, uGlowDir)*0.5+0.5) * (0.5+0.5*uDawn) + uSunCol * uSunVis * max(dot(N, uSunDir) + 0.15, 0.0));
        gl_FragColor = vec4(col, 1.0); }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; scene.add(mesh);
}
{
  const rnd = mulberry32(42), N = 9000;
  const bp = [], bh = [];
  const prof = [[-0.5, 0], [0.5, 0], [-0.38, 0.35], [0.38, 0.35], [-0.22, 0.7], [0.22, 0.7], [0, 1]];
  for (const p of prof) { bp.push(p[0], p[1], 0); bh.push(p[1]); }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3)); g.setAttribute('aH', new THREE.Float32BufferAttribute(bh, 1));
  g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6]);
  const root = new Float32Array(N * 3), par = new Float32Array(N * 4);
  let n = 0;
  while (n < N) {
    const a = rnd() * 6.283, r = Math.sqrt(rnd()) * 1.32;
    const x = ISL.x + Math.cos(a) * r * ISL_RX, z = ISL.z + Math.sin(a) * r * ISL_RZ, y = islandH(x, z);
    if (y < -0.012) continue;
    const edge = sstep(0.16, 0.0, y);
    root.set([x, y, z], n * 3);
    par.set([(0.08 + rnd() * 0.19) * (1 + edge * 1.5) * (rnd() < 0.07 ? 2.1 : 1), rnd() * 6.283, 0.15 + rnd() * 0.55, rnd() * 6.283], n * 4);
    n++;
  }
  g.setAttribute('aRoot', new THREE.InstancedBufferAttribute(root, 3)); g.setAttribute('aPar', new THREE.InstancedBufferAttribute(par, 4));
  g.instanceCount = N;
  const m = new THREE.ShaderMaterial({
    uniforms: { ...G, ...LIGHT_UNI }, side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute float aH; attribute vec3 aRoot; attribute vec4 aPar; uniform float uTime, uGust; varying float vH; varying vec3 vWorld; varying float vRnd;
      void main(){
        float hgt = aPar.x, yaw = aPar.y;
        vec3 side = vec3(cos(yaw), 0.0, sin(yaw)), fwd = vec3(-sin(yaw), 0.0, cos(yaw));
        float bend = aPar.z + (0.10 + 0.25*uGust) * sin(uTime*1.6 + aPar.w + aRoot.x*1.3);
        vec3 p = aRoot + side * position.x * 0.022 + vec3(0.0, 1.0, 0.0) * aH * hgt * (1.0 - 0.25*bend*aH) + fwd * bend * aH*aH * hgt;
        vH = aH; vWorld = p; vRnd = fract(aPar.w*1.7);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunCol, uAmbSky, uGlowCol; uniform float uSunVis, uDawn; varying float vH; varying vec3 vWorld; varying float vRnd;
      void main(){
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 alb = mix(vec3(0.020, 0.036, 0.032), vec3(0.070, 0.105, 0.050), vH) * (0.7 + 0.6*vRnd);
        float trans = pow(max(dot(-V, uSunDir), 0.0), 4.0);
        vec3 col = alb * (uAmbSky * (0.35 + 0.65*vH) + uGlowCol * 0.6 * (0.5+0.5*uDawn) + uSunCol * uSunVis * (0.20 + 1.15*trans) * vH);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; scene.add(mesh);
}

// ---------------------------------------------------------------- petals: resting, floating, and falling
const petalGeo = petalGeometry();
function makePetalMesh(count) {
  const mesh = new THREE.InstancedMesh(petalGeo.clone(), blossomMaterial(false), count);
  mesh.frustumCulled = false; return mesh;
}
const PAL = [[1.0, 0.90, 0.93], [1.0, 0.80, 0.87], [0.99, 0.70, 0.81], [1.0, 0.95, 0.96]];
{
  // petals already resting on the island and floating on the water
  const rnd = mulberry32(1234), N = 1500;
  const mesh = makePetalMesh(N);
  const tint = new Float32Array(N * 3), oc = new Float32Array(N * 2);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S = V3(1, 1, 1), P = V3(0, 0, 0);
  for (let i = 0; i < N; i++) {
    let x, z;
    if (i < 950) { x = TREE.x + 0.6 + gauss(rnd) * 3.4; z = 0.4 + gauss(rnd) * 3.0; }
    else if (i < 1300) { x = TREE.x + 2.0 + gauss(rnd) * 7; z = 6 + gauss(rnd) * 5; }
    else { x = (rnd() * 2 - 1) * 13; z = 4 + rnd() * 15; }
    const hy = islandH(x, z), onLand = hy > 0.0;
    P.set(x, onLand ? hy + 0.012 : 0.006, z);
    E.set(-Math.PI / 2 + (onLand ? gauss(rnd) * 0.35 : gauss(rnd) * 0.05), 0, rnd() * 6.283, 'YXZ'); E.y = rnd() * 6.283;
    Q.setFromEuler(E);
    const s = 0.055 + rnd() * 0.035; S.set(s, s * 1.15, s);
    M.compose(P, Q, S); mesh.setMatrixAt(i, M);
    const c = PAL[Math.floor(rnd() * 4)]; tint.set(c, i * 3); oc.set([1, 1], i * 2);
  }
  mesh.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
  mesh.geometry.setAttribute('aOcc', new THREE.InstancedBufferAttribute(oc, 2));
  mesh.geometry.setAttribute('aCN', new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3));
  scene.add(mesh);
}

const fall = [];
const ripples = [];   // {x, z, t0, amp}
{
  const rnd = mulberry32(777), rnd2 = mulberry32(31337);
  const R = (a, b) => a + rnd() * (b - a);
  const add = (p0, v, opt = {}) => {
    const o = {
      p0, v, t0: opt.t0 || 0,
      amp: opt.amp ?? R(0.10, 0.32), fq: R(1.3, 2.8), ph: R(0, 6.283), ph2: R(0, 6.283),
      axis: V3(R(-1, 1), R(-0.4, 0.4), R(-1, 1)).normalize(), spin: R(1.6, 4.2) * (rnd() < 0.5 ? -1 : 1),
      q0: new THREE.Quaternion().setFromEuler(new THREE.Euler(R(0, 6.283), R(0, 6.283), R(0, 6.283))),
      yaw: R(0, 6.283), s: opt.s ?? R(0.050, 0.085), tint: PAL[Math.floor(rnd() * 4)],
      rest: 1.5 + rnd2() * 5.5, rippled: false, hero: false,
    };
    o.tLand = o.t0 + (p0.y - 0.006) / -v.y;
    fall.push(o); return o;
  };
  // drifting through the air around and beneath the canopy
  for (let i = 0; i < 210; i++) add(V3(TREE.x + R(-5.5, 7.0), R(0.25, 5.8), R(-4.5, 5.5)), V3(R(0.10, 0.42), -R(0.32, 0.72), R(0.02, 0.26)));
  // sparse, between the tree and the lens — these give the shot its depth
  for (let i = 0; i < 46; i++) add(V3(R(-9, 9), R(0.3, 5.5), R(5.5, 16.0)), V3(R(0.12, 0.45), -R(0.30, 0.62), R(0.02, 0.22)));
  // let go by the breeze as the light arrives
  for (let i = 0; i < 130; i++) {
    const f = flowerList[Math.floor(rnd() * flowerList.length)];
    const t0 = rnd() < 0.3 ? R(0.0, 1.8) : R(1.9, 4.6);
    add(V3(f.x * TS + TREE.x, f.y * TS + TREE.y, f.z * TS + TREE.z), V3(R(0.25, 0.75), -R(0.30, 0.65), R(0.05, 0.35)), { t0 });
  }
  // hero petals that touch the water in front of the lens
  const hero = (x, z, t, v) => { const o = add(V3(x - v.x * t, 0.006 - v.y * t, z - v.z * t), v, { amp: 0.16, s: 0.085 }); o.tLand = t; o.hero = true; return o; };
  hero(1.9, 13.2, 1.25, V3(0.30, -0.52, 0.10));
  hero(-3.4, 10.4, 2.55, V3(0.36, -0.46, 0.14));
  hero(4.6, 8.6, 3.55, V3(0.26, -0.50, 0.08));
  hero(-0.4, 16.2, 3.9, V3(0.30, -0.44, 0.06));
  ripples.push({ x: -1.1, z: 15.0, t0: -1.1, amp: 0.8 }, { x: 5.4, z: 12.0, t0: -0.4, amp: 0.8 });
}
const tmpV = V3(0, 0, 0);
function petalPos(o, t, out) {
  const tt = Math.min(t, o.tLand) - o.t0;
  const fade = Math.min(1, Math.max(0, (o.tLand - Math.min(t, o.tLand)) / 0.7));
  out.set(
    o.p0.x + o.v.x * tt + o.amp * Math.sin(o.fq * tt + o.ph) * fade + o.amp * (1 - fade) * Math.sin(o.fq * (o.tLand - o.t0 - 0.7) + o.ph) * 0,
    Math.max(0.006, o.p0.y + o.v.y * tt + 0.05 * Math.sin(o.fq * 2 * tt + o.ph2) * fade),
    o.p0.z + o.v.z * tt + o.amp * 0.7 * Math.cos(o.fq * 0.8 * tt + o.ph2) * fade);
  return out;
}
const fallInit = fall.map(o => ({ ...o, p0: o.p0.clone(), v: o.v.clone() }));
function resetPetals() { fall.forEach((o, i) => { const a = fallInit[i]; Object.assign(o, a, { p0: o.p0.copy(a.p0), v: o.v.copy(a.v) }); }); }
let ripI = 0, lastRip = -10;
function addRipple(x, z, t0, amp) { water.material.uniforms.uRip.value[ripI % NRIP].set(x, z, t0, amp); ripI++; }
function resetRipples() { for (const v of water.material.uniforms.uRip.value) v.set(0, 0, 0, 0); ripI = 0; lastRip = -10; for (const r of ripples) addRipple(r.x, r.z, r.t0, r.amp); }
const rr = mulberry32(4242), RR = (a, b) => a + rr() * (b - a);
function respawn(o, t) {
  if (rr() < 0.72) {            // let go from a blossom
    const f = flowerList[Math.floor(rr() * flowerList.length)];
    o.p0.set(f.x * TS + TREE.x, f.y * TS + TREE.y, f.z * TS + TREE.z);
    o.v.set(RR(0.22, 0.70), -RR(0.30, 0.62), RR(0.04, 0.32));
  } else {                      // carried in on the breeze from beyond the left edge
    const z = RR(-3, 11), halfW = (camera.position.z - z) * Math.tan(camera.fov * D2R / 2) * camera.aspect;
    o.p0.set(camera.position.x - halfW - RR(0.4, 2.5), RR(1.0, 6.5), z);
    o.v.set(RR(0.30, 0.75), -RR(0.28, 0.55), RR(0.0, 0.16));
  }
  o.t0 = t + RR(0.0, 2.5); o.amp = RR(0.10, 0.30);
  o.tLand = o.t0 + (o.p0.y - 0.006) / -o.v.y;
  o.rest = RR(3, 8); o.rippled = false; o.hero = false;
}
const fallMesh = makePetalMesh(fall.length);
{
  const N = fall.length, tint = new Float32Array(N * 3), oc = new Float32Array(N * 2);
  fall.forEach((o, i) => { tint.set(o.tint, i * 3); oc.set([0.62, 1], i * 2); });
  fallMesh.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
  fallMesh.geometry.setAttribute('aOcc', new THREE.InstancedBufferAttribute(oc, 2));
  fallMesh.geometry.setAttribute('aCN', new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3));
  fallMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(fallMesh);
}
const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _Q2 = new THREE.Quaternion(), _S = V3(1, 1, 1), _P = V3(0, 0, 0);
const FLATQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
function updatePetals(t) {
  for (let i = 0; i < fall.length; i++) {
    const o = fall[i];
    if (t > o.tLand + o.rest) respawn(o, t);
    if (!o.rippled && t >= o.tLand) {
      o.rippled = true; petalPos(o, o.tLand, _P);
      const near = _P.z > 3.5 && Math.hypot(_P.x - camera.position.x, _P.z - camera.position.z) < 15 && islandH(_P.x, _P.z) < 0;
      if (near && (o.hero || o.tLand - lastRip > 0.85)) { addRipple(_P.x, _P.z, o.tLand, o.hero ? 1.0 : 0.75); if (!o.hero) lastRip = o.tLand; }
    }
    petalPos(o, t, _P);
    const tt = Math.min(t, o.tLand) - o.t0;
    _Q.setFromAxisAngle(o.axis, o.spin * tt).multiply(o.q0);
    const settle = sstep(o.tLand - 0.35, o.tLand, t);
    if (settle > 0) { _Q2.setFromAxisAngle(V3(0, 1, 0), o.yaw).multiply(FLATQ); _Q.slerp(_Q2, settle); }
    const born = sstep(o.t0, o.t0 + 0.25, t);
    const s = o.s * born * (1 - sstep(o.tLand + o.rest - 1.5, o.tLand + o.rest, t)) * sstep(3.2, 6.0, _P.distanceTo(camera.position)); _S.set(s, s * 1.15, s);
    _M.compose(_P, _Q, _S); fallMesh.setMatrixAt(i, _M);
  }
  fallMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- water
function makeNormalMap(size = 256) {
  const r = mulberry32(2024), K = 56, waves = [];
  for (let i = 0; i < K; i++) {
    let kx, ky; do { kx = Math.round((r() * 2 - 1) * 14); ky = Math.round((r() * 2 - 1) * 14); } while (kx === 0 && ky === 0);
    const k = Math.hypot(kx, ky); waves.push({ kx, ky, a: Math.pow(k, -1.35), ph: r() * 6.283 });
  }
  const sx = new Float32Array(size * size), sy = new Float32Array(size * size); let mx = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let dx = 0, dy = 0; const u = x / size, v = y / size;
    for (const w of waves) { const s = -Math.sin(6.2831853 * (w.kx * u + w.ky * v) + w.ph) * w.a; dx += s * w.kx; dy += s * w.ky; }
    sx[y * size + x] = dx; sy[y * size + x] = dy; mx = Math.max(mx, Math.abs(dx), Math.abs(dy));
  }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { data[i*4] = 127.5 + 127.5 * sx[i] / mx; data[i*4+1] = 127.5 + 127.5 * sy[i] / mx; data[i*4+2] = 255; data[i*4+3] = 255; }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true; tex.needsUpdate = true;
  return tex;
}
const NRIP = 12;
const waterShader = {
  name: 'LakeShader',
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    tNormal: { value: null }, uRip: { value: [] }, uDeep: { value: V3(0.004, 0.008, 0.022) },
    uTime: { value: 0 }, uSunDir: { value: V3() }, uSunVis: { value: 0 }, uDawn: { value: 0 }, uSunCol: { value: V3() },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix; varying vec4 vUvP; varying vec3 vWorld;
    void main(){ vUvP = textureMatrix * vec4(position, 1.0); vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: SKY_GLSL + /* glsl */`
    uniform sampler2D tDiffuse, tNormal; uniform vec4 uRip[${NRIP}]; uniform vec3 uDeep, uSunCol;
    varying vec4 vUvP; varying vec3 vWorld;
    void main(){
      vec3 toCam = cameraPosition - vWorld; float dist = length(toCam); vec3 V = toCam / dist;
      vec2 p = vWorld.xz;
      vec2 n = vec2(0.0);
      n += (texture2D(tNormal, p*0.031 + uTime*vec2(0.0035, 0.0050)).xy*2.0 - 1.0) * 1.00;
      n += (texture2D(tNormal, p*0.110 + uTime*vec2(-0.010, 0.008)).xy*2.0 - 1.0) * 0.55;
      vec2 nf = (texture2D(tNormal, p*0.47 + uTime*vec2(0.026, -0.018)).xy*2.0 - 1.0);
      n += nf * 0.22;
      vec2 rp = vec2(0.0);
      for (int i = 0; i < ${NRIP}; i++) {
        vec4 R = uRip[i]; float tau = uTime - R.z;
        if (tau > 0.0 && R.w > 0.0) {
          vec2 dv = p - R.xy; float r = length(dv) + 1e-4;
          float x = r - (0.50*tau + 0.03);
          float wd = 0.13 + 0.11*tau;
          float env = exp(-x*x/(wd*wd)) * exp(-tau*0.36) * R.w * smoothstep(0.0, 0.12, tau);
          float k = 30.0 / (1.0 + 0.30*tau);
          rp += (dv / r) * env * cos(k*x);
        }
      }
      vec2 ns = n + rp * 3.4;
      vec3 N = normalize(vec3(-ns.x*0.012, 1.0, -ns.y*0.012));

      vec2 uv = vUvP.xy / vUvP.w;
      float edge = smoothstep(0.0, 0.07, uv.y) * (1.0 - smoothstep(0.93, 1.0, uv.y)) * smoothstep(0.0, 0.04, uv.x) * (1.0 - smoothstep(0.96, 1.0, uv.x));
      uv += vec2(ns.x * 0.30, ns.y) * 0.0085 * edge;
      uv = clamp(uv, 0.001, 0.999);
      vec3 refl = texture2D(tDiffuse, uv).rgb;

      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, N), 0.0), 5.0);
      fres = mix(0.50, 1.0, fres);
      vec3 col = mix(uDeep, refl, fres);

      // sun glitter
      vec2 ng = n * 0.6 + nf * 1.6 + rp * 3.0;
      vec3 Ng = normalize(vec3(-ng.x*0.030, 1.0, -ng.y*0.030));
      vec3 Hh = normalize(V + uSunDir);
      float sp = pow(max(dot(Ng, Hh), 0.0), 2600.0);
      col += uSunCol * sp * uSunVis * 10.0;

      // far water dissolves into the dawn haze
      vec3 d = -V;
      vec3 hz = skyGlow(normalize(vec3(d.x, 0.014, d.z)));
      float mu = dot(normalize(vec3(d.x, uSunDir.y, d.z)), uSunDir);
      hz += vec3(1.0, 0.42, 0.10) * 0.22 * exp((mu - 1.0) * 90.0) * (0.3 + 0.25*uDawn + 0.6*uSunVis);
      float fog = 1.0 - exp(-pow(dist / 430.0, 1.5));
      col = mix(col, hz * 0.90, fog * 0.85);
      gl_FragColor = vec4(col, 1.0);
    }`,
};
const water = new Reflector(new THREE.PlaneGeometry(9000, 9000, 150, 150), { textureWidth: W, textureHeight: H, clipBias: 0.002, shader: waterShader, multisample: 0 });
water.rotation.x = -Math.PI / 2; water.frustumCulled = false;
{
  const u = water.material.uniforms;
  u.tNormal.value = makeNormalMap();
  for (const k of ['uTime', 'uSunDir', 'uSunVis', 'uDawn', 'uSunCol']) u[k] = G[k];
  const arr = []; for (let i = 0; i < NRIP; i++) { const r = ripples[i]; arr.push(r ? new THREE.Vector4(r.x, r.z, r.t0, r.amp) : new THREE.Vector4(0, 0, 0, 0)); }
  u.uRip.value = arr; ripI = ripples.length;
}
scene.add(water);

// ---------------------------------------------------------------- post
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(1); composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera));
// light shafts: a half-resolution radial blur of the brightest sky, pulled toward the sun
class RaysPass extends Pass {
  constructor(w, h) {
    super();
    this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(w >> 1, h >> 1, { type: THREE.HalfFloatType });
    this.uniforms = { tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uAmt: { value: 0 }, uAspect: { value: w / h }, uT: { value: 0 } };
    this.rays = new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uAmt, uAspect, uT; varying vec2 vUv;
        float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main(){
          const int N = 44;
          vec2 delta = (uSun - vUv) * 0.94 / float(N);
          vec2 uv = vUv + delta * h(gl_FragCoord.xy + fract(uT * 5.37) * vec2(193.0, 317.0));
          vec3 acc = vec3(0.0); float w = 1.0, ws = 0.0;
          for (int i = 0; i < N; i++) {
            vec3 s = texture2D(tDiffuse, uv).rgb;
            float l = max(s.r, max(s.g, s.b));
            acc += min(s, vec3(10.0)) * smoothstep(2.2, 6.0, l) * w; ws += w; w *= 0.972; uv += delta;
          }
          acc /= ws;
          float dS = length((uSun - vUv) * vec2(uAspect, 1.0));
          gl_FragColor = vec4(acc * uAmt * exp(-dS * 1.5), 1.0);
        }`,
    });
    this.add = new THREE.ShaderMaterial({
      uniforms: { tRays: { value: this.rt.texture } }, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.AdditiveBlending,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `uniform sampler2D tRays; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(tRays, vUv).rgb, 1.0); }`,
    });
    this.quad = new FullScreenQuad(this.rays);
  }
  setSize(w, h) { this.rt.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); this.uniforms.uAspect.value = w / h; }
  render(renderer, writeBuffer, readBuffer) {
    if (this.uniforms.uAmt.value <= 0.001) return;
    const ac = renderer.autoClear; renderer.autoClear = false;
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.rays; renderer.setRenderTarget(this.rt); renderer.clear(); this.quad.render(renderer);
    this.quad.material = this.add; renderer.setRenderTarget(readBuffer); this.quad.render(renderer);
    renderer.autoClear = ac;
  }
}
const raysPass = new RaysPass(W, H);
composer.addPass(raysPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.4, 0.72, 0.95);
composer.addPass(bloom);
const finalPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uExposure: { value: 1.0 }, uTime: { value: 0 }, uFade: { value: 1 } },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uExposure, uTime, uFade; varying vec2 vUv;
    float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec3 aces(vec3 x){ return clamp((x*(2.51*x + 0.03)) / (x*(2.43*x + 0.59) + 0.14), 0.0, 1.0); }
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb * uExposure;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 1.12);
      c = aces(max(c, 0.0));
      c = pow(c, vec3(1.0/2.2));
      vec2 q = vUv - 0.5; q.x *= 1.25;
      c *= 1.0 - 0.42 * smoothstep(0.32, 0.95, length(q));
      float g = h(gl_FragCoord.xy + fract(uTime*7.13) * vec2(417.0, 263.0)) + h(gl_FragCoord.yx + fract(uTime*3.71) * vec2(151.0, 337.0)) - 1.0;
      c += g * 0.018;
      gl_FragColor = vec4(c * uFade, 1.0);
    }`,
});
composer.addPass(finalPass);

// ---------------------------------------------------------------- timeline
const LOOK = V3(-0.65, 2.15, 0);
const RAYS = 0.42;
const par = { x: 0, y: 0, tx: 0, ty: 0 };     // pointer parallax, eased
function setTime(t) {
  const k5 = t / DURATION, after = Math.max(0, t - DURATION);
  // the film's five seconds, then the sun and the lens ease to rest instead of stopping dead
  const kSun = t <= DURATION ? k5 : 1 + 0.25 * (1 - Math.exp(-after / 1.25));
  const kCam = t <= DURATION ? k5 : 1 + 0.30 * (1 - Math.exp(-after / 1.5));
  const e = -0.26 + 0.92 * kSun;                          // sun elevation, degrees
  G.uSunDir.value.set(Math.sin(SUN_AZ) * Math.cos(e * D2R), Math.sin(e * D2R), -Math.cos(SUN_AZ) * Math.cos(e * D2R));
  const vis = Math.min(1, Math.max(0, (e + SUN_R - SADDLE) / (2 * SUN_R)));
  G.uSunVis.value = Math.pow(vis, 0.8);
  G.uDawn.value = sstep(0, 1, Math.min(k5, 1)) * 0.55 + 0.45 * Math.pow(vis, 0.6);
  G.uTime.value = t;
  LIGHT_UNI.uGust.value = t <= DURATION ? sstep(2.0, 3.4, t) * (1 - 0.35 * sstep(4.2, 5.0, t)) : 0.65 + 0.22 * Math.sin(after * 0.5);
  finalPass.uniforms.uTime.value = t % 1000;
  finalPass.uniforms.uExposure.value = 1.05 - 0.12 * G.uSunVis.value;
  finalPass.uniforms.uFade.value = sstep(0, 0.7, t);
  bloom.strength = 0.36 + 0.06 * G.uSunVis.value;
  const idle = sstep(DURATION, DURATION + 4, t);
  camera.position.set(
    CAM0.x + 0.45 * kCam + idle * 0.16 * Math.sin(after * 0.21) + par.x * 1.0,
    Math.max(0.55, CAM0.y + 0.15 * kCam + idle * 0.045 * Math.sin(after * 0.29) - par.y * 0.28),
    CAM0.z - 2.0 * kCam);
  camera.lookAt(LOOK.x + 0.15 * kCam, LOOK.y, LOOK.z);
  camera.updateMatrixWorld();
  const sp = camera.position.clone().addScaledVector(G.uSunDir.value, 1000).project(camera);
  raysPass.uniforms.uSun.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
  raysPass.uniforms.uAmt.value = RAYS * Math.pow(G.uSunVis.value, 0.7);
  raysPass.uniforms.uT.value = t % 1000;
  updatePetals(t);
}

// ---------------------------------------------------------------- runtime
function setResolution(w, h) {
  W = w; H = h;
  renderer.setSize(W, H, false);
  composer.setSize(W, H);
  water.getRenderTarget().setSize(W, H);
  fitCamera();
}
fitCamera();
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let T = REDUCED ? 4.3 : 0, paused = REDUCED, dirty = true, last = 0;
function applySize() { const [w, h] = pickSize(); if (w !== W || h !== H) { setResolution(w, h); dirty = true; } }
function replay() { T = 0; resetPetals(); resetRipples(); paused = false; dirty = true; syncUI(); }
function togglePause() { paused = !paused; syncUI(); }

const $ = (id) => document.getElementById(id);
const btnPause = $('pause'), btnReplay = $('replay'), btnFull = $('full');
function syncUI() { if (btnPause) { btnPause.textContent = paused ? '继续' : '暂停'; btnPause.setAttribute('aria-pressed', String(paused)); } }
let idleTimer = 0;
function wake() { document.body.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => document.body.classList.add('idle'), 4500); }

if (!TEST) {
  btnReplay && btnReplay.addEventListener('click', replay);
  btnPause && btnPause.addEventListener('click', togglePause);
  if (btnFull) {
    if (!document.fullscreenEnabled) btnFull.hidden = true;
    btnFull.addEventListener('click', () => {
      const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(() => { btnFull.hidden = true; });
    });
    document.addEventListener('fullscreenchange', () => { btnFull.textContent = document.fullscreenElement ? '退出全屏' : '全屏'; });
  }
  window.addEventListener('keydown', (ev) => {
    if (ev.target instanceof HTMLButtonElement && (ev.key === ' ' || ev.key === 'Enter')) return;
    if (ev.key === ' ' || ev.key === 'k') { ev.preventDefault(); togglePause(); }
    else if (ev.key === 'r' || ev.key === 'R') replay();
    wake();
  });
  const setPar = (ev) => { const r = stage.getBoundingClientRect(); par.tx = Math.max(-1, Math.min(1, (ev.clientX - r.left) / r.width * 2 - 1)); par.ty = Math.max(-1, Math.min(1, (ev.clientY - r.top) / r.height * 2 - 1)); };
  window.addEventListener('pointermove', (ev) => { setPar(ev); wake(); });
  window.addEventListener('pointerdown', (ev) => { setPar(ev); wake(); });
  const rest = (ev) => { if (ev.pointerType !== 'mouse' || ev.type === 'pointerleave') { par.tx = 0; par.ty = 0; } };
  window.addEventListener('pointerup', rest); window.addEventListener('pointercancel', rest);
  document.documentElement.addEventListener('pointerleave', rest);
  document.addEventListener('focusin', wake);
  let rz = 0; new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(applySize); }).observe(stage);

  // if frames are slow, trade resolution for smoothness (never the other way round)
  let mAcc = 0, mN = 0, mSkip = 3;
  const monitor = (dt) => {
    if (mSkip > 0) { mSkip--; return; }
    mAcc += dt; mN++;
    if (mN >= 45 || (mN >= 6 && mAcc >= 0.5)) {
      const avg = mAcc / mN; mAcc = 0; mN = 0;
      if (avg > 0.040 && qScale > 0.45) { qScale = Math.max(0.45, qScale * (avg > 0.08 ? 0.6 : 0.78)); mSkip = 3; applySize(); }
    }
  };
  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
    const ease = 1 - Math.exp(-dt * 3.2), px = par.x, py = par.y;
    par.x += (par.tx - par.x) * ease; par.y += (par.ty - par.y) * ease;
    if (Math.abs(par.x - px) + Math.abs(par.y - py) > 1e-4) dirty = true;
    if (!paused) { T += dt; dirty = true; }
    if (!dirty) return;
    dirty = false;
    setTime(T); composer.render();
    if (!paused) monitor(dt);
    if (!document.body.classList.contains('ready')) { document.body.classList.add('ready'); wake(); }
  };
  syncUI();
  requestAnimationFrame((now) => { last = now; frame(now); });
} else {
  // deterministic stepping for checks
  window.__t = {
    advance(sec, step = 1 / 30) { const n = Math.round(sec / step); for (let i = 0; i < n; i++) { T += step; setTime(T); } return T; },
    shot() { setTime(T); composer.render(); return renderer.domElement.toDataURL('image/jpeg', 0.9); },
    replay() { replay(); return T; },
    par(x, y) { par.x = par.tx = x; par.y = par.ty = y; },
    resize(w, h) { setResolution(w, h); },
    info() { return { T, W, H, fov: camera.fov, flowers: window.__flowers, falling: fall.length, airborne: fall.filter(o => T >= o.t0 && T < o.tLand).length, ripI, sunVis: G.uSunVis.value }; },
  };
  document.body.classList.add('ready');
}
