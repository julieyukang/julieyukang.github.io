import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ================================================================== *
 *  Final Battle: each project is a battle zone with its own boss,
 *  each agent is a hero fighting it.
 * ================================================================== */
const POLL_MS = 30000;          // how often data is re-fetched
const SEATS_PER_ROW = 4;
const WALK_SPEED = 2.1;
const APP_NAME = 'Final Battle';

const STATUS = {
  working:   { label: 'Fighting',     css: '#4ade80' },
  idle:      { label: 'Resting',      css: '#94a3b8' },
  needs_you: { label: 'Needs backup', css: '#fb4b6b' },
  error:     { label: 'Down',         css: '#f5a524' },
  done:      { label: 'Victory',      css: '#60a5fa' },
};
const ALERT_STATUSES = new Set(['needs_you', 'error']);

const params = new URLSearchParams(location.search);
const DATA_URL = params.get('data') || 'data.json';

const store = {
  get(k, d) { try { const v = localStorage.getItem('office.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('office.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
let handled = store.get('handled', {});      // `${agentId}@${updated}` -> true
let soundOn = store.get('sound', true);

/* ------------------------------------------------------------------ *
 *  Renderer, camera, lights, post-processing
 * ------------------------------------------------------------------ */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const DPR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(DPR);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#5d4067', 30, 90);

const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 300);
const CAM_DIR = new THREE.Vector3(1, 1.0, 1).normalize();
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minZoom = 0.6;
controls.maxZoom = 3.5;
controls.minPolarAngle = 0.5;
controls.maxPolarAngle = 1.15;
controls.screenSpacePanning = false;

const hemi = new THREE.HemisphereLight('#ffd8bd', '#2c2342', 1.25);
const sun = new THREE.DirectionalLight('#ffb48a', 2.8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
const rim = new THREE.DirectionalLight('#8a9bff', 1.3);    // cool back light for silhouettes
scene.add(hemi, sun, sun.target, rim);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.7, 0.55, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

let viewSize = 20;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setPixelRatio(DPR);
  composer.setSize(w, h);
  const a = w / h;
  const s = a < 1 ? viewSize / a * 0.8 : viewSize;
  camera.left = -s * a / 2; camera.right = s * a / 2;
  camera.top = s / 2; camera.bottom = -s / 2;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

/* ------------------------------------------------------------------ *
 *  Materials, geometry, textures
 * ------------------------------------------------------------------ */
const matCache = new Map();
function mat(color, rough = 0.82, metal = 0) {
  const key = `${color}|${rough}|${metal}`;
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
  return matCache.get(key);
}
const metal = color => mat(color, 0.35, 0.65);
/* Emissive "glow" material: colours above 1.0 feed the bloom pass */
function glow(color, strength = 2.5, opacity = 1) {
  const key = `g|${color}|${strength}|${opacity}`;
  if (!matCache.has(key)) {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(strength), fog: false });
    if (opacity < 1) Object.assign(m, { transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
    matCache.set(key, m);
  }
  return matCache.get(key);
}
const geoCache = new Map();
function boxGeo(w, h, d) {
  const key = `${w}|${h}|${d}`;
  if (!geoCache.has(key)) {
    const r = Math.min(Math.min(w, h, d) * 0.28, 0.07);
    geoCache.set(key, r > 0.008 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d));
  }
  return geoCache.get(key);
}
/* box(parent, w, h, d, colorOrMaterial, x, y, z, { cast }) */
function box(parent, w, h, d, c, x = 0, y = 0, z = 0, opts = {}) {
  const material = c && c.isMaterial ? c : mat(c);
  const m = new THREE.Mesh(boxGeo(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = opts.cast !== false && !material.isMeshBasicMaterial;
  m.receiveShadow = !material.isMeshBasicMaterial;
  parent.add(m);
  return m;
}
function shade(hex, amt) {
  const c = new THREE.Color(hex);
  const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amt)));
  return '#' + c.getHexString();
}
function hashStr(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
/* Soft mottled stone texture instead of a checkerboard */
function stoneTexture(base, seed, repeat) {
  const size = 128, c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), r = seeded(seed);
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const v = r() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${0.02 + r() * 0.05})`;
    const s = 1 + r() * 6;
    g.fillRect(r() * size, r() * size, s, s);
  }
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    g.beginPath(); let x = r() * size, y = r() * size; g.moveTo(x, y);
    for (let k = 0; k < 4; k++) { x += (r() - 0.5) * 30; y += (r() - 0.5) * 30; g.lineTo(x, y); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function skyTexture() {
  const c = document.createElement('canvas'); c.width = 2; c.height = 512;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, '#120e26');
  grd.addColorStop(0.45, '#3b2a58');
  grd.addColorStop(0.75, '#8a4d6e');
  grd.addColorStop(1, '#e89870');
  g.fillStyle = grd; g.fillRect(0, 0, 2, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function dotTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,.6)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/* ------------------------------------------------------------------ *
 *  Characters
 * ------------------------------------------------------------------ */
const SKIN = ['#f3cfb0', '#deaa83', '#c4895f', '#8c5a3c', '#fbe0c6'];
const HAIR = ['#2a1d16', '#563824', '#c99a46', '#1b1a1f', '#93462b', '#5a4fb0', '#c2577f'];

function makeCharacter(seed, shirt) {
  const g = new THREE.Group();
  g.rotation.order = 'YXZ';
  const skin = SKIN[seed % SKIN.length];
  const hair = HAIR[(seed >>> 3) % HAIR.length];
  const pants = '#2e2a40';

  const legL = new THREE.Group(); legL.position.set(-0.11, 0.45, 0); g.add(legL);
  const legR = new THREE.Group(); legR.position.set(0.11, 0.45, 0); g.add(legR);
  for (const leg of [legL, legR]) {
    box(leg, 0.18, 0.45, 0.2, pants, 0, -0.225, 0);
    box(leg, 0.2, 0.09, 0.27, '#1d1a26', 0, -0.42, 0.03);
  }
  box(g, 0.5, 0.55, 0.3, shirt, 0, 0.725, 0);
  box(g, 0.52, 0.07, 0.32, '#3a2c22', 0, 0.48, 0);                 // belt
  box(g, 0.1, 0.08, 0.04, metal('#d9b45a'), 0, 0.48, 0.16);         // buckle

  const armL = new THREE.Group(); armL.position.set(-0.33, 0.95, 0); g.add(armL);
  const armR = new THREE.Group(); armR.position.set(0.33, 0.95, 0); g.add(armR);
  for (const arm of [armL, armR]) {
    box(arm, 0.14, 0.42, 0.16, shirt, 0, -0.19, 0);
    box(arm, 0.13, 0.1, 0.15, skin, 0, -0.44, 0);
  }
  const head = new THREE.Group(); head.position.set(0, 1.0, 0); g.add(head);
  box(head, 0.5, 0.48, 0.48, skin, 0, 0.25, 0);
  box(head, 0.54, 0.16, 0.52, hair, 0, 0.53, -0.01);
  box(head, 0.54, 0.3, 0.12, hair, 0, 0.36, -0.22);
  box(head, 0.07, 0.09, 0.02, '#16141c', -0.11, 0.26, 0.245, { cast: false });
  box(head, 0.07, 0.09, 0.02, '#16141c', 0.11, 0.26, 0.245, { cast: false });

  g.userData.parts = { legL, legR, armL, armR, head };
  return g;
}

/* ------------------------------------------------------------------ *
 *  World state
 * ------------------------------------------------------------------ */
const TERRAINS = [
  { name: 'Lava Fields',   ground: '#4b3a3c', edge: '#2c2224', boss: '#7d3427', eye: '#ffc34a', decor: 'lava' },
  { name: 'Frost Peaks',   ground: '#c9dbe8', edge: '#7b97ad', boss: '#476f99', eye: '#9ef0ff', decor: 'ice' },
  { name: 'Ancient Ruins', ground: '#a99d8a', edge: '#6f6555', boss: '#5c5570', eye: '#c39bff', decor: 'ruins' },
  { name: 'Wild Forest',   ground: '#6d9a5c', edge: '#466b3a', boss: '#36502a', eye: '#e2ff5a', decor: 'forest' },
  { name: 'Dune Sea',      ground: '#d4b67c', edge: '#a3824f', boss: '#8c5530', eye: '#ff7a45', decor: 'desert' },
];

let world = null;
let embers = null;
let layoutKey = '';
const agents = new Map();
let pods = [];
let owner = null;
let data = null;
let projectiles = [];
let fire = null;
const campSpot = new THREE.Vector3();
let hoveredId = null;

function layout(projects) {
  const maxSeats = Math.max(2, ...projects.map(p => Math.min(SEATS_PER_ROW, (p.agents || []).length)));
  const maxRows = Math.max(1, ...projects.map(p => Math.ceil(((p.agents || []).length || 1) / SEATS_PER_ROW)));
  const cellW = Math.max(maxSeats * 1.5 + 2.6, 6);
  const cellD = 4.6 + maxRows * 1.7;
  const gap = 1.6;
  const cols = Math.max(1, Math.ceil(Math.sqrt(projects.length)));
  const rows = Math.max(1, Math.ceil(projects.length / cols));
  const W = cols * (cellW + gap) + gap;
  const D = rows * (cellD + gap) + gap + 5.5;
  return { cellW, cellD, gap, cols, rows, W, D };
}

function buildWorld(d) {
  if (world) scene.remove(world);
  if (embers) scene.remove(embers);
  world = new THREE.Group();
  scene.add(world);
  agents.clear();
  pods = []; projectiles = [];
  document.getElementById('labels').innerHTML = '';

  const projects = d.projects || [];
  const L = layout(projects);
  const { W, D } = L;
  const x0 = -W / 2, z0 = -D / 2;
  const rand = seeded(1234);
  scene.background = skyTexture();

  // Ground
  const groundMat = new THREE.MeshStandardMaterial({ map: stoneTexture('#4a3e4c', 7, [(W + 8) / 4, (D + 8) / 4]), roughness: 0.95 });
  const ground = new THREE.Mesh(new THREE.BoxGeometry(W + 8, 0.6, D + 8), [mat('#2b2230'), mat('#2b2230'), groundMat, mat('#2b2230'), mat('#2b2230'), mat('#2b2230')]);
  ground.position.y = -0.3;
  ground.receiveShadow = true;
  world.add(ground);

  // Ruined skyline in the haze
  const greys = ['#3f3450', '#372d47', '#45395a', '#30283e'];
  const ruin = (x, z, along) => {
    const h = 1.6 + rand() * 4.2, w = 1.0 + rand() * 0.9;
    const c = greys[Math.floor(rand() * greys.length)];
    const b = new THREE.Group(); b.position.set(x, 0, z); world.add(b);
    const [bw, bd] = along === 'x' ? [w, 1.3] : [1.3, w];
    box(b, bw, h, bd, c, 0, h / 2, 0);
    box(b, bw * 0.5, 0.5 + rand() * 0.9, bd * 0.6, c, (rand() - 0.5) * 0.3, h + 0.3, 0);
    for (let wy = 0.9; wy < h - 0.4; wy += 1.0) {
      if (rand() > 0.22) continue;
      const wm = glow('#ffb35a', 1.6);
      if (along === 'x') box(b, 0.16, 0.24, 0.03, wm, (rand() - 0.5) * (bw - 0.4), wy, bd / 2 + 0.01);
      else box(b, 0.03, 0.24, 0.16, wm, bw / 2 + 0.01, wy, (rand() - 0.5) * (bd - 0.4));
    }
  };
  for (let x = x0 - 3; x < W / 2 + 4; x += 1.4 + rand() * 0.7) ruin(x, z0 - 3, 'x');
  for (let z = z0 - 1.5; z < D / 2 + 3; z += 1.4 + rand() * 0.7) ruin(x0 - 3, z, 'z');

  // A few rocks and smouldering craters
  for (let i = 0; i < 14; i++) {
    const x = x0 + rand() * W, z = z0 + rand() * D;
    if (rand() < 0.6) {
      const r = box(world, 0.3 + rand() * 0.35, 0.18 + rand() * 0.25, 0.3 + rand() * 0.35, '#3d3340', x, 0.1, z);
      r.rotation.y = rand() * Math.PI;
    } else {
      box(world, 1.0, 0.03, 1.0, '#2e2530', x, 0.015, z, { cast: false });
      box(world, 0.3, 0.035, 0.3, glow('#ff6a2a', 1.4), x, 0.02, z);
    }
  }

  projects.forEach((p, i) => {
    const col = i % L.cols, row = Math.floor(i / L.cols);
    const cx = x0 + L.gap + col * (L.cellW + L.gap) + L.cellW / 2;
    const czTop = z0 + L.gap + row * (L.cellD + L.gap);
    buildZone(p, i, cx, czTop, L);
  });

  const frontZ = D / 2 - 2.7;
  buildCamp(x0 + 3, frontZ);
  buildCommand(d.owner || {}, Math.min(2, W / 2 - 3), frontZ + 0.3);
  buildEmbers(W, D);

  // Lights, fog and camera framing scale with the world
  const span = Math.max(W, D);
  sun.position.set(-span * 0.55, span * 1.0, span * 0.35);
  sun.target.position.set(0, 0, 0);
  rim.position.set(span * 0.3, span * 0.5, -span);
  const sc = sun.shadow.camera;
  sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 0.5; sc.far = span * 4;
  sc.updateProjectionMatrix();

  const dist = span * 2;
  scene.fog.near = dist - span * 0.15;
  scene.fog.far = dist + span * 1.5;
  viewSize = span * 0.92;
  world.userData.home = { target: new THREE.Vector3(-1.2, 0, -1.6), dist };
  resetView();
  resize();
}

function buildEmbers(W, D) {
  const n = 240, pos = new Float32Array(n * 3), speed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * (W + 8);
    pos[i * 3 + 1] = Math.random() * 9;
    pos[i * 3 + 2] = (Math.random() - 0.5) * (D + 8);
    speed[i] = 0.25 + Math.random() * 0.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    size: 3.2 * DPR, sizeAttenuation: false, map: dotTexture(), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false, color: new THREE.Color('#ffa060').multiplyScalar(2.2),
  });
  embers = new THREE.Points(geo, m);
  embers.userData = { speed, W, D };
  scene.add(embers);
}

function zoneDecor(g, T, cx, czTop, zw, zd, rand) {
  const y = 0.32;
  const spots = [
    [cx - zw / 2 + 0.6, czTop + 0.6], [cx + zw / 2 - 0.6, czTop + 0.6],
    [cx - zw / 2 + 0.55, czTop + 2.4], [cx + zw / 2 - 0.55, czTop + 2.4],
  ];
  for (const [x, z] of spots) {
    if (T.decor === 'lava') {
      box(g, 0.5, 0.42, 0.5, '#2e2426', x, y + 0.21, z).rotation.y = rand();
      box(g, 0.9 + rand() * 0.6, 0.02, 0.07, glow('#ff6a1a', 2.6), x + (rand() - 0.5), y + 0.01, z + 0.5).rotation.y = rand() * Math.PI;
    } else if (T.decor === 'ice') {
      for (let k = 0; k < 3; k++) {
        const h = 0.5 + rand() * 1.0;
        const s = box(g, 0.2, h, 0.2, mat('#bfeaff', 0.25, 0.1), x + (rand() - 0.5) * 0.5, y + h / 2, z + (rand() - 0.5) * 0.5);
        s.rotation.z = (rand() - 0.5) * 0.5;
      }
    } else if (T.decor === 'ruins') {
      const h = 0.6 + rand() * 1.3;
      box(g, 0.42, h, 0.42, '#d6cdbb', x, y + h / 2, z);
      box(g, 0.58, 0.14, 0.58, '#c8bea9', x, y + h + 0.07, z);
    } else if (T.decor === 'forest') {
      box(g, 0.18, 0.6, 0.18, '#6b4a33', x, y + 0.3, z);
      box(g, 0.85, 0.75, 0.85, '#3b7d43', x, y + 0.95, z);
      box(g, 0.5, 0.45, 0.5, '#4f9a55', x + 0.05, y + 1.5, z);
    } else {
      box(g, 0.24, 1.0, 0.24, '#4d8a48', x, y + 0.5, z);
      box(g, 0.36, 0.15, 0.15, '#4d8a48', x + 0.17, y + 0.55, z);
      box(g, 0.15, 0.34, 0.15, '#4d8a48', x + 0.28, y + 0.75, z);
    }
  }
  if (T.decor === 'lava') {
    for (let k = 0; k < 3; k++) {
      box(g, 0.8, 0.02, 0.06, glow('#ff7a2a', 2.2), cx + (rand() - 0.5) * (zw - 1.5), y + 0.01, czTop + 3.3 + rand() * (zd - 4))
        .rotation.y = rand() * 3;
    }
  }
}

function makeBoss(T, seed) {
  const g = new THREE.Group();
  const c = T.boss, dark = shade(c, -0.08), light = shade(c, 0.1);
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(T.eye).multiplyScalar(3), fog: false });
  box(g, 0.5, 0.8, 0.55, dark, -0.42, 0.4, 0);
  box(g, 0.5, 0.8, 0.55, dark, 0.42, 0.4, 0);
  const torso = new THREE.Group(); torso.position.y = 0.8; g.add(torso);
  box(torso, 1.6, 1.25, 1.05, c, 0, 0.62, 0);
  box(torso, 0.9, 0.6, 0.06, light, 0, 0.6, 0.54);
  box(torso, 0.3, 0.3, 0.07, eyeMat, 0, 0.62, 0.57);
  const armL = new THREE.Group(); armL.position.set(-1.0, 1.1, 0); torso.add(armL);
  const armR = new THREE.Group(); armR.position.set(1.0, 1.1, 0); torso.add(armR);
  for (const arm of [armL, armR]) {
    box(arm, 0.45, 1.0, 0.5, dark, 0, -0.45, 0);
    box(arm, 0.6, 0.5, 0.6, light, 0, -1.1, 0);
  }
  const head = new THREE.Group(); head.position.set(0, 1.25, 0.05); torso.add(head);
  box(head, 0.95, 0.72, 0.85, c, 0, 0.36, 0);
  box(head, 0.2, 0.09, 0.04, eyeMat, -0.22, 0.42, 0.44);
  box(head, 0.2, 0.09, 0.04, eyeMat, 0.22, 0.42, 0.44);
  box(head, 0.5, 0.07, 0.04, '#18141f', 0, 0.16, 0.44, { cast: false });
  if (seed % 2) {
    box(head, 0.13, 0.45, 0.13, '#ece2c8', -0.38, 0.85, 0).rotation.z = 0.4;
    box(head, 0.13, 0.45, 0.13, '#ece2c8', 0.38, 0.85, 0).rotation.z = -0.4;
  } else {
    for (let k = -1; k <= 1; k++) box(torso, 0.2, 0.45, 0.2, light, k * 0.45, 1.35, -0.4).rotation.x = -0.3;
  }
  g.userData = { torso, armL, armR, head, eyeMat, eye: new THREE.Color(T.eye).multiplyScalar(3), tilt: 0, hit: 0 };
  return g;
}

function buildZone(project, i, cx, czTop, L) {
  const T = TERRAINS[i % TERRAINS.length];
  const color = project.color || '#b38bff';
  const zw = L.cellW, zd = L.cellD, zc = czTop + zd / 2;
  const g = new THREE.Group(); world.add(g);
  const rand = seeded(hashStr(project.id || project.name || String(i)));

  box(g, zw, 0.3, zd, T.edge, cx, 0.15, zc);
  const top = new THREE.Mesh(new THREE.BoxGeometry(zw - 0.2, 0.04, zd - 0.2),
    new THREE.MeshStandardMaterial({ map: stoneTexture(T.ground, hashStr(T.name), [zw / 3, zd / 3]), roughness: T.decor === 'ice' ? 0.45 : 0.9 }));
  top.position.set(cx, 0.31, zc); top.receiveShadow = true; g.add(top);

  // Glowing outline in the project's colour
  const line = glow(color, 1.8);
  box(g, zw, 0.04, 0.05, line, cx, 0.34, czTop + 0.03);
  box(g, zw, 0.04, 0.05, line, cx, 0.34, czTop + zd - 0.03);
  box(g, 0.05, 0.04, zd, line, cx - zw / 2 + 0.03, 0.34, zc);
  box(g, 0.05, 0.04, zd, line, cx + zw / 2 - 0.03, 0.34, zc);

  // Banners at the back corners
  for (const bx of [cx - zw / 2 + 0.25, cx + zw / 2 - 0.25]) {
    box(g, 0.07, 2.0, 0.07, '#3a2c24', bx, 1.3, czTop + 0.25);
    box(g, 0.05, 0.75, 0.42, mat(color, 0.9), bx, 1.85, czTop + 0.5);
    box(g, 0.08, 0.08, 0.08, metal('#d9b45a'), bx, 2.33, czTop + 0.25);
  }
  zoneDecor(g, T, cx, czTop, zw, zd, rand);

  const boss = makeBoss(T, hashStr(project.id || project.name || 'b'));
  boss.position.set(cx, 0.32, czTop + 1.45);
  g.add(boss);

  const pod = { project, terrain: T, boss, hp: 1, defeated: false, target: new THREE.Vector3(cx, 1.8, czTop + 1.6) };
  const list = project.agents || [];
  const rows = Math.max(1, Math.ceil(list.length / SEATS_PER_ROW));
  for (let r = 0; r < rows; r++) {
    const seats = list.slice(r * SEATS_PER_ROW, (r + 1) * SEATS_PER_ROW);
    seats.forEach((a, k) => buildHero(project, a, cx + (k - (seats.length - 1) / 2) * 1.5, czTop + 3.8 + r * 1.7, pod));
  }

  const label = document.createElement('div');
  label.className = 'zone-label';
  label.addEventListener('click', () => focusOn(new THREE.Vector3(cx, 0, zc), 1.5));
  document.getElementById('labels').appendChild(label);
  pod.label = label;
  pod.anchor = new THREE.Vector3(cx, 4.2, czTop + 1.45);
  pods.push(pod);
}

function buildHero(project, a, hx, hz, pod) {
  const seed = hashStr(a.id || a.name || 'x');
  const shirt = a.color || project.color || '#b38bff';
  const body = makeCharacter(seed, shirt);
  const { head, armL, armR } = body.userData.parts;

  const cape = new THREE.Group(); cape.position.set(0, 1.0, -0.17); body.add(cape);
  box(cape, 0.52, 0.8, 0.04, mat(shade(shirt, -0.22), 0.95), 0, -0.39, 0);
  box(head, 0.56, 0.08, 0.54, metal('#d9b45a'), 0, 0.42, 0);

  const kind = seed % 3;
  const weapon = new THREE.Group(); weapon.position.set(0, -0.44, 0.04); armR.add(weapon);
  if (kind === 0) {                                     // sword and shield
    box(weapon, 0.24, 0.06, 0.1, metal('#d9b45a'), 0, -0.06, 0);
    box(weapon, 0.07, 0.72, 0.03, metal('#dfe7ef'), 0, -0.46, 0);
    box(armL, 0.07, 0.42, 0.36, metal(shade(shirt, 0.05)), -0.08, -0.32, 0.05);
  } else if (kind === 1) {                              // hammer
    box(weapon, 0.06, 0.62, 0.06, '#5d4030', 0, -0.25, 0);
    box(weapon, 0.34, 0.22, 0.22, metal('#8e98ab'), 0, -0.58, 0);
  } else {                                              // staff
    box(weapon, 0.05, 0.95, 0.05, '#5d4030', 0, -0.2, 0);
    box(weapon, 0.16, 0.16, 0.16, glow(shade(shirt, 0.15), 2.4), 0, -0.72, 0);
  }

  // Signal beam + ground ring (needs you), dizzy stars (down), victory gem (done)
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 10, 0.16), glow(STATUS.needs_you.css, 2.2, 0.55));
  beam.position.y = 5.6; beam.visible = false; body.add(beam);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.55, 32), glow(STATUS.needs_you.css, 2.2, 0.7));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false; body.add(ring);
  const stars = new THREE.Group(); stars.position.set(0, 1.3, 0.5); stars.visible = false; body.add(stars);
  for (let k = 0; k < 3; k++) {
    const an = k / 3 * Math.PI * 2;
    box(stars, 0.1, 0.1, 0.1, glow('#ffd84a', 2.4), Math.cos(an) * 0.3, Math.sin(an) * 0.3, 0);
  }
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), glow(STATUS.done.css, 2.6));
  gem.position.y = 2.0; gem.visible = false; body.add(gem);
  world.add(body);

  const home = new THREE.Vector3(hx, 0.32, hz);
  const ag = {
    id: a.id, data: a, project, body, beam, ring, stars, gem, pod,
    home, baseY: 0.32, status: null, path: [], pathIdx: 0, mode: 'home',
    phase: (seed % 100) / 17, nextBreak: 6 + (seed % 14), lastSwing: 0,
    pos: home.clone(), facing: Math.PI,
  };
  body.traverse(o => { o.userData.agentId = a.id; });
  const tag = document.createElement('div');
  tag.addEventListener('click', () => { openCard(a.id); focusOn(home, 1.7); });
  document.getElementById('labels').appendChild(tag);
  ag.tag = tag;
  agents.set(a.id, ag);
}

function buildCamp(x, z) {
  const g = new THREE.Group(); g.position.set(x, 0, z); world.add(g);
  for (let k = 0; k < 8; k++) {
    const an = k / 8 * Math.PI * 2;
    box(g, 0.16, 0.12, 0.16, '#6e6676', Math.cos(an) * 0.36, 0.06, Math.sin(an) * 0.36);
  }
  box(g, 0.6, 0.11, 0.13, '#4e3426', 0, 0.09, 0).rotation.y = 0.6;
  box(g, 0.6, 0.11, 0.13, '#4e3426', 0, 0.09, 0).rotation.y = -0.6;
  const flames = [
    box(g, 0.28, 0.42, 0.28, glow('#ff6a1a', 2.6), 0, 0.33, 0),
    box(g, 0.16, 0.32, 0.16, glow('#ffc23a', 2.8), 0.05, 0.52, 0.04),
    box(g, 0.12, 0.24, 0.12, glow('#ff9a2a', 2.6), -0.07, 0.43, -0.05),
  ];
  const light = new THREE.PointLight('#ff8a3a', 6, 6, 1.6);
  light.position.set(0, 0.8, 0); g.add(light);
  fire = { flames, light };
  for (const [lx, lz, ry] of [[-1.0, 0, Math.PI / 2], [1.0, 0, Math.PI / 2], [0, -1.0, 0], [0, 1.0, 0]]) {
    box(g, 1.0, 0.2, 0.24, '#5d4030', lx, 0.1, lz).rotation.y = ry;
  }
  for (const [tx, tz, c] of [[-1.6, -1.4, '#bfa77c'], [1.5, -1.6, '#8a4a40']]) {
    const tent = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.2, 4), mat(c, 0.95));
    tent.position.set(tx, 0.6, tz); tent.rotation.y = Math.PI / 4; tent.castShadow = tent.receiveShadow = true;
    g.add(tent);
    box(g, 0.28, 0.48, 0.04, '#221a1e', tx, 0.24, tz + 0.6, { cast: false });
  }
  campSpot.set(x, 0, z);
}

function buildCommand(o, x, z) {
  const g = new THREE.Group(); world.add(g);
  const tent = new THREE.Mesh(new THREE.ConeGeometry(1.3, 1.8, 4), mat('#7d2a35', 0.95));
  tent.position.set(x - 0.4, 0.9, z - 1.5); tent.rotation.y = Math.PI / 4; tent.castShadow = tent.receiveShadow = true;
  g.add(tent);
  box(g, 0.07, 2.8, 0.07, '#3a2c24', x - 0.4, 1.4, z - 1.5);
  box(g, 0.05, 0.42, 0.7, mat('#d9b45a', 0.6, 0.3), x - 0.4, 2.55, z - 1.12);
  box(g, 1.7, 0.1, 1.0, '#5d4030', x, 0.75, z);
  for (const [lx, lz] of [[-0.75, -0.4], [0.75, -0.4], [-0.75, 0.4], [0.75, 0.4]]) box(g, 0.09, 0.72, 0.09, '#3f2b20', x + lx, 0.36, z + lz);
  const screenMat = new THREE.MeshBasicMaterial({ color: '#2dd4bf', fog: false });
  box(g, 1.5, 0.02, 0.8, screenMat, x, 0.81, z);
  box(g, 0.1, 1.6, 0.1, '#2e2838', x + 1.3, 0.8, z);
  const lampMat = new THREE.MeshBasicMaterial({ color: '#ff4d4d', fog: false });
  box(g, 0.3, 0.3, 0.3, lampMat, x + 1.3, 1.75, z);
  const lampLight = new THREE.PointLight('#ff3a4a', 0, 7, 1.6);
  lampLight.position.set(x + 1.3, 1.9, z); g.add(lampLight);

  const body = makeCharacter(7, '#d65a7e');
  const cape = new THREE.Group(); cape.position.set(0, 1.0, -0.17); body.add(cape);
  box(cape, 0.56, 0.86, 0.04, mat('#7d2a35', 0.95), 0, -0.41, 0);
  box(body.userData.parts.head, 0.56, 0.08, 0.54, metal('#d9b45a'), 0, 0.42, 0);
  body.position.set(x, 0, z - 0.75);
  body.rotation.y = Math.PI / 5;
  body.userData.parts.armR.rotation.x = -0.9;
  body.traverse(c => { c.userData.owner = true; });
  world.add(body);

  const label = document.createElement('div');
  label.className = 'owner-label';
  label.addEventListener('click', () => document.getElementById('inbox').classList.remove('collapsed'));
  document.getElementById('labels').appendChild(label);
  owner = { name: o.name || 'You', screenMat, lampMat, lampLight, label, anchor: new THREE.Vector3(x, 0.1, z + 1.0) };
}

/* ------------------------------------------------------------------ *
 *  Applying data
 * ------------------------------------------------------------------ */
const handledKey = a => `${a.id}@${a.updated || ''}`;
function effectiveStatus(a) {
  const s = STATUS[a.status] ? a.status : 'idle';
  if (ALERT_STATUSES.has(s) && handled[handledKey(a)]) return 'idle';
  return s;
}

function applyData(d) {
  data = d;
  const key = JSON.stringify((d.projects || []).map(p => [p.id, p.color, (p.agents || []).map(a => a.id)]));
  if (key !== layoutKey) { layoutKey = key; buildWorld(d); }
  for (const p of d.projects || []) {
    for (const a of p.agents || []) {
      const ag = agents.get(a.id);
      if (!ag) continue;
      ag.data = a; ag.project = p;
      setStatus(ag, effectiveStatus(a));
      updateTag(ag);
    }
  }
  document.getElementById('title').textContent = `${(d.owner && d.owner.name) || 'My'}'s ${APP_NAME}`;
  renderHud();
  notifyNew();
  if (openCardId) openCard(openCardId);
}

function updateTag(ag) {
  const s = ag.status, a = ag.data;
  const alert = ALERT_STATUSES.has(s);
  ag.tag.className = `agent-tag s-${s}${alert ? ' ask' : ''}`;
  ag.tag.innerHTML = alert
    ? `<div class="ask-who"><i class="dot" style="background:${STATUS[s].css}"></i>${esc(a.name)} ${s === 'error' ? 'is down' : 'needs backup'}</div>
       <div class="ask-what">${esc((a.action && a.action.title) || a.task || 'Take a look')}</div>`
    : `<i class="dot" style="background:${STATUS[s].css}"></i><b>${esc(a.name)}</b><span class="tag-status">${STATUS[s].label}</span>`;
}

function setStatus(ag, s) {
  if (ag.status === s) return;
  ag.status = s;
  ag.beam.visible = ag.ring.visible = s === 'needs_you';
  ag.stars.visible = s === 'error';
  ag.gem.visible = s === 'done';
  if (s !== 'idle' && ag.mode !== 'home') walkTo(ag, [ag.home.clone()]);
}
function walkTo(ag, path) { ag.path = path; ag.pathIdx = 0; ag.mode = 'walking'; }

/* ------------------------------------------------------------------ *
 *  Animation
 * ------------------------------------------------------------------ */
const clock = new THREE.Clock();
let t = 0;

function spawnBolt(ag) {
  const from = ag.body.position.clone().add(new THREE.Vector3(0, 1.0, -0.4));
  const to = ag.pod.target.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, Math.random() * 0.6, 0));
  const m = new THREE.Mesh(boxGeo(0.14, 0.14, 0.14), glow(shade(ag.data.color || ag.project.color || '#ffffff', 0.15), 3));
  world.add(m);
  projectiles.push({ m, from, to, k: 0, pod: ag.pod });
}

function animateHero(ag, dt) {
  const { legL, legR, armL, armR, head } = ag.body.userData.parts;
  const ph = t + ag.phase;
  legL.rotation.set(0, 0, 0); legR.rotation.set(0, 0, 0);
  armL.rotation.set(0, 0, 0); armR.rotation.set(0, 0, 0);
  head.rotation.set(0, 0, 0);
  let y = 0, pitch = 0;

  if (ag.mode === 'walking') {
    const target = ag.path[ag.pathIdx];
    const delta = target.clone().sub(ag.pos);
    const dist = delta.length(), step = WALK_SPEED * dt;
    if (dist <= step) {
      ag.pos.copy(target);
      if (++ag.pathIdx >= ag.path.length) {
        ag.mode = ag.pos.distanceTo(ag.home) < 0.05 ? 'home' : 'resting';
        ag.restUntil = t + 5 + Math.random() * 6;
      }
    } else {
      ag.pos.add(delta.multiplyScalar(step / dist));
      ag.facing = Math.atan2(delta.x, delta.z);
    }
    const sw = Math.sin(t * 11) * 0.65;
    legL.rotation.x = sw; legR.rotation.x = -sw; armL.rotation.x = -sw; armR.rotation.x = sw;
    y = Math.abs(Math.sin(t * 11)) * 0.04;
  } else if (ag.mode === 'resting') {
    ag.facing = Math.atan2(campSpot.x - ag.pos.x, campSpot.z - ag.pos.z);
    legL.rotation.x = legR.rotation.x = -Math.PI / 2;
    y = -0.24;
    armL.rotation.x = armR.rotation.x = -1.0 + Math.sin(ph * 1.5) * 0.05;
    head.rotation.x = Math.sin(ph * 0.7) * 0.08;
    if (t > ag.restUntil && ag.status === 'idle') walkTo(ag, [ag.home.clone()]);
  } else {
    ag.pos.copy(ag.home);
    const s = ag.status;
    if (s === 'working') {
      ag.facing = Math.PI;
      const c = (ph * 1.2) % 1;
      armR.rotation.x = c < 0.7 ? -0.4 - 2.6 * (c / 0.7) : -3.0 + 2.6 * ((c - 0.7) / 0.3);
      armL.rotation.x = -0.7;
      legL.rotation.x = 0.35; legR.rotation.x = -0.35;
      if (c > 0.7) ag.pos.z -= Math.sin((c - 0.7) / 0.3 * Math.PI) * 0.28;
      if (c > 0.85 && ag.lastSwing <= 0.85) spawnBolt(ag);
      ag.lastSwing = c;
    } else if (s === 'needs_you') {
      ag.facing = Math.PI / 4;
      y = Math.max(0, Math.sin(ph * 5)) * 0.3;
      armR.rotation.z = 2.7 + Math.sin(ph * 9) * 0.3;
      const pulse = 0.5 + 0.5 * Math.sin(t * 5);
      ag.ring.scale.setScalar(1 + pulse * 0.5);
      ag.beam.scale.x = ag.beam.scale.z = 0.8 + pulse * 0.4;
    } else if (s === 'error') {
      ag.facing = Math.PI / 4;
      pitch = -Math.PI / 2;
      y = 0.17;
      armL.rotation.z = -1.2; armR.rotation.z = 1.2;
      ag.stars.rotation.z = t * 4;
    } else if (s === 'done') {
      ag.facing = Math.PI / 4;
      armL.rotation.z = -2.6 - Math.sin(ph * 4) * 0.15;
      armR.rotation.z = 2.6 + Math.sin(ph * 4) * 0.15;
      y = Math.max(0, Math.sin(ph * 3)) * 0.1;
      ag.gem.rotation.y = t * 2;
      ag.gem.position.y = 2.0 + Math.sin(t * 3) * 0.06;
    } else {
      ag.facing = Math.PI;
      armL.rotation.x = armR.rotation.x = -0.15;
      head.rotation.x = 0.15 + Math.sin(ph) * 0.05;
      ag.nextBreak -= dt;
      if (ag.nextBreak <= 0) {
        ag.nextBreak = 14 + Math.random() * 16;
        const an = Math.random() * Math.PI * 2;
        walkTo(ag, [campSpot.clone().add(new THREE.Vector3(Math.cos(an) * 1.0, 0.24, Math.sin(an) * 1.0))]);
      }
    }
  }
  ag.body.position.set(ag.pos.x, ag.pos.y + y, ag.pos.z);
  ag.body.rotation.set(pitch, ag.facing, 0);
}

function worldTick(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.k += dt / 0.45;
    if (p.k >= 1) {
      world.remove(p.m);
      projectiles.splice(i, 1);
      p.pod.boss.userData.hit = 0.16;
      continue;
    }
    p.m.position.lerpVectors(p.from, p.to, p.k);
    p.m.position.y += Math.sin(p.k * Math.PI) * 0.7;
    p.m.rotation.set(t * 8, t * 6, 0);
  }

  for (const pod of pods) {
    const b = pod.boss.userData;
    const ph = t + pod.boss.position.x;
    b.tilt += ((pod.defeated ? -1.45 : 0) - b.tilt) * Math.min(1, dt * 3);
    pod.boss.rotation.x = b.tilt;
    if (pod.defeated) {
      b.eyeMat.color.set('#2a2433');
      b.armL.rotation.set(0, 0, -0.3); b.armR.rotation.set(0, 0, 0.3);
      continue;
    }
    b.eyeMat.color.copy(b.eye).multiplyScalar(b.hit > 0 ? 1.8 : 1);
    b.hit = Math.max(0, b.hit - dt);
    const flinch = b.hit > 0 ? 0.1 : 0;
    b.torso.rotation.x = -flinch + Math.sin(ph * 1.2) * 0.04;
    b.torso.rotation.z = Math.sin(ph * 0.8) * 0.05;
    b.armL.rotation.x = -Math.max(0, Math.sin(ph * 1.1)) * 1.4;
    b.armR.rotation.x = -Math.max(0, Math.sin(ph * 1.1 + Math.PI)) * 1.4;
    b.head.rotation.y = Math.sin(ph * 0.6) * 0.3;
    pod.boss.scale.setScalar(1 + flinch * 0.25);
  }

  if (fire) {
    fire.flames.forEach((f, i) => f.scale.set(1, 0.8 + 0.3 * Math.abs(Math.sin(t * (9 + i * 3) + i)), 1));
    fire.light.intensity = 5 + Math.sin(t * 13) * 0.8 + Math.sin(t * 7) * 0.6;
  }

  if (embers) {
    const { speed, W, D } = embers.userData;
    const pos = embers.geometry.attributes.position;
    for (let i = 0; i < speed.length; i++) {
      let y = pos.getY(i) + speed[i] * dt;
      let x = pos.getX(i) + Math.sin(t * 0.7 + i) * dt * 0.15 + dt * 0.12;
      if (y > 9) { y = 0; x = (Math.random() - 0.5) * (W + 8); }
      pos.setXY(i, x, y);
    }
    pos.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ *
 *  Labels
 * ------------------------------------------------------------------ */
const tmp = new THREE.Vector3();
const tagPos = new THREE.Vector3();
function toScreen(v) {
  tmp.copy(v).project(camera);
  return { x: (tmp.x + 1) / 2 * window.innerWidth, y: (1 - tmp.y) / 2 * window.innerHeight, vis: tmp.z > -1 && tmp.z < 1 };
}
function placeLabel(v, el) {
  const p = toScreen(v);
  el.style.display = p.vis ? '' : 'none';
  el.style.left = p.x.toFixed(0) + 'px';
  el.style.top = p.y.toFixed(0) + 'px';
}
/* Names show on hover or when zoomed in; alert bubbles always show and stack instead of overlapping */
function placeAgentTags() {
  const showNames = camera.zoom >= 1.25;
  const bubbles = [];
  agents.forEach(ag => {
    const alert = ALERT_STATUSES.has(ag.status);
    if (!alert && !showNames && hoveredId !== ag.id) { ag.tag.style.display = 'none'; return; }
    tagPos.set(ag.body.position.x, ag.baseY + (alert ? 2.45 : 1.8), ag.body.position.z);
    if (!alert) { placeLabel(tagPos, ag.tag); return; }
    bubbles.push({ ag, ...toScreen(tagPos) });
  });
  bubbles.sort((a, b) => b.y - a.y);
  const placed = [];
  for (const b of bubbles) {
    const w = b.ag.tag.offsetWidth || 180, h = b.ag.tag.offsetHeight || 50;
    let y = b.y;
    for (let guard = 0; guard < 12; guard++) {
      const hit = placed.find(p => Math.abs(b.x - p.x) < (w + p.w) / 2 + 6 && y > p.y - p.h - 8 && y - h < p.y + 8);
      if (!hit) break;
      y = hit.y - hit.h - 10;
    }
    placed.push({ x: b.x, y, w, h });
    b.ag.tag.style.display = b.vis ? '' : 'none';
    b.ag.tag.style.left = b.x.toFixed(0) + 'px';
    b.ag.tag.style.top = y.toFixed(0) + 'px';
  }
}

/* ------------------------------------------------------------------ *
 *  Main loop and camera
 * ------------------------------------------------------------------ */
let camGoal = null;
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.1);
  t += dt;
  if (demoOn) demoTick(dt);
  agents.forEach(ag => animateHero(ag, dt));
  worldTick(dt);

  if (owner) {
    const n = inboxItems().length;
    const on = n && Math.sin(t * 5) > 0;
    owner.lampMat.color.set(n ? '#ff3a4a' : '#22c55e').multiplyScalar(on ? 3 : n ? 0.8 : 1.6);
    owner.lampLight.intensity = n ? (on ? 5 : 0.5) : 0;
    owner.screenMat.color.set(n ? '#c2415a' : '#1f9e8f');
  }

  if (camGoal) {
    const k = 1 - Math.pow(0.002, dt);
    const move = camGoal.target.clone().sub(controls.target).multiplyScalar(k);
    controls.target.add(move); camera.position.add(move);
    camera.zoom += (camGoal.zoom - camera.zoom) * k;
    camera.updateProjectionMatrix();
    if (move.length() < 0.001 && Math.abs(camGoal.zoom - camera.zoom) < 0.01) camGoal = null;
  }
  controls.update();

  for (const p of pods) placeLabel(p.anchor, p.label);
  if (owner) placeLabel(owner.anchor, owner.label);
  placeAgentTags();
  composer.render();
}

function resetView() {
  if (!world) return;
  const h = world.userData.home;
  controls.target.copy(h.target);
  camera.position.copy(h.target).addScaledVector(CAM_DIR, h.dist);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  camGoal = null;
}
function focusOn(v, zoom) {
  camGoal = { target: v.clone().setY(0.6), zoom: zoom || Math.max(camera.zoom, 1.6) };
}

/* ------------------------------------------------------------------ *
 *  HUD: stats, inbox, hero card
 * ------------------------------------------------------------------ */
function allAgents() {
  const out = [];
  for (const p of (data && data.projects) || []) for (const a of p.agents || []) out.push({ a, p });
  return out;
}
function inboxItems() {
  return allAgents().filter(({ a }) => ALERT_STATUSES.has(effectiveStatus(a)))
    .sort((x, y) => (y.a.updated || '').localeCompare(x.a.updated || ''));
}

function renderHud() {
  const counts = {};
  for (const { a } of allAgents()) { const s = effectiveStatus(a); counts[s] = (counts[s] || 0) + 1; }
  const projects = (data.projects || []).length;
  document.getElementById('stats').innerHTML =
    `<span class="stat">${projects} battle${projects === 1 ? '' : 's'}</span>` +
    Object.keys(STATUS).filter(s => counts[s]).map(s =>
      `<span class="stat"><i class="dot" style="background:${STATUS[s].css}"></i>${counts[s]} ${STATUS[s].label.toLowerCase()}</span>`).join('');

  const items = inboxItems();
  const badge = document.getElementById('inbox-count');
  badge.textContent = items.length;
  badge.classList.toggle('zero', !items.length);
  const ul = document.getElementById('inbox-list');
  ul.innerHTML = items.length ? '' : '<li class="empty">All quiet on the battlefield.</li>';
  for (const { a, p } of items) {
    const li = document.createElement('li');
    const s = effectiveStatus(a);
    li.innerHTML = `<div class="who"><i class="dot" style="background:${STATUS[s].css}"></i>${esc(a.name)} · ${esc(p.name)}</div>
      <div class="what">${esc((a.action && a.action.title) || a.task || STATUS[s].label)}</div>`;
    li.addEventListener('click', () => { openCard(a.id); const ag = agents.get(a.id); if (ag) focusOn(ag.home, 1.7); });
    ul.appendChild(li);
  }
  document.title = items.length ? `(${items.length}) ${APP_NAME}` : APP_NAME;

  for (const pd of pods) {
    const list = pd.project.agents || [];
    const n = list.filter(a => ALERT_STATUSES.has(effectiveStatus(a))).length;
    const prog = list.length ? list.reduce((sum, a) => sum + (effectiveStatus(a) === 'done' ? 1 : Math.max(0, Math.min(1, +a.progress || 0))), 0) / list.length : 0;
    pd.hp = 1 - prog;
    pd.defeated = list.length > 0 && list.every(a => effectiveStatus(a) === 'done');
    pd.label.style.setProperty('--accent', pd.project.color || '#b38bff');
    pd.label.innerHTML = `<div class="zone-name">${esc(pd.project.name)}${n ? `<span class="alert">${n}</span>` : ''}</div>
      <div class="zone-sub">${pd.defeated ? 'Boss defeated' : `${esc(pd.terrain.name)} · ${Math.round(pd.hp * 100)}% HP`}</div>
      <div class="hp"><span style="width:${(pd.hp * 100).toFixed(0)}%"></span></div>`;
  }
  if (owner) {
    owner.label.textContent = items.length ? `${owner.name} · ${items.length} need${items.length === 1 ? 's' : ''} you` : `${owner.name} · all clear`;
    owner.label.classList.toggle('calm', !items.length);
  }
}

let openCardId = null;
function openCard(id) {
  const found = allAgents().find(x => x.a.id === id);
  if (!found) return closeCard();
  openCardId = id;
  const { a, p } = found;
  const s = effectiveStatus(a);
  const pct = Math.round(Math.max(0, Math.min(1, a.progress || 0)) * 100);
  document.getElementById('card-name').textContent = a.name;
  let html = `<div class="row">${esc(a.role || 'Hero')} · <b>${esc(p.name)}</b></div>
    <span class="pill" style="--c:${STATUS[s].css}">${STATUS[s].label}</span>
    <div class="row">Task <b>${esc(a.task || '—')}</b></div>
    <div class="bar"><span style="width:${pct}%"></span></div>
    <div class="row">${pct}% done${a.updated ? ` · updated ${ago(a.updated)}` : ''}</div>`;
  if (ALERT_STATUSES.has(s)) {
    const act = a.action || {};
    html += `<div class="action ${s === 'error' ? 'err' : ''}">
      <h3>${esc(act.title || (s === 'error' ? 'Something broke' : 'Needs your input'))}</h3>
      ${act.detail ? `<p>${esc(act.detail)}</p>` : ''}
      ${safeLink(act.link) ? `<p><a href="${esc(act.link)}" target="_blank" rel="noopener">Open →</a></p>` : ''}
      <button class="btn primary" id="btn-handled">Mark handled</button>
    </div>`;
  } else if (handled[handledKey(a)]) {
    html += `<div class="row note">You marked this handled.</div>`;
  }
  document.getElementById('card-body').innerHTML = html;
  const btn = document.getElementById('btn-handled');
  if (btn) btn.addEventListener('click', () => {
    handled[handledKey(a)] = true; store.set('handled', handled);
    const ag = agents.get(a.id); if (ag) { setStatus(ag, effectiveStatus(a)); updateTag(ag); }
    renderHud(); openCard(a.id);
  });
  document.getElementById('card').hidden = false;
}
function closeCard() { openCardId = null; document.getElementById('card').hidden = true; }

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeLink(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }
function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return iso;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* ------------------------------------------------------------------ *
 *  Alerts: chime + desktop notifications
 * ------------------------------------------------------------------ */
let seenAlerts = null;
let audioCtx = null;
window.addEventListener('pointerdown', () => {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* no audio */ }
});
function chime() {
  if (!soundOn || !audioCtx) return;
  try {
    [659, 988, 1319].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      const t0 = audioCtx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.55);
    });
  } catch { /* audio blocked */ }
}
function notifyNew() {
  const items = inboxItems();
  const keys = new Set(items.map(x => handledKey(x.a)));
  if (seenAlerts === null) { seenAlerts = keys; return; }
  const fresh = items.filter(x => !seenAlerts.has(handledKey(x.a)));
  seenAlerts = keys;
  if (!fresh.length) return;
  chime();
  const first = fresh[0];
  const msg = `${first.a.name} (${first.p.name}): ${(first.a.action && first.a.action.title) || first.a.task || 'needs you'}`;
  toast(msg + (fresh.length > 1 ? ` · +${fresh.length - 1} more` : ''));
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('A hero needs backup', { body: msg, tag: 'final-battle' }); } catch { /* ignore */ }
  }
}
let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

/* ------------------------------------------------------------------ *
 *  Demo mode
 * ------------------------------------------------------------------ */
let demoOn = params.has('demo');
let demoClock = 2;
const DEMO_ASKS = ['Approve the draft', 'Pick between two options', 'Review the changes', 'Confirm the budget', 'Answer a quick question'];
function demoTick(dt) {
  demoClock -= dt;
  if (demoClock > 0 || !data) return;
  demoClock = 3 + Math.random() * 3;
  const list = allAgents(); if (!list.length) return;
  const { a } = list[Math.floor(Math.random() * list.length)];
  const r = Math.random();
  a.status = r < 0.4 ? 'working' : r < 0.6 ? 'idle' : r < 0.8 ? 'needs_you' : r < 0.92 ? 'done' : 'error';
  a.updated = new Date().toISOString();
  a.progress = a.status === 'done' ? 1 : Math.random();
  if (ALERT_STATUSES.has(a.status)) a.action = { title: DEMO_ASKS[Math.floor(Math.random() * DEMO_ASKS.length)], detail: 'Demo request.' };
  applyData(data);
}

/* ------------------------------------------------------------------ *
 *  Input
 * ------------------------------------------------------------------ */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(ev) {
  if (!world) return null;
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  for (const h of ray.intersectObjects(world.children, true)) {
    if (h.object.userData.agentId) return { agentId: h.object.userData.agentId };
    if (h.object.userData.owner) return { owner: true };
  }
  return null;
}
let downAt = null;
canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; camGoal = null; });
canvas.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const hit = pick(e);
  if (hit && hit.agentId) { openCard(hit.agentId); focusOn(agents.get(hit.agentId).home, 1.7); }
  else if (hit && hit.owner) document.getElementById('inbox').classList.remove('collapsed');
  else closeCard();
});
const tip = document.getElementById('tooltip');
canvas.addEventListener('pointermove', e => {
  if (e.buttons) { tip.hidden = true; hoveredId = null; return; }
  const hit = pick(e);
  const ag = hit && hit.agentId && agents.get(hit.agentId);
  hoveredId = ag ? ag.id : null;
  canvas.style.cursor = ag || (hit && hit.owner) ? 'pointer' : '';
  tip.hidden = true;
});

document.getElementById('card-close').addEventListener('click', closeCard);
document.getElementById('inbox-toggle').addEventListener('click', () => {
  const el = document.getElementById('inbox');
  el.classList.toggle('collapsed');
  document.getElementById('inbox-toggle').textContent = el.classList.contains('collapsed') ? '+' : '–';
});
document.getElementById('btn-reset').addEventListener('click', resetView);

const demoBtn = document.getElementById('btn-demo');
const syncDemo = () => { demoBtn.classList.toggle('on', demoOn); demoBtn.textContent = demoOn ? 'Stop demo' : 'Demo'; };
demoBtn.addEventListener('click', () => { demoOn = !demoOn; syncDemo(); if (!demoOn) load(); });
syncDemo();

const soundBtn = document.getElementById('btn-sound');
const syncSound = () => { soundBtn.classList.toggle('on', soundOn); soundBtn.textContent = soundOn ? 'Sound on' : 'Sound off'; };
soundBtn.addEventListener('click', () => { soundOn = !soundOn; store.set('sound', soundOn); syncSound(); if (soundOn) chime(); });
syncSound();

const notifyBtn = document.getElementById('btn-notify');
const syncNotify = () => {
  const ok = 'Notification' in window;
  notifyBtn.classList.toggle('on', ok && Notification.permission === 'granted');
  notifyBtn.disabled = !ok;
  notifyBtn.title = ok ? 'Desktop notification when a hero needs you and this tab is in the background' : 'Notifications not supported';
};
notifyBtn.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') { toast('Desktop alerts are on'); return; }
  await Notification.requestPermission(); syncNotify();
});
syncNotify();

document.getElementById('legend').innerHTML = Object.values(STATUS)
  .map(s => `<span><i class="dot" style="background:${s.css}"></i>${s.label}</span>`).join('');

/* ------------------------------------------------------------------ *
 *  Data loading
 * ------------------------------------------------------------------ */
async function load() {
  if (demoOn && data) return;
  try {
    const res = await fetch(DATA_URL + (DATA_URL.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    applyData(await res.json());
  } catch (err) {
    if (!data) toast(`Couldn't load ${DATA_URL}. Serve this folder over http (see README).`);
    console.warn('final-battle: data load failed', err);
  }
}

resize();
loop();
load();
setInterval(load, POLL_MS);
