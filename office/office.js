import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/* ------------------------------------------------------------------ *
 *  Config
 * ------------------------------------------------------------------ */
const params = new URLSearchParams(location.search);

// Two looks: 'cozy' (smooth, rounded, light theme, default) and 'pixel' (chunky retro)
const STYLE = (params.get('style') || (() => { try { return localStorage.getItem('office.style'); } catch { return null; } })() || 'cozy').replace(/"/g, '');
const COZY = STYLE !== 'pixel';
document.body.classList.add(COZY ? 'cozy' : 'pixel');

// Two worlds: 'battle' (default: each project is a battle zone) and 'office'
const THEME = (params.get('theme') || (() => { try { return localStorage.getItem('office.theme'); } catch { return null; } })() || 'battle').replace(/"/g, '');
const BATTLE = THEME !== 'office';
document.body.classList.add(BATTLE ? 'battle' : 'office-world');
const APP_NAME = BATTLE ? 'Final Battle' : 'Agent Office';

const PIX = COZY ? 1 : 3;      // screen pixels per render pixel (bigger = chunkier)
const POLL_MS = 30000;         // how often data is re-fetched
const SEATS_PER_ROW = 4;
const SEAT_W = 1.7;
const ROW_D = 3.2;
const WALK_SPEED = 1.8;

const STATUS = {
  working:   { label: 'Working',   css: '#3ddc84' },
  idle:      { label: 'Idle',      css: '#8a8f98' },
  needs_you: { label: 'Needs you', css: '#ff4d4d' },
  error:     { label: 'Error',     css: '#ffb020' },
  done:      { label: 'Done',      css: '#4da3ff' },
};
const ALERT_STATUSES = new Set(['needs_you', 'error']);
if (BATTLE) {
  STATUS.working.label = 'Fighting';
  STATUS.idle.label = 'Resting';
  STATUS.needs_you.label = 'Needs backup';
  STATUS.error.label = 'Down';
  STATUS.done.label = 'Victory';
}

const DATA_URL = params.get('data') || 'data.json';

/* ------------------------------------------------------------------ *
 *  Persistent per-browser state
 * ------------------------------------------------------------------ */
const store = {
  get(k, d) { try { const v = localStorage.getItem('office.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('office.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
let handled = store.get('handled', {});      // `${agentId}@${updated}` -> true
let soundOn = store.get('sound', true);

/* ------------------------------------------------------------------ *
 *  Renderer / scene / camera
 * ------------------------------------------------------------------ */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: COZY });
renderer.setPixelRatio(COZY ? Math.min(window.devicePixelRatio || 1, 2) : 1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = COZY ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const BG = COZY ? '#f7efe2' : '#1b1a2e';
scene.background = new THREE.Color(BG);

const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
const CAM_DIR = new THREE.Vector3(1, 1.05, 1).normalize();
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minZoom = 0.5;
controls.maxZoom = 4;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = 1.2;
controls.screenSpacePanning = false;

const hemi = new THREE.HemisphereLight('#ffffff', '#5a4a7a', 1.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff1d6', 2.0);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun, sun.target);

let viewSize = 14;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(Math.ceil(w / PIX), Math.ceil(h / PIX), false);
  const a = w / h;
  const s = a < 1 ? viewSize / a : viewSize;
  camera.left = -s * a / 2; camera.right = s * a / 2;
  camera.top = s / 2; camera.bottom = -s / 2;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

/* ------------------------------------------------------------------ *
 *  Voxel helpers
 * ------------------------------------------------------------------ */
const matCache = new Map();
let toonRamp = null;
function toonGradient() {
  if (toonRamp) return toonRamp;
  const data = new Uint8Array([150, 210, 255]);
  toonRamp = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
  toonRamp.needsUpdate = true;
  return toonRamp;
}
function mat(color) {
  const key = String(color);
  if (!matCache.has(key)) matCache.set(key, COZY
    ? new THREE.MeshToonMaterial({ color, gradientMap: toonGradient() })
    : new THREE.MeshLambertMaterial({ color }));
  return matCache.get(key);
}
const geoCache = new Map();
function boxGeo(w, h, d) {
  const key = `${w}|${h}|${d}`;
  if (!geoCache.has(key)) {
    const r = Math.min(Math.min(w, h, d) * 0.3, 0.09);
    geoCache.set(key, COZY && r > 0.008 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d));
  }
  return geoCache.get(key);
}
function box(parent, w, h, d, color, x = 0, y = 0, z = 0, opts = {}) {
  const m = new THREE.Mesh(boxGeo(w, h, d), opts.material || mat(color));
  m.position.set(x, y, z);
  m.castShadow = opts.cast !== false;
  m.receiveShadow = true;
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

function checkerTexture(a, b) {
  const c = document.createElement('canvas'); c.width = c.height = 2;
  const g = c.getContext('2d');
  g.fillStyle = a; g.fillRect(0, 0, 2, 2);
  g.fillStyle = b; g.fillRect(0, 0, 1, 1); g.fillRect(1, 1, 1, 1);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ *
 *  Characters
 * ------------------------------------------------------------------ */
const SKIN = ['#f6d1b1', '#e0ac85', '#c68a5f', '#8d5a3b', '#ffe0c4'];
const HAIR = ['#2b1d14', '#5a3a22', '#d9a441', '#1a1a1a', '#a04a2a', '#6b5bd6', '#e86aa0'];

function makeCharacter(seed, shirt) {
  const g = new THREE.Group();
  const skin = SKIN[seed % SKIN.length];
  const hair = HAIR[(seed >>> 3) % HAIR.length];
  const pants = '#3a3556';

  const legL = new THREE.Group(); legL.position.set(-0.11, 0.45, 0); g.add(legL);
  const legR = new THREE.Group(); legR.position.set(0.11, 0.45, 0); g.add(legR);
  box(legL, 0.18, 0.45, 0.2, pants, 0, -0.225, 0);
  box(legR, 0.18, 0.45, 0.2, pants, 0, -0.225, 0);
  box(legL, 0.2, 0.08, 0.26, '#1c1a2b', 0, -0.42, 0.03);
  box(legR, 0.2, 0.08, 0.26, '#1c1a2b', 0, -0.42, 0.03);

  box(g, 0.5, 0.55, 0.3, shirt, 0, 0.725, 0);

  const armL = new THREE.Group(); armL.position.set(-0.33, 0.95, 0); g.add(armL);
  const armR = new THREE.Group(); armR.position.set(0.33, 0.95, 0); g.add(armR);
  box(armL, 0.14, 0.42, 0.16, shirt, 0, -0.19, 0);
  box(armR, 0.14, 0.42, 0.16, shirt, 0, -0.19, 0);
  box(armL, 0.13, 0.1, 0.15, skin, 0, -0.44, 0);
  box(armR, 0.13, 0.1, 0.15, skin, 0, -0.44, 0);

  const head = new THREE.Group(); head.position.set(0, 1.0, 0); g.add(head);
  box(head, 0.5, 0.48, 0.48, skin, 0, 0.25, 0);
  box(head, 0.54, 0.16, 0.52, hair, 0, 0.53, -0.01);
  box(head, 0.54, 0.3, 0.12, hair, 0, 0.36, -0.22);
  box(head, 0.07, 0.09, 0.02, '#1a1a1a', -0.11, 0.26, 0.245, { cast: false });
  box(head, 0.07, 0.09, 0.02, '#1a1a1a', 0.11, 0.26, 0.245, { cast: false });

  g.userData.parts = { legL, legR, armL, armR, head };
  return g;
}

/* Floating status bubble above an agent's head */
const BUBBLE_MATS = {
  needs_you: new THREE.MeshBasicMaterial({ color: STATUS.needs_you.css }),
  error: new THREE.MeshBasicMaterial({ color: STATUS.error.css }),
  done: new THREE.MeshBasicMaterial({ color: STATUS.done.css }),
};
function makeBubble() {
  const g = new THREE.Group();
  const bang = new THREE.Group();
  box(bang, 0.16, 0.4, 0.16, null, 0, 0.28, 0, { material: BUBBLE_MATS.needs_you, cast: false });
  box(bang, 0.16, 0.16, 0.16, null, 0, -0.05, 0, { material: BUBBLE_MATS.needs_you, cast: false });
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), BUBBLE_MATS.done);
  g.add(bang, gem);
  g.userData = { bang, gem };
  g.visible = false;
  return g;
}

/* ------------------------------------------------------------------ *
 *  World
 * ------------------------------------------------------------------ */
let world = null;        // THREE.Group holding everything rebuilt per layout
let layoutKey = '';
const agents = new Map(); // id -> runtime agent
let owner = null;
let coffeeSpot = new THREE.Vector3();
let stripX = 0;
let pods = [];
let data = null;

function computeLayout(projects) {
  const maxSeats = Math.max(2, ...projects.map(p => Math.min(SEATS_PER_ROW, (p.agents || []).length)));
  const maxRows = Math.max(1, ...projects.map(p => Math.ceil(((p.agents || []).length || 1) / SEATS_PER_ROW)));
  const cellW = maxSeats * SEAT_W + 2.2;
  const cellD = maxRows * ROW_D + 1.6;
  const cols = Math.max(1, Math.ceil(Math.sqrt(projects.length)));
  const rows = Math.max(1, Math.ceil(projects.length / cols));
  const leftStrip = 3.2;
  const frontArea = 4.2;
  const W = leftStrip + cols * cellW + 0.8;
  const D = 1.2 + rows * cellD + frontArea;
  return { cellW, cellD, cols, rows, leftStrip, frontArea, W, D };
}

function buildWorld(d) {
  if (world) scene.remove(world);
  world = new THREE.Group();
  scene.add(world);
  agents.clear();
  pods = [];
  document.getElementById('labels').innerHTML = '';

  const projects = d.projects || [];
  const L = computeLayout(projects);
  const { W, D } = L;
  const x0 = -W / 2, z0 = -D / 2;

  // Floor
  const floorTex = COZY ? checkerTexture('#ecdcc0', '#e4d1b1') : checkerTexture('#cfc3a8', '#c2b597');
  floorTex.repeat.set(COZY ? W / 2 : W, COZY ? D / 2 : D);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.3, D), [
    mat('#8a7a63'), mat('#8a7a63'),
    new THREE.MeshLambertMaterial({ map: floorTex }),
    mat('#8a7a63'), mat('#8a7a63'), mat('#8a7a63'),
  ]);
  floor.position.y = -0.15;
  floor.receiveShadow = true;
  world.add(floor);

  // Walls (back + left)
  const wallH = 3.6, wallT = 0.3, wallC = '#e9e1f7', trim = '#b6a8d6';
  box(world, W + wallT, wallH, wallT, wallC, wallT / -2, wallH / 2, z0 - wallT / 2);
  box(world, wallT, wallH, D, wallC, x0 - wallT / 2, wallH / 2, 0);
  box(world, W + wallT, 0.25, wallT + 0.04, trim, wallT / -2, 0.12, z0 - wallT / 2);
  box(world, wallT + 0.04, 0.25, D, trim, x0 - wallT / 2, 0.12, 0);

  // Windows on the back wall
  const hour = new Date().getHours();
  const night = hour < 7 || hour >= 19;
  const glass = night ? '#2c3f7a' : '#9fd8ff';
  for (let x = x0 + 4; x < W / 2 - 1.5; x += 3.4) {
    box(world, 2.0, 1.5, 0.08, '#7d6fa8', x, 2.0, z0 + 0.02);
    box(world, 1.8, 1.3, 0.1, glass, x, 2.0, z0 + 0.04, { cast: false });
    box(world, 0.08, 1.3, 0.12, '#7d6fa8', x, 2.0, z0 + 0.06);
    if (!night) box(world, 0.5, 0.18, 0.12, '#ffffff', x - 0.4, 2.35, z0 + 0.07, { cast: false });
  }
  scene.background = new THREE.Color(COZY ? BG : (night ? '#141327' : '#1b1a2e'));
  hemi.intensity = night ? 1.1 : 1.6;

  // Wall clock + sign
  const clock = new THREE.Group(); clock.position.set(x0 + 0.02, 2.6, z0 + 2.2); world.add(clock);
  box(clock, 0.08, 0.6, 0.6, '#2b2945');
  box(clock, 0.1, 0.48, 0.48, '#ffffff', 0.01, 0, 0, { cast: false });
  const handPivot = new THREE.Group(); handPivot.position.x = 0.07; clock.add(handPivot);
  box(handPivot, 0.04, 0.2, 0.04, '#2b2945', 0, 0.09, 0, { cast: false });
  box(handPivot, 0.04, 0.13, 0.04, '#ff4d4d', 0, 0.06, 0, { cast: false });
  world.userData.clockHand = handPivot;

  // Left strip: coffee bar, water cooler, plants, shelf
  stripX = x0 + 1.4;
  const coffee = new THREE.Group(); coffee.position.set(x0 + 0.6, 0, z0 + 1.0); world.add(coffee);
  box(coffee, 0.9, 0.9, 1.6, '#6e5a8f', 0, 0.45, 0);
  box(coffee, 0.95, 0.08, 1.65, '#e9e1f7', 0, 0.94, 0);
  box(coffee, 0.5, 0.6, 0.45, '#2b2945', 0, 1.28, -0.3);
  box(coffee, 0.1, 0.1, 0.1, '#ff4d4d', 0.26, 1.4, -0.3, { cast: false });
  box(coffee, 0.14, 0.16, 0.14, '#ffffff', 0.1, 1.06, 0.35);
  box(coffee, 0.14, 0.16, 0.14, '#ffd166', -0.12, 1.06, 0.45);
  coffeeSpot.set(x0 + 1.6, 0, z0 + 1.2);

  const cooler = new THREE.Group(); cooler.position.set(x0 + 0.5, 0, z0 + 3.0); world.add(cooler);
  box(cooler, 0.5, 0.9, 0.5, '#e9e1f7', 0, 0.45, 0);
  box(cooler, 0.4, 0.5, 0.4, '#7cc6ff', 0, 1.15, 0);

  for (let z = z0 + 4.4; z < D / 2 - 1; z += 3.2) {
    const shelf = new THREE.Group(); shelf.position.set(x0 + 0.35, 0, z); world.add(shelf);
    box(shelf, 0.6, 1.8, 1.4, '#8a6a4a', 0, 0.9, 0);
    for (let s = 0; s < 3; s++) {
      for (let b = 0; b < 5; b++) {
        const col = ['#ff8fb1', '#7cc6ff', '#ffd166', '#9be38b', '#b38bff'][(b + s + Math.abs(Math.round(z))) % 5];
        box(shelf, 0.5, 0.36, 0.18, col, 0.08, 0.35 + s * 0.55, -0.48 + b * 0.24);
      }
    }
  }
  plant(world, x0 + 0.5, D / 2 - 0.6);
  plant(world, W / 2 - 0.6, z0 + 0.6);

  // Project pods
  projects.forEach((p, i) => {
    const col = i % L.cols, row = Math.floor(i / L.cols);
    const cx = x0 + L.leftStrip + col * L.cellW + L.cellW / 2;
    const czTop = z0 + 1.2 + row * L.cellD;
    buildPod(p, cx, czTop, L);
  });

  // Owner desk (front)
  buildOwner(d.owner || {}, 0.8, D / 2 - 2.0);

  // Light + camera framing
  const span = Math.max(W, D);
  sun.position.set(-span * 0.4, span * 1.2, span * 0.6);
  sun.target.position.set(0, 0, 0);
  const sc = sun.shadow.camera;
  sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 0.5; sc.far = span * 4;
  sc.updateProjectionMatrix();

  viewSize = span * (COZY ? 0.7 : 0.72);
  world.userData.home = { target: new THREE.Vector3(-0.8, 0, -0.8), dist: span * 2 };
  resetView();
  resize();
}

function plant(parent, x, z) {
  const g = new THREE.Group(); g.position.set(x, 0, z); parent.add(g);
  box(g, 0.5, 0.5, 0.5, '#c46a3a', 0, 0.25, 0);
  box(g, 0.6, 0.5, 0.6, '#3f9e4d', 0, 0.8, 0);
  box(g, 0.4, 0.4, 0.4, '#58c063', 0.05, 1.2, 0.05);
  box(g, 0.22, 0.3, 0.22, '#3f9e4d', -0.15, 1.45, -0.1);
  return g;
}

function buildPod(project, cx, czTop, L) {
  const color = project.color || '#b38bff';
  const list = project.agents || [];
  const pod = new THREE.Group(); world.add(pod);

  // Rug
  const rugW = L.cellW - 0.6, rugD = L.cellD - 0.6;
  box(pod, rugW, 0.04, rugD, shade(color, -0.12), cx, 0.02, czTop + rugD / 2 - 0.2, { cast: false });
  box(pod, rugW - 0.4, 0.05, rugD - 0.4, shade(color, 0.08), cx, 0.025, czTop + rugD / 2 - 0.2, { cast: false });

  const rows = Math.max(1, Math.ceil(list.length / SEATS_PER_ROW));
  for (let r = 0; r < rows; r++) {
    const seats = list.slice(r * SEATS_PER_ROW, (r + 1) * SEATS_PER_ROW);
    const n = Math.max(seats.length, 1);
    const deskZ = czTop + 0.9 + r * ROW_D;
    const deskLen = n * SEAT_W;
    // Long desk
    box(pod, deskLen, 0.08, 0.9, '#f2ead8', cx, 0.76, deskZ);
    box(pod, deskLen - 0.1, 0.7, 0.06, '#c9bda3', cx, 0.4, deskZ - 0.38);
    box(pod, 0.08, 0.72, 0.84, '#c9bda3', cx - deskLen / 2 + 0.06, 0.36, deskZ);
    box(pod, 0.08, 0.72, 0.84, '#c9bda3', cx + deskLen / 2 - 0.06, 0.36, deskZ);

    seats.forEach((a, i) => {
      const sx = cx + (i - (n - 1) / 2) * SEAT_W;
      buildSeat(project, a, sx, deskZ, pod);
    });
    if (!seats.length) {
      // empty project: a lonely monitor
      box(pod, 0.7, 0.45, 0.06, '#2b2945', cx, 1.15, deskZ - 0.1);
    }
  }

  const label = document.createElement('div');
  label.className = 'floor-label';
  label.addEventListener('click', () => focusOn(new THREE.Vector3(cx, 0, czTop + L.cellD / 2), null));
  document.getElementById('labels').appendChild(label);
  pods.push({ project, label, anchor: new THREE.Vector3(cx + rugW / 2 - 0.9, 0.1, czTop + rugD - 0.75) });
}

function buildSeat(project, a, sx, deskZ, parent) {
  const seed = hashStr(a.id || a.name || 'x');
  const shirt = a.color || project.color || '#b38bff';

  // Monitor (screen faces +z toward the agent and the camera)
  const mon = new THREE.Group(); mon.position.set(sx, 0.8, deskZ - 0.15); parent.add(mon);
  box(mon, 0.12, 0.2, 0.12, '#2b2945', 0, 0.1, 0);
  box(mon, 0.78, 0.5, 0.08, '#2b2945', 0, 0.45, 0);
  const screenMat = new THREE.MeshBasicMaterial({ color: '#334' });
  box(mon, 0.68, 0.4, 0.02, null, 0, 0.45, 0.05, { material: screenMat, cast: false });
  const ledMat = new THREE.MeshBasicMaterial({ color: '#fff' });
  box(mon, 0.12, 0.12, 0.12, null, 0.3, 0.76, 0, { material: ledMat, cast: false });
  box(parent, 0.6, 0.04, 0.2, '#3a3556', sx, 0.82, deskZ + 0.2);
  box(parent, 0.14, 0.12, 0.14, (seed % 2) ? '#ffffff' : '#ffd166', sx + 0.55, 0.86, deskZ + 0.15);

  // Chair
  const chairZ = deskZ + 0.85;
  const chair = new THREE.Group(); chair.position.set(sx, 0, chairZ); parent.add(chair);
  box(chair, 0.08, 0.36, 0.08, '#2b2945', 0, 0.2, 0);
  box(chair, 0.5, 0.06, 0.5, '#2b2945', 0, 0.02, 0);
  box(chair, 0.52, 0.08, 0.5, '#4a4677', 0, 0.4, 0);
  box(chair, 0.52, 0.42, 0.08, '#4a4677', 0, 0.66, 0.26);

  const body = makeCharacter(seed, shirt);
  const bubble = makeBubble();
  bubble.position.y = 2.0;
  body.add(bubble);
  world.add(body);

  const seat = new THREE.Vector3(sx, 0, chairZ);
  const ag = {
    id: a.id, data: a, project, body, bubble, screenMat, ledMat,
    seat, aisle: new THREE.Vector3(sx, 0, chairZ + 0.85),
    status: null, path: [], pathIdx: 0, mode: 'seated', // seated | walking | standing
    phase: (seed % 100) / 17, nextBreak: 4 + (seed % 12),
    pos: seat.clone(), facing: Math.PI,
  };
  body.traverse(o => { o.userData.agentId = a.id; });
  const tag = document.createElement('div');
  tag.addEventListener('click', () => { openCard(a.id); focusOn(seat, 1.7); });
  document.getElementById('labels').appendChild(tag);
  ag.tag = tag;
  agents.set(a.id, ag);
}

function buildOwner(o, x, z) {
  const g = new THREE.Group(); world.add(g);
  box(g, 2.6, 0.1, 1.1, '#8a6a4a', x, 0.78, z);
  box(g, 0.12, 0.74, 1.0, '#6e5236', x - 1.2, 0.37, z);
  box(g, 0.12, 0.74, 1.0, '#6e5236', x + 1.2, 0.37, z);
  const mon = new THREE.Group(); mon.position.set(x, 0.83, z - 0.2); g.add(mon);
  box(mon, 0.14, 0.24, 0.14, '#2b2945', 0, 0.12, 0);
  box(mon, 1.3, 0.7, 0.08, '#2b2945', 0, 0.6, 0);
  const screenMat = new THREE.MeshBasicMaterial({ color: '#3ddc84' });
  box(mon, 1.18, 0.6, 0.02, null, 0, 0.6, 0.05, { material: screenMat, cast: false });
  // the alert lamp
  const lampMat = new THREE.MeshBasicMaterial({ color: '#ff4d4d' });
  const lamp = box(g, 0.24, 0.24, 0.24, null, x + 1.0, 1.0, z, { material: lampMat, cast: false });
  box(g, 0.3, 0.1, 0.3, '#2b2945', x + 1.0, 0.86, z);
  plant(g, x - 1.0, z - 0.1).scale.setScalar(0.45);
  g.children[g.children.length - 1].position.y = 0.82;

  const chair = new THREE.Group(); chair.position.set(x, 0, z + 0.95); g.add(chair);
  box(chair, 0.6, 0.08, 0.6, '#ff4d4d', 0, 0.4, 0);
  box(chair, 0.62, 0.6, 0.1, '#ff4d4d', 0, 0.75, 0.3);
  box(chair, 0.1, 0.36, 0.1, '#2b2945', 0, 0.2, 0);

  const body = makeCharacter(7, '#ff6fa0');
  body.position.set(x, 0, z + 0.95);
  body.rotation.y = Math.PI;
  const p = body.userData.parts;
  p.legL.rotation.x = p.legR.rotation.x = -Math.PI / 2;
  body.traverse(c => { c.userData.owner = true; });
  world.add(body);

  const label = document.createElement('div');
  label.className = 'floor-label owner';
  label.addEventListener('click', () => document.getElementById('inbox').classList.remove('collapsed'));
  document.getElementById('labels').appendChild(label);
  owner = { name: o.name || 'You', body, screenMat, lamp, lampMat, label, anchor: new THREE.Vector3(x, 0.1, z + 1.9) };
}

/* ================================================================== *
 *  BATTLE WORLD: each project is a battle zone with its own boss,
 *  agents are heroes fighting it.
 * ================================================================== */
const TERRAINS = [
  { name: 'Lava Fields',   ground: '#5a4646', edge: '#3a2c2c', boss: '#8a3424', bossEye: '#ffd23a', decor: 'lava' },
  { name: 'Frost Peaks',   ground: '#dcefff', edge: '#94b9cf', boss: '#4f7fae', bossEye: '#c4f6ff', decor: 'ice' },
  { name: 'Ancient Ruins', ground: '#c2b6a0', edge: '#857a66', boss: '#665f78', bossEye: '#c49bff', decor: 'ruins' },
  { name: 'Wild Forest',   ground: '#86b86e', edge: '#557f43', boss: '#3d5a2c', bossEye: '#eaff5a', decor: 'forest' },
  { name: 'Dune Sea',      ground: '#eccf92', edge: '#bc975c', boss: '#9c5f34', bossEye: '#ff6b3a', decor: 'desert' },
];
let projectiles = [];
let smoke = [];
let campSpot = new THREE.Vector3();
let fireFlames = [];

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function skyTexture(top, bottom) {
  const c = document.createElement('canvas'); c.width = 2; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, top); grd.addColorStop(0.65, '#b0607a'); grd.addColorStop(1, bottom);
  g.fillStyle = grd; g.fillRect(0, 0, 2, 256);
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}
const glow = new Map();
function glowMat(color, opacity) {
  const k = color + (opacity || '');
  if (!glow.has(k)) glow.set(k, new THREE.MeshBasicMaterial(opacity ? { color, transparent: true, opacity, depthWrite: false } : { color }));
  return glow.get(k);
}

function battleLayout(projects) {
  const maxSeats = Math.max(2, ...projects.map(p => Math.min(SEATS_PER_ROW, (p.agents || []).length)));
  const maxRows = Math.max(1, ...projects.map(p => Math.ceil(((p.agents || []).length || 1) / SEATS_PER_ROW)));
  const cellW = Math.max(maxSeats * 1.5 + 2.6, 6);
  const cellD = 4.6 + maxRows * 1.7;
  const gap = 1.4;
  const cols = Math.max(1, Math.ceil(Math.sqrt(projects.length)));
  const rows = Math.max(1, Math.ceil(projects.length / cols));
  const front = 5.5;
  const W = cols * (cellW + gap) + gap;
  const D = rows * (cellD + gap) + gap + front;
  return { cellW, cellD, gap, cols, rows, W, D };
}

function buildBattle(d) {
  if (world) scene.remove(world);
  world = new THREE.Group();
  scene.add(world);
  agents.clear();
  pods = []; projectiles = []; smoke = []; fireFlames = [];
  document.getElementById('labels').innerHTML = '';

  const projects = d.projects || [];
  const L = battleLayout(projects);
  const { W, D } = L;
  const x0 = -W / 2, z0 = -D / 2;
  const rand = seeded(1234);

  scene.background = skyTexture('#3a2a5e', '#ffb27a');
  hemi.color.set('#ffe6cc'); hemi.groundColor.set('#7a5a80'); hemi.intensity = 1.9;
  sun.color.set('#ffc49a'); sun.intensity = 2.3;
  sun.shadow.mapSize.set(2048, 2048);

  // Battlefield ground with a margin of rubble around it
  const groundTex = checkerTexture('#8f7a64', '#86715b');
  groundTex.repeat.set((W + 6) / 2, (D + 6) / 2);
  const ground = new THREE.Mesh(new THREE.BoxGeometry(W + 6, 0.6, D + 6), [
    mat('#5e4b3a'), mat('#5e4b3a'), new THREE.MeshLambertMaterial({ map: groundTex }),
    mat('#5e4b3a'), mat('#5e4b3a'), mat('#5e4b3a'),
  ]);
  ground.position.y = -0.3;
  ground.receiveShadow = true;
  world.add(ground);

  // Ruined city skyline along the back and left edges
  const greys = ['#6e6680', '#625a74', '#7c7390', '#575069'];
  const ruin = (x, z, along) => {
    const h = 1.2 + rand() * 3.8, w = 1.0 + rand() * 0.8;
    const c = greys[Math.floor(rand() * greys.length)];
    const b = new THREE.Group(); b.position.set(x, 0, z); world.add(b);
    const [bw, bd] = along === 'x' ? [w, 1.2] : [1.2, w];
    box(b, bw, h, bd, c, 0, h / 2, 0);
    box(b, bw * 0.55, 0.7 + rand(), bd * 0.6, c, (rand() - 0.5) * 0.3, h + 0.35, 0);   // broken top
    for (let wy = 0.8; wy < h - 0.4; wy += 0.9) {
      const lit = rand() < 0.25;
      const wm = lit ? glowMat('#ffcf6a') : null;
      if (along === 'x') box(b, 0.22, 0.3, 0.04, '#3a344a', (rand() - 0.5) * (bw - 0.4), wy, bd / 2 + 0.01, { material: wm || undefined, cast: false });
      else box(b, 0.04, 0.3, 0.22, '#3a344a', bw / 2 + 0.01, wy, (rand() - 0.5) * (bd - 0.4), { material: wm || undefined, cast: false });
    }
  };
  for (let x = x0 - 2; x < W / 2 + 3; x += 1.5 + rand() * 0.6) ruin(x, z0 - 2.4, 'x');
  for (let z = z0 - 0.5; z < D / 2 + 2; z += 1.5 + rand() * 0.6) ruin(x0 - 2.4, z, 'z');

  // Smoke columns rising from the ruins
  for (let i = 0; i < 4; i++) {
    const sx = x0 + rand() * W, sz = z0 - 2.4;
    for (let k = 0; k < 6; k++) {
      const m = box(world, 0.6, 0.6, 0.6, null, sx, 0, sz, { material: glowMat('#4a4258', 0.55), cast: false });
      smoke.push({ m, base: new THREE.Vector3(sx, 3 + rand() * 2, sz), t: k / 6 });
    }
  }

  // Scattered rocks and craters
  for (let i = 0; i < 26; i++) {
    const x = x0 + rand() * W, z = z0 + rand() * D;
    if (rand() < 0.5) box(world, 0.3 + rand() * 0.4, 0.2 + rand() * 0.3, 0.3 + rand() * 0.4, '#6d5d4e', x, 0.1, z);
    else box(world, 0.9 + rand() * 0.6, 0.03, 0.9 + rand() * 0.6, '#5f4e3e', x, 0.015, z, { cast: false });
  }

  // Battle zones
  projects.forEach((p, i) => {
    const col = i % L.cols, row = Math.floor(i / L.cols);
    const cx = x0 + L.gap + col * (L.cellW + L.gap) + L.cellW / 2;
    const czTop = z0 + L.gap + row * (L.cellD + L.gap);
    buildZone(p, i, cx, czTop, L);
  });

  // Camp (where resting heroes go) and your command post
  const frontZ = D / 2 - 2.6;
  buildCamp(x0 + 3, frontZ);
  buildCommand(d.owner || {}, Math.min(2, W / 2 - 3), frontZ + 0.3);

  const span = Math.max(W, D);
  sun.position.set(-span * 0.5, span * 1.1, span * 0.4);
  sun.target.position.set(0, 0, 0);
  const sc = sun.shadow.camera;
  sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 0.5; sc.far = span * 4;
  sc.updateProjectionMatrix();

  viewSize = span * 0.92;
  world.userData.home = { target: new THREE.Vector3(-1.2, 0, -1.6), dist: span * 2 };
  resetView();
  resize();
}

function banner(parent, x, z, color) {
  box(parent, 0.08, 1.8, 0.08, '#5a4636', x, 0.9 + 0.3, z);
  box(parent, 0.5, 0.35, 0.04, color, x + 0.27, 1.85 + 0.3, z, { cast: false });
}

function zoneDecor(g, T, cx, czTop, zw, zd, rand) {
  const spots = [
    [cx - zw / 2 + 0.6, czTop + 0.6], [cx + zw / 2 - 0.6, czTop + 0.6],
    [cx - zw / 2 + 0.55, czTop + 2.3], [cx + zw / 2 - 0.55, czTop + 2.3],
  ];
  const y = 0.3;
  for (const [x, z] of spots) {
    if (T.decor === 'lava') {
      box(g, 0.5, 0.4, 0.5, '#3a2c2c', x, y + 0.2, z);
      box(g, 0.9 + rand() * 0.6, 0.02, 0.1, null, x + (rand() - 0.5), y + 0.01, z + 0.5, { material: glowMat('#ff7a1a'), cast: false })
        .rotation.y = rand() * Math.PI;
    } else if (T.decor === 'ice') {
      for (let k = 0; k < 3; k++) {
        const h = 0.5 + rand() * 0.9;
        const s = box(g, 0.22, h, 0.22, '#a8e4ff', x + (rand() - 0.5) * 0.5, y + h / 2, z + (rand() - 0.5) * 0.5);
        s.rotation.z = (rand() - 0.5) * 0.5;
      }
    } else if (T.decor === 'ruins') {
      const h = 0.5 + rand() * 1.3;
      box(g, 0.45, h, 0.45, '#ddd4c2', x, y + h / 2, z);
      box(g, 0.6, 0.15, 0.6, '#cfc5b0', x, y + h + 0.07, z);
    } else if (T.decor === 'forest') {
      box(g, 0.2, 0.6, 0.2, '#7a5236', x, y + 0.3, z);
      box(g, 0.9, 0.8, 0.9, '#3f8f45', x, y + 1.0, z);
      box(g, 0.55, 0.5, 0.55, '#58b05d', x + 0.05, y + 1.55, z);
    } else {
      box(g, 0.26, 1.0, 0.26, '#4f9a4a', x, y + 0.5, z);
      box(g, 0.38, 0.16, 0.16, '#4f9a4a', x + 0.18, y + 0.55, z);
      box(g, 0.16, 0.36, 0.16, '#4f9a4a', x + 0.3, y + 0.75, z);
    }
  }
  // a few ground details
  for (let k = 0; k < 3; k++) {
    const x = cx + (rand() - 0.5) * (zw - 1), z = czTop + 3.2 + rand() * (zd - 3.8);
    if (T.decor === 'lava') box(g, 0.8, 0.02, 0.08, null, x, y + 0.01, z, { material: glowMat('#ff8a2a'), cast: false }).rotation.y = rand() * 3;
    else if (T.decor === 'ice') box(g, 0.7, 0.08, 0.5, '#ffffff', x, y + 0.04, z, { cast: false });
    else box(g, 0.25, 0.15, 0.25, shade(T.ground, -0.15), x, y + 0.07, z);
  }
}

function makeBoss(T, seed) {
  const g = new THREE.Group();
  const c = T.boss, dark = shade(c, -0.1), light = shade(c, 0.12);
  const eyeMat = new THREE.MeshBasicMaterial({ color: T.bossEye });
  box(g, 0.5, 0.8, 0.55, dark, -0.42, 0.4, 0);
  box(g, 0.5, 0.8, 0.55, dark, 0.42, 0.4, 0);
  const torso = new THREE.Group(); torso.position.y = 0.8; g.add(torso);
  box(torso, 1.6, 1.25, 1.05, c, 0, 0.62, 0);
  box(torso, 0.9, 0.6, 0.06, light, 0, 0.6, 0.54);
  box(torso, 0.3, 0.3, 0.07, null, 0, 0.62, 0.57, { material: eyeMat, cast: false });   // glowing core
  const armL = new THREE.Group(); armL.position.set(-1.0, 1.1, 0); torso.add(armL);
  const armR = new THREE.Group(); armR.position.set(1.0, 1.1, 0); torso.add(armR);
  for (const arm of [armL, armR]) {
    box(arm, 0.45, 1.0, 0.5, dark, 0, -0.45, 0);
    box(arm, 0.6, 0.5, 0.6, light, 0, -1.1, 0);
  }
  const head = new THREE.Group(); head.position.set(0, 1.25, 0.05); torso.add(head);
  box(head, 0.95, 0.72, 0.85, c, 0, 0.36, 0);
  box(head, 0.2, 0.1, 0.04, null, -0.22, 0.42, 0.44, { material: eyeMat, cast: false });
  box(head, 0.2, 0.1, 0.04, null, 0.22, 0.42, 0.44, { material: eyeMat, cast: false });
  box(head, 0.5, 0.08, 0.04, '#1e1a26', 0, 0.16, 0.44, { cast: false });
  if (seed % 2) {
    box(head, 0.14, 0.45, 0.14, '#f2e8d0', -0.38, 0.85, 0).rotation.z = 0.4;
    box(head, 0.14, 0.45, 0.14, '#f2e8d0', 0.38, 0.85, 0).rotation.z = -0.4;
  } else {
    for (let k = -1; k <= 1; k++) box(torso, 0.22, 0.45, 0.22, light, k * 0.45, 1.35, -0.4).rotation.x = -0.3;
  }
  g.userData = { torso, armL, armR, head, eyeMat, eyeColor: T.bossEye, tilt: 0, hit: 0 };
  return g;
}

function buildZone(project, i, cx, czTop, L) {
  const T = TERRAINS[i % TERRAINS.length];
  const color = project.color || '#b38bff';
  const zw = L.cellW, zd = L.cellD;
  const zc = czTop + zd / 2;
  const g = new THREE.Group(); world.add(g);
  const rand = seeded(hashStr(project.id || project.name || String(i)));

  box(g, zw, 0.3, zd, T.edge, cx, 0.15, zc);
  box(g, zw - 0.25, 0.04, zd - 0.25, T.ground, cx, 0.31, zc, { cast: false });
  box(g, zw, 0.06, 0.2, color, cx, 0.32, czTop + zd - 0.1, { cast: false });
  for (const [bx, bz] of [[cx - zw / 2 + 0.2, czTop + zd - 0.3], [cx + zw / 2 - 0.5, czTop + zd - 0.3]]) banner(g, bx, bz, color);
  zoneDecor(g, T, cx, czTop, zw, zd, rand);

  const boss = makeBoss(T, hashStr(project.id || project.name || 'b'));
  boss.position.set(cx, 0.3, czTop + 1.4);
  g.add(boss);

  const list = project.agents || [];
  const rows = Math.max(1, Math.ceil(list.length / SEATS_PER_ROW));
  const pod = { project, terrain: T, boss, hp: 1, defeated: false, target: new THREE.Vector3(cx, 1.8, czTop + 1.6) };
  for (let r = 0; r < rows; r++) {
    const seats = list.slice(r * SEATS_PER_ROW, (r + 1) * SEATS_PER_ROW);
    seats.forEach((a, k) => {
      const hx = cx + (k - (seats.length - 1) / 2) * 1.5;
      const hz = czTop + 3.8 + r * 1.7;
      buildHero(project, a, hx, hz, pod);
    });
  }

  const label = document.createElement('div');
  label.className = 'floor-label zone';
  label.addEventListener('click', () => focusOn(new THREE.Vector3(cx, 0, zc), null));
  document.getElementById('labels').appendChild(label);
  pod.label = label;
  pod.anchor = new THREE.Vector3(cx, 4.3, czTop + 1.4);
  pods.push(pod);
}

function buildHero(project, a, hx, hz, pod) {
  const seed = hashStr(a.id || a.name || 'x');
  const shirt = a.color || project.color || '#b38bff';
  const body = makeCharacter(seed, shirt);
  body.rotation.order = 'YXZ';
  const { head, armL, armR } = body.userData.parts;

  const cape = new THREE.Group(); cape.position.set(0, 1.0, -0.17); body.add(cape);
  box(cape, 0.52, 0.78, 0.05, shade(shirt, -0.2), 0, -0.38, 0);
  box(head, 0.56, 0.09, 0.54, '#e8c34a', 0, 0.42, 0);

  // Weapon in the right hand: sword, hammer or magic staff
  const kind = seed % 3;
  const weapon = new THREE.Group(); weapon.position.set(0, -0.44, 0.04); armR.add(weapon);
  if (kind === 0) {
    box(weapon, 0.24, 0.07, 0.1, '#e8c34a', 0, -0.06, 0);
    box(weapon, 0.08, 0.72, 0.04, '#e9f1f7', 0, -0.46, 0);
    box(armL, 0.08, 0.42, 0.36, shade(shirt, 0.15), -0.08, -0.32, 0.05);   // shield
  } else if (kind === 1) {
    box(weapon, 0.07, 0.62, 0.07, '#7a5236', 0, -0.25, 0);
    box(weapon, 0.34, 0.24, 0.24, '#9aa3b5', 0, -0.58, 0);
  } else {
    box(weapon, 0.06, 0.95, 0.06, '#7a5236', 0, -0.2, 0);
    box(weapon, 0.18, 0.18, 0.18, null, 0, -0.72, 0, { material: glowMat(shade(shirt, 0.25)), cast: false });
  }

  // Signal beam (needs you), dizzy stars (down), floating bubble
  const beamMat = new THREE.MeshBasicMaterial({ color: STATUS.needs_you.css, transparent: true, opacity: 0.35, depthWrite: false });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.32, 9, 0.32), beamMat);
  beam.position.y = 5.2; beam.visible = false;
  body.add(beam);
  const stars = new THREE.Group(); stars.position.set(0, 1.3, 0.5); stars.visible = false; body.add(stars);
  for (let k = 0; k < 3; k++) {
    const an = k / 3 * Math.PI * 2;
    box(stars, 0.12, 0.12, 0.12, null, Math.cos(an) * 0.32, Math.sin(an) * 0.32, 0, { material: glowMat('#ffe14a'), cast: false });
  }
  const bubble = makeBubble();
  bubble.position.y = 2.0;
  body.add(bubble);
  world.add(body);

  const home = new THREE.Vector3(hx, 0.3, hz);
  const ag = {
    id: a.id, data: a, project, body, bubble, beam, beamMat, stars, pod,
    seat: home, home, baseY: 0.3,
    status: null, path: [], pathIdx: 0, mode: 'home',
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
  for (let k = 0; k < 7; k++) {
    const an = k / 7 * Math.PI * 2;
    box(g, 0.18, 0.14, 0.18, '#8a8090', Math.cos(an) * 0.38, 0.07, Math.sin(an) * 0.38);
  }
  box(g, 0.6, 0.12, 0.14, '#6b4630', 0, 0.1, 0).rotation.y = 0.6;
  box(g, 0.6, 0.12, 0.14, '#6b4630', 0, 0.1, 0).rotation.y = -0.6;
  fireFlames = [
    box(g, 0.3, 0.45, 0.3, null, 0, 0.35, 0, { material: glowMat('#ff7a1a'), cast: false }),
    box(g, 0.18, 0.35, 0.18, null, 0.06, 0.55, 0.04, { material: glowMat('#ffd23a'), cast: false }),
    box(g, 0.14, 0.25, 0.14, null, -0.08, 0.45, -0.06, { material: glowMat('#ffb02a'), cast: false }),
  ];
  // logs to sit on
  for (const [lx, lz, ry] of [[-1.0, 0, Math.PI / 2], [1.0, 0, Math.PI / 2], [0, -1.0, 0], [0, 1.0, 0]]) {
    box(g, 1.0, 0.22, 0.26, '#7a5236', lx, 0.11, lz).rotation.y = ry;
  }
  // tents
  for (const [tx, tz, c] of [[-1.6, -1.4, '#d8c49a'], [1.5, -1.6, '#b85a48']]) {
    const tent = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.2, 4), mat(c));
    tent.position.set(tx, 0.6, tz); tent.rotation.y = Math.PI / 4; tent.castShadow = true;
    g.add(tent);
    box(g, 0.3, 0.5, 0.05, '#3a2c2c', tx, 0.25, tz + 0.6, { cast: false });
  }
  campSpot.set(x, 0, z);
}

function buildCommand(o, x, z) {
  const g = new THREE.Group(); world.add(g);
  const tent = new THREE.Mesh(new THREE.ConeGeometry(1.3, 1.8, 4), mat('#c8433f'));
  tent.position.set(x - 0.4, 0.9, z - 1.5); tent.rotation.y = Math.PI / 4; tent.castShadow = true;
  g.add(tent);
  box(g, 0.08, 2.8, 0.08, '#5a4636', x - 0.4, 1.4, z - 1.5);
  box(g, 0.7, 0.45, 0.04, '#ffd23a', x - 0.02, 2.55, z - 1.5, { cast: false });
  // war table with a glowing map
  box(g, 1.7, 0.1, 1.0, '#7a5236', x, 0.75, z);
  for (const [lx, lz] of [[-0.75, -0.4], [0.75, -0.4], [-0.75, 0.4], [0.75, 0.4]]) box(g, 0.1, 0.72, 0.1, '#5a3a24', x + lx, 0.36, z + lz);
  const screenMat = new THREE.MeshBasicMaterial({ color: '#3ddc84' });
  box(g, 1.5, 0.02, 0.8, null, x, 0.81, z, { material: screenMat, cast: false });
  // the beacon
  box(g, 0.12, 1.6, 0.12, '#4a4058', x + 1.3, 0.8, z);
  const lampMat = new THREE.MeshBasicMaterial({ color: '#ff4d4d' });
  const lamp = box(g, 0.34, 0.34, 0.34, null, x + 1.3, 1.75, z, { material: lampMat, cast: false });

  const body = makeCharacter(7, '#ff6fa0');
  const cape = new THREE.Group(); cape.position.set(0, 1.0, -0.17); body.add(cape);
  box(cape, 0.56, 0.85, 0.05, '#c8433f', 0, -0.4, 0);
  box(body.userData.parts.head, 0.56, 0.09, 0.54, '#ffd23a', 0, 0.42, 0);
  body.position.set(x, 0, z - 0.75);
  body.rotation.y = Math.PI / 5;
  body.userData.parts.armR.rotation.x = -0.9;
  body.traverse(c => { c.userData.owner = true; });
  world.add(body);

  const label = document.createElement('div');
  label.className = 'floor-label owner';
  label.addEventListener('click', () => document.getElementById('inbox').classList.remove('collapsed'));
  document.getElementById('labels').appendChild(label);
  owner = { name: o.name || 'You', body, screenMat, lamp, lampMat, label, anchor: new THREE.Vector3(x, 0.1, z + 1.0) };
}

function setHeroStatus(ag, s) {
  if (ag.status === s) return;
  ag.status = s;
  ag.beam.visible = s === 'needs_you';
  ag.stars.visible = s === 'error';
  const { bang, gem } = ag.bubble.userData;
  ag.bubble.visible = s === 'needs_you' || s === 'done';
  bang.visible = s === 'needs_you';
  gem.visible = s === 'done';
  if (s !== 'idle' && ag.mode !== 'home') walkTo(ag, [ag.home.clone()]);
}

function spawnBolt(ag) {
  const from = ag.body.position.clone().add(new THREE.Vector3(0, 1.0, -0.4));
  const to = ag.pod.target.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, Math.random() * 0.6, 0));
  const c = shade(ag.data.color || ag.project.color || '#ffffff', 0.2);
  const m = new THREE.Mesh(boxGeo(0.2, 0.2, 0.2), glowMat(c));
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
    const dist = delta.length(), step = WALK_SPEED * 1.2 * dt;
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
    const sw = Math.sin(t * 12) * 0.7;
    legL.rotation.x = sw; legR.rotation.x = -sw; armL.rotation.x = -sw; armR.rotation.x = sw;
    y = Math.abs(Math.sin(t * 12)) * 0.05;
  } else if (ag.mode === 'resting') {
    // sitting on a log by the fire
    ag.facing = Math.atan2(campSpot.x - ag.pos.x, campSpot.z - ag.pos.z);
    legL.rotation.x = legR.rotation.x = -Math.PI / 2;
    y = -0.22;
    armL.rotation.x = armR.rotation.x = -1.0 + Math.sin(ph * 1.5) * 0.05;
    head.rotation.x = Math.sin(ph * 0.7) * 0.08;
    if (t > ag.restUntil && ag.status === 'idle') walkTo(ag, [ag.home.clone()]);
  } else {
    ag.pos.copy(ag.home);
    const s = ag.status;
    if (s === 'working') {
      ag.facing = Math.PI;
      const c = (ph * 1.3) % 1;
      armR.rotation.x = c < 0.7 ? -0.4 - 2.6 * (c / 0.7) : -3.0 + 2.6 * ((c - 0.7) / 0.3);
      armL.rotation.x = -0.7;
      legL.rotation.x = 0.35; legR.rotation.x = -0.35;
      if (c > 0.7) ag.pos.z -= Math.sin((c - 0.7) / 0.3 * Math.PI) * 0.3;
      if (c > 0.85 && ag.lastSwing <= 0.85) spawnBolt(ag);
      ag.lastSwing = c;
    } else if (s === 'needs_you') {
      ag.facing = Math.PI / 4;
      y = Math.max(0, Math.sin(ph * 6)) * 0.35;
      armR.rotation.z = 2.7 + Math.sin(ph * 10) * 0.3;
      ag.beamMat.opacity = 0.25 + 0.2 * (0.5 + 0.5 * Math.sin(t * 6));
    } else if (s === 'error') {
      // knocked down, flat on their back
      ag.facing = Math.PI / 4;
      pitch = -Math.PI / 2;
      y = 0.17;
      armL.rotation.z = -1.2; armR.rotation.z = 1.2;
      ag.stars.rotation.z = t * 4;
    } else if (s === 'done') {
      ag.facing = Math.PI / 4;
      armL.rotation.z = -2.6 - Math.sin(ph * 4) * 0.15;
      armR.rotation.z = 2.6 + Math.sin(ph * 4) * 0.15;
      y = Math.max(0, Math.sin(ph * 3)) * 0.12;
    } else {
      // idle: catch breath, then head to camp now and then
      ag.facing = Math.PI;
      armL.rotation.x = armR.rotation.x = -0.15;
      head.rotation.x = 0.15 + Math.sin(ph) * 0.05;
      ag.nextBreak -= dt;
      if (ag.nextBreak <= 0) {
        ag.nextBreak = 14 + Math.random() * 16;
        const an = Math.random() * Math.PI * 2;
        walkTo(ag, [campSpot.clone().add(new THREE.Vector3(Math.cos(an) * 1.0, 0.22, Math.sin(an) * 1.0))]);
      }
    }
  }

  ag.body.position.set(ag.pos.x, ag.pos.y + y, ag.pos.z);
  ag.body.rotation.set(pitch, ag.facing, 0);
  if (ag.bubble.visible) {
    const { bang, gem } = ag.bubble.userData;
    ag.bubble.position.y = 1.95 + Math.sin(t * 4 + ag.phase) * 0.08;
    bang.scale.setScalar(1 + Math.max(0, Math.sin(t * 6)) * 0.15);
    gem.rotation.y = t * 2;
  }
}

function battleTick(dt) {
  // magic bolts flying at the bosses
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.k += dt / 0.45;
    if (p.k >= 1) {
      world.remove(p.m);
      projectiles.splice(i, 1);
      p.pod.boss.userData.hit = 0.18;
      continue;
    }
    p.m.position.lerpVectors(p.from, p.to, p.k);
    p.m.position.y += Math.sin(p.k * Math.PI) * 0.7;
    p.m.rotation.set(t * 8, t * 6, 0);
  }

  // bosses: sway, flinch when hit, fall over when defeated
  for (const pod of pods) {
    const b = pod.boss.userData;
    const ph = t + pod.boss.position.x;
    const goal = pod.defeated ? -1.45 : 0;
    b.tilt += (goal - b.tilt) * Math.min(1, dt * 3);
    pod.boss.rotation.x = b.tilt;
    if (pod.defeated) {
      b.eyeMat.color.set('#3a3346');
      b.armL.rotation.set(0, 0, -0.3); b.armR.rotation.set(0, 0, 0.3);
      continue;
    }
    b.eyeMat.color.set(b.hit > 0 ? '#ffffff' : b.eyeColor);
    b.hit = Math.max(0, b.hit - dt);
    const flinch = b.hit > 0 ? 0.12 : 0;
    b.torso.rotation.x = -flinch + Math.sin(ph * 1.2) * 0.04;
    b.torso.rotation.z = Math.sin(ph * 0.8) * 0.05;
    const slam = Math.max(0, Math.sin(ph * 1.1));
    b.armL.rotation.x = -slam * 1.4;
    b.armR.rotation.x = -Math.max(0, Math.sin(ph * 1.1 + Math.PI)) * 1.4;
    b.head.rotation.y = Math.sin(ph * 0.6) * 0.3;
    pod.boss.scale.setScalar(1 + flinch * 0.3);
  }

  // campfire flicker
  fireFlames.forEach((f, i) => {
    const s = 0.8 + 0.3 * Math.abs(Math.sin(t * (9 + i * 3) + i));
    f.scale.set(1, s, 1);
  });
  // smoke drifting up
  for (const s of smoke) {
    s.t = (s.t + dt * 0.08) % 1;
    s.m.position.set(s.base.x + Math.sin(s.t * 6) * 0.4 + s.t * 1.5, s.base.y + s.t * 6, s.base.z);
    s.m.scale.setScalar(0.6 + s.t * 1.8);
  }
}

/* ------------------------------------------------------------------ *
 *  Applying data
 * ------------------------------------------------------------------ */
function effectiveStatus(a) {
  const s = STATUS[a.status] ? a.status : 'idle';
  if (ALERT_STATUSES.has(s) && handled[handledKey(a)]) return 'idle';
  return s;
}
const handledKey = a => `${a.id}@${a.updated || ''}`;

function applyData(d) {
  data = d;
  const key = JSON.stringify((d.projects || []).map(p => [p.id, p.color, (p.agents || []).map(a => a.id)]));
  if (key !== layoutKey) { layoutKey = key; (BATTLE ? buildBattle : buildWorld)(d); }

  for (const p of d.projects || []) {
    for (const a of p.agents || []) {
      const ag = agents.get(a.id);
      if (!ag) continue;
      ag.data = a; ag.project = p;
      setAgentStatus(ag, effectiveStatus(a));
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
    ? `<div class="ask-who">${esc(a.name)} ${BATTLE ? (s === 'error' ? 'is down!' : 'needs backup!') : (s === 'error' ? 'is stuck' : 'needs you')}</div>
       <div class="ask-what">${esc((a.action && a.action.title) || a.task || 'Take a look')}</div>`
    : `<i class="dot" style="background:${STATUS[s].css}"></i><b>${esc(a.name)}</b><span class="tag-status">${STATUS[s].label}</span>`;
}

function setAgentStatus(ag, s) {
  if (BATTLE) return setHeroStatus(ag, s);
  if (ag.status === s) return;
  ag.status = s;
  const c = STATUS[s].css;
  ag.ledMat.color.set(c);
  ag.screenMat.color.set(s === 'idle' ? '#3a3f55' : shade(c, -0.05));
  const { bang, gem } = ag.bubble.userData;
  ag.bubble.visible = s === 'needs_you' || s === 'error' || s === 'done';
  bang.visible = s === 'needs_you' || s === 'error';
  gem.visible = s === 'done';
  bang.children.forEach(m => { m.material = BUBBLE_MATS[s === 'error' ? 'error' : 'needs_you']; });

  // anyone away from desk heads back unless idle
  if (s !== 'idle' && ag.mode !== 'seated') walkTo(ag, backPath(ag));
}

/* ------------------------------------------------------------------ *
 *  Movement
 * ------------------------------------------------------------------ */
function breakPath(ag) {
  const jitter = new THREE.Vector3((Math.random() - 0.5) * 1.2, 0, (Math.random() - 0.3) * 1.4);
  return [ag.aisle.clone(), new THREE.Vector3(stripX, 0, ag.aisle.z), coffeeSpot.clone().add(jitter)];
}
function backPath(ag) {
  const here = ag.pos.clone();
  if (Math.abs(here.x - ag.seat.x) < 0.05 && here.z <= ag.aisle.z + 0.05) return [ag.seat.clone()];
  if (Math.abs(here.z - ag.aisle.z) < 0.05) return [ag.aisle.clone(), ag.seat.clone()];
  return [new THREE.Vector3(stripX, 0, here.z), new THREE.Vector3(stripX, 0, ag.aisle.z), ag.aisle.clone(), ag.seat.clone()];
}
function walkTo(ag, path) { ag.path = path; ag.pathIdx = 0; ag.mode = 'walking'; }

/* ------------------------------------------------------------------ *
 *  Animation
 * ------------------------------------------------------------------ */
const clock = new THREE.Clock();
let t = 0;

function animateAgent(ag, dt) {
  const { legL, legR, armL, armR, head } = ag.body.userData.parts;
  const ph = t * 1 + ag.phase;
  let y = 0;

  if (ag.mode === 'walking') {
    const target = ag.path[ag.pathIdx];
    const delta = target.clone().sub(ag.pos); delta.y = 0;
    const dist = delta.length();
    const step = WALK_SPEED * dt;
    if (dist <= step) {
      ag.pos.copy(target);
      ag.pathIdx++;
      if (ag.pathIdx >= ag.path.length) {
        const atSeat = ag.pos.distanceTo(ag.seat) < 0.05;
        ag.mode = atSeat ? 'seated' : 'standing';
        ag.standUntil = t + 3 + Math.random() * 4;
      }
    } else {
      ag.pos.add(delta.multiplyScalar(step / dist));
      ag.facing = Math.atan2(delta.x, delta.z);
    }
    const sw = Math.sin(t * 12) * 0.6;
    legL.rotation.x = sw; legR.rotation.x = -sw;
    armL.rotation.x = -sw; armR.rotation.x = sw;
    armL.rotation.z = armR.rotation.z = 0;
    y = Math.abs(Math.sin(t * 12)) * 0.05;
  } else if (ag.mode === 'standing') {
    // chatting at the coffee bar
    legL.rotation.x = legR.rotation.x = 0;
    armL.rotation.x = -0.9 + Math.sin(ph * 2) * 0.1; armR.rotation.x = 0;
    armL.rotation.z = armR.rotation.z = 0;
    ag.facing = Math.PI / 4 + Math.sin(ph * 0.5) * 0.6;
    if (t > ag.standUntil) walkTo(ag, backPath(ag));
  } else {
    // seated
    ag.pos.copy(ag.seat);
    if (ag.status === 'needs_you' || ag.status === 'error') {
      // stand up beside the chair, face the camera, jump and wave
      ag.pos.set(ag.seat.x + 0.45, 0, ag.seat.z + 0.35);
      ag.facing = Math.PI / 4;
      legL.rotation.x = legR.rotation.x = 0;
      const jump = ag.status === 'needs_you' ? Math.max(0, Math.sin(ph * 6)) * 0.35 : 0;
      y = jump;
      armR.rotation.z = 2.6 + Math.sin(ph * 10) * 0.35;
      armR.rotation.x = 0;
      armL.rotation.z = ag.status === 'error' ? -0.4 : 0; armL.rotation.x = ag.status === 'error' ? -2.6 : 0;
      head.rotation.z = ag.status === 'error' ? Math.sin(ph * 3) * 0.15 : 0;
    } else {
      ag.facing = Math.PI;
      legL.rotation.x = legR.rotation.x = -Math.PI / 2;
      armL.rotation.z = armR.rotation.z = 0;
      head.rotation.z = 0;
      if (ag.status === 'working') {
        armL.rotation.x = -1.2 + Math.sin(ph * 18) * 0.12;
        armR.rotation.x = -1.2 + Math.cos(ph * 18) * 0.12;
        head.rotation.x = Math.sin(ph * 1.5) * 0.06;
        // screen flicker = "typing"
        const k = 0.8 + 0.2 * Math.sin(ph * 25 + Math.sin(ph * 7));
        ag.screenMat.color.set(STATUS.working.css).multiplyScalar(k);
      } else if (ag.status === 'done') {
        // leaning back, arms behind head
        armL.rotation.x = armR.rotation.x = -2.8;
        head.rotation.x = -0.25;
      } else {
        armL.rotation.x = armR.rotation.x = -0.3;
        head.rotation.x = 0.2 + Math.sin(ph * 0.8) * 0.05;
        ag.nextBreak -= dt;
        if (ag.status === 'idle' && ag.nextBreak <= 0) {
          ag.nextBreak = 12 + Math.random() * 18;
          walkTo(ag, breakPath(ag));
        }
      }
    }
  }

  // Seated characters sit on the chair (hips at seat height)
  ag.body.position.set(ag.pos.x, y, ag.pos.z);
  ag.body.rotation.y = ag.facing;

  if (ag.bubble.visible) {
    const { bang, gem } = ag.bubble.userData;
    ag.bubble.position.y = 1.95 + Math.sin(t * 4 + ag.phase) * 0.08;
    ag.bubble.rotation.y = -ag.facing + Math.PI / 4;
    bang.scale.setScalar(ag.status === 'needs_you' ? 1 + Math.max(0, Math.sin(t * 6)) * 0.15 : 1);
    gem.rotation.y = t * 2;
  }
  if (ag.status === 'needs_you' || ag.status === 'error') {
    ag.ledMat.color.set(STATUS[ag.status].css).multiplyScalar(Math.sin(t * 8) > 0 ? 1 : 0.35);
  }
}

const tmp = new THREE.Vector3();
const tagPos = new THREE.Vector3();
function placeLabel(v, el) {
  tmp.copy(v).project(camera);
  const vis = tmp.z > -1 && tmp.z < 1;
  el.style.display = vis ? '' : 'none';
  el.style.left = ((tmp.x + 1) / 2 * window.innerWidth).toFixed(0) + 'px';
  el.style.top = ((1 - tmp.y) / 2 * window.innerHeight).toFixed(0) + 'px';
}

// Name tags follow their agent; speech bubbles stack upward instead of overlapping.
function placeAgentTags() {
  const showNames = camera.zoom >= (COZY ? 0.85 : 1.3);
  const bubbles = [];
  agents.forEach(ag => {
    if (!ag.tag) return;
    const alert = ALERT_STATUSES.has(ag.status);
    if (!alert && !showNames) { ag.tag.style.display = 'none'; return; }
    tagPos.set(ag.body.position.x, (ag.baseY || 0) + (alert ? 2.5 : 1.75), ag.body.position.z);
    if (!alert) { placeLabel(tagPos, ag.tag); return; }
    tmp.copy(tagPos).project(camera);
    bubbles.push({ ag, x: (tmp.x + 1) / 2 * window.innerWidth, y: (1 - tmp.y) / 2 * window.innerHeight, vis: tmp.z > -1 && tmp.z < 1 });
  });
  bubbles.sort((a, b) => b.y - a.y);   // lowest on screen keeps its spot
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
    const el = b.ag.tag;
    el.style.display = b.vis ? '' : 'none';
    el.style.left = b.x.toFixed(0) + 'px';
    el.style.top = y.toFixed(0) + 'px';
  }
}

let camGoal = null;
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.1);
  t += dt;

  if (demoOn) demoTick(dt);
  agents.forEach(ag => (BATTLE ? animateHero : animateAgent)(ag, dt));
  if (BATTLE) battleTick(dt);

  if (owner) {
    const n = inboxItems().length;
    owner.lampMat.color.set(n ? (Math.sin(t * 6) > 0 ? '#ff4d4d' : '#5a1f2a') : '#2b5a3a');
    owner.screenMat.color.set(n ? '#ff7a7a' : '#3ddc84');
  }
  if (world && world.userData.clockHand) {
    const now = new Date();
    world.userData.clockHand.rotation.x = -(now.getMinutes() + now.getSeconds() / 60) / 60 * Math.PI * 2;
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

  renderer.render(scene, camera);
}

function resetView() {
  const h = world.userData.home;
  controls.target.copy(h.target);
  camera.position.copy(h.target).addScaledVector(CAM_DIR, h.dist);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  camGoal = null;
}
function focusOn(v, zoom) {
  camGoal = { target: v.clone().setY(0.6), zoom: zoom || Math.max(camera.zoom, 1.8) };
}

/* ------------------------------------------------------------------ *
 *  HUD: stats, inbox, agent card
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
    `<span class="stat">${projects} project${projects === 1 ? '' : 's'}</span>` +
    Object.keys(STATUS).filter(s => counts[s]).map(s =>
      `<span class="stat"><i class="dot" style="background:${STATUS[s].css}"></i>${counts[s]} ${STATUS[s].label.toLowerCase()}</span>`).join('');

  const items = inboxItems();
  const badge = document.getElementById('inbox-count');
  badge.textContent = items.length;
  badge.classList.toggle('zero', !items.length);
  const ul = document.getElementById('inbox-list');
  ul.innerHTML = items.length ? '' : `<li class="empty">${BATTLE ? 'All quiet on the battlefield ⚔️' : 'All clear. Nobody needs you right now ☕'}</li>`;
  for (const { a, p } of items) {
    const li = document.createElement('li');
    const s = effectiveStatus(a);
    li.innerHTML = `<div class="who"><i class="dot" style="background:${STATUS[s].css}"></i>${esc(p.name)} · ${esc(a.name)}</div>
      <div class="what">${esc((a.action && a.action.title) || a.task || STATUS[s].label)}</div>`;
    li.addEventListener('click', () => { openCard(a.id); const ag = agents.get(a.id); if (ag) focusOn(ag.seat, 1.7); });
    ul.appendChild(li);
  }

  document.title = items.length ? `(${items.length}) ${APP_NAME}` : APP_NAME;

  for (const pd of pods) {
    const n = (pd.project.agents || []).filter(a => ALERT_STATUSES.has(effectiveStatus(a))).length;
    if (BATTLE) {
      const list = pd.project.agents || [];
      const prog = list.length ? list.reduce((sum, a) => sum + (effectiveStatus(a) === 'done' ? 1 : Math.max(0, Math.min(1, +a.progress || 0))), 0) / list.length : 0;
      pd.hp = 1 - prog;
      pd.defeated = list.length > 0 && list.every(a => effectiveStatus(a) === 'done');
      pd.label.innerHTML = `<div class="zone-name">${esc(pd.project.name)}${n ? `<span class="alert">!${n}</span>` : ''}</div>
        <div class="zone-sub">${pd.defeated ? '🏆 Boss defeated!' : `${esc(pd.terrain.name)} boss · ${Math.round(pd.hp * 100)}% HP`}</div>
        <div class="hp"><span style="width:${(pd.hp * 100).toFixed(0)}%"></span></div>`;
    } else {
      pd.label.innerHTML = `${esc(pd.project.name)}${n ? `<span class="alert">!${n}</span>` : ''}`;
    }
    if (!COZY) pd.label.style.borderColor = '#0e0d1a';
    pd.label.style.background = pd.project.color || '';
    pd.label.style.color = '#1b1a2e';
  }
  if (owner) {
    owner.label.textContent = items.length ? `${owner.name}: ${items.length} need${items.length === 1 ? 's' : ''} you` : `${owner.name}: all clear`;
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
  const card = document.getElementById('card');
  document.getElementById('card-name').textContent = a.name;
  let html = `<div class="row">${esc(a.role || 'Agent')} · <b>${esc(p.name)}</b></div>
    <span class="pill" style="background:${STATUS[s].css}">${STATUS[s].label}</span>
    <div class="row">Task: <b>${esc(a.task || '—')}</b></div>
    <div class="bar"><span style="width:${pct}%"></span></div>
    <div class="row">Progress <b>${pct}%</b>${a.updated ? ` · updated <b>${ago(a.updated)}</b>` : ''}</div>`;
  if (ALERT_STATUSES.has(s)) {
    const act = a.action || {};
    html += `<div class="action ${s === 'error' ? 'err' : ''}">
      <h3>${esc(act.title || (s === 'error' ? 'Something broke' : 'Needs your input'))}</h3>
      ${act.detail ? `<div>${esc(act.detail)}</div>` : ''}
      ${safeLink(act.link) ? `<div><a href="${esc(act.link)}" target="_blank" rel="noopener">Open →</a></div>` : ''}
      <button class="pix-btn primary" id="btn-handled">✓ Mark handled</button>
    </div>`;
  } else if (handled[handledKey(a)]) {
    html += `<div class="row" style="margin-top:8px">You marked this handled.</div>`;
  }
  document.getElementById('card-body').innerHTML = html;
  const btn = document.getElementById('btn-handled');
  if (btn) btn.addEventListener('click', () => {
    handled[handledKey(a)] = true; store.set('handled', handled);
    const ag = agents.get(a.id); if (ag) { setAgentStatus(ag, effectiveStatus(a)); updateTag(ag); }
    renderHud(); openCard(a.id);
  });
  card.hidden = false;
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
 *  Alerts: browser notifications + 8-bit chime
 * ------------------------------------------------------------------ */
let seenAlerts = null;
let audioCtx = null;
window.addEventListener('pointerdown', () => {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* no audio */ }
});
function chime() {
  if (!soundOn || !audioCtx) return;   // browsers only allow audio after a click
  try {
    [880, 1175, 1568].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = f;
      const t0 = audioCtx.currentTime + i * 0.09;
      g.gain.setValueAtTime(0.06, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.13);
    });
  } catch { /* audio blocked */ }
}
function notifyNew() {
  const items = inboxItems();
  const keys = new Set(items.map(x => handledKey(x.a)));
  if (seenAlerts === null) { seenAlerts = keys; return; }  // don't alert on first load
  const fresh = items.filter(x => !seenAlerts.has(handledKey(x.a)));
  seenAlerts = keys;
  if (!fresh.length) return;
  chime();
  const first = fresh[0];
  const msg = `${first.a.name} (${first.p.name}): ${(first.a.action && first.a.action.title) || first.a.task || 'needs you'}`;
  toast('🔔 ' + msg + (fresh.length > 1 ? ` +${fresh.length - 1} more` : ''));
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification('An agent needs you', { body: msg, tag: 'pixel-office' }); } catch { /* ignore */ }
  }
}
let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

/* ------------------------------------------------------------------ *
 *  Demo mode: shuffles statuses so you can watch the office live
 * ------------------------------------------------------------------ */
let demoOn = params.has('demo');
let demoClock = 2;
const DEMO_ASKS = ['Approve the draft', 'Pick between two options', 'Review the PR', 'Confirm the budget', 'Answer a quick question'];
function demoTick(dt) {
  demoClock -= dt;
  if (demoClock > 0 || !data) return;
  demoClock = 3 + Math.random() * 3;
  const list = allAgents(); if (!list.length) return;
  const { a } = list[Math.floor(Math.random() * list.length)];
  const r = Math.random();
  a.status = r < 0.4 ? 'working' : r < 0.6 ? 'idle' : r < 0.82 ? 'needs_you' : r < 0.92 ? 'done' : 'error';
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
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(world ? world.children : [], true);
  for (const h of hits) {
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
  if (hit && hit.agentId) { openCard(hit.agentId); focusOn(agents.get(hit.agentId).seat, 1.7); }
  else if (hit && hit.owner) document.getElementById('inbox').classList.remove('collapsed');
  else closeCard();
});
const tip = document.getElementById('tooltip');
canvas.addEventListener('pointermove', e => {
  if (e.buttons) { tip.hidden = true; return; }
  const hit = pick(e);
  const ag = hit && hit.agentId && agents.get(hit.agentId);
  if (ag) {
    tip.textContent = `${ag.data.name} · ${STATUS[ag.status].label}`;
    tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
    tip.hidden = false; canvas.style.cursor = 'pointer';
  } else { tip.hidden = true; canvas.style.cursor = ''; }
});

document.getElementById('card-close').addEventListener('click', closeCard);
document.getElementById('inbox-toggle').addEventListener('click', () => {
  const box = document.getElementById('inbox');
  box.classList.toggle('collapsed');
  document.getElementById('inbox-toggle').textContent = box.classList.contains('collapsed') ? '+' : '–';
});
document.getElementById('btn-reset').addEventListener('click', resetView);

const demoBtn = document.getElementById('btn-demo');
const syncDemo = () => { demoBtn.classList.toggle('on', demoOn); demoBtn.textContent = demoOn ? '■ Demo' : '▶ Demo'; };
demoBtn.addEventListener('click', () => { demoOn = !demoOn; syncDemo(); if (!demoOn) load(); });
syncDemo();

const soundBtn = document.getElementById('btn-sound');
const syncSound = () => { soundBtn.classList.toggle('on', soundOn); soundBtn.textContent = soundOn ? '🔊 Sound' : '🔈 Muted'; };
soundBtn.addEventListener('click', () => { soundOn = !soundOn; store.set('sound', soundOn); syncSound(); if (soundOn) chime(); });
syncSound();

const notifyBtn = document.getElementById('btn-notify');
const syncNotify = () => {
  const ok = 'Notification' in window;
  notifyBtn.classList.toggle('on', ok && Notification.permission === 'granted');
  notifyBtn.disabled = !ok;
  notifyBtn.title = ok ? 'Get a desktop notification when an agent needs you and this tab is in the background' : 'Notifications not supported';
};
notifyBtn.addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') { toast('Desktop alerts are on'); return; }
  await Notification.requestPermission(); syncNotify();
});
syncNotify();

const styleBtn = document.getElementById('btn-style');
styleBtn.textContent = COZY ? '👾 Pixel look' : '🧸 Cozy look';
styleBtn.addEventListener('click', () => {
  store.set('style', COZY ? 'pixel' : 'cozy');
  const u = new URL(location.href); u.searchParams.delete('style'); location.href = u.toString();
});

const themeBtn = document.getElementById('btn-theme');
themeBtn.textContent = BATTLE ? '🏢 Office' : '⚔️ Battle';
themeBtn.addEventListener('click', () => {
  store.set('theme', BATTLE ? 'office' : 'battle');
  const u = new URL(location.href); u.searchParams.delete('theme'); location.href = u.toString();
});

const legend = document.getElementById('legend');
legend.innerHTML = Object.values(STATUS).map(s => `<span><i class="dot" style="background:${s.css}"></i>${s.label}</span>`).join('');

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
    console.warn('office: data load failed', err);
  }
}

resize();
loop();
load();
setInterval(load, POLL_MS);
