import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import wasmBinary from 'manifold-3d/manifold.wasm';
import * as C from './core.js';

const $ = id => document.getElementById(id);
const fmt = x => x.toFixed(2).replace('.', ',').replace(/,?0+$/, '');

/* ----------------------------------------------------------- Szene ---- */

const cv = $('cv');
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
camera.up.set(0, 0, 1); // 3D-Druck-Konvention: Z zeigt nach oben
camera.position.set(100, -140, 100);
const controls = new OrbitControls(camera, cv);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
scene.add(new THREE.AmbientLight(0xffffff, 0.75));
const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(headlight, headlight.target);
const fill = new THREE.DirectionalLight(0x9ab8ff, 0.5);
fill.position.set(-1, 1, -1);
scene.add(fill);

const modelMat = new THREE.MeshStandardMaterial({
  color: 0xb7c0cf, roughness: 0.65, metalness: 0.05, flatShading: true,
  side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
const mesh = new THREE.Mesh(new THREE.BufferGeometry(), modelMat);
scene.add(mesh);

const overlayMat = color => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
});
const hoverMesh = new THREE.Mesh(new THREE.BufferGeometry(), overlayMat(0xffa42e));
const selMesh = new THREE.Mesh(new THREE.BufferGeometry(), overlayMat(0x3da5ff));
hoverMesh.raycast = selMesh.raycast = () => {};
scene.add(hoverMesh, selMesh);

const ghostMat = new THREE.MeshBasicMaterial({ color: 0xff4d5e, transparent: true, opacity: 0.42, depthWrite: false });
const ghost = new THREE.Mesh(new THREE.BufferGeometry(), ghostMat);
ghost.raycast = () => {};
ghost.visible = false;
scene.add(ghost);

const coneGroup = new THREE.Group();
const coneMat = new THREE.MeshBasicMaterial({ color: 0xff4d5e, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
scene.add(coneGroup);
function setCones(list) {
  coneGroup.children.slice().forEach(m => { m.geometry.dispose(); coneGroup.remove(m); });
  for (const [o, d, r, c, a] of list) {
    const m = new THREE.Mesh(C.chamferGhostGeo(o, d, r, c, a), coneMat);
    m.raycast = () => {};
    coneGroup.add(m);
  }
}
const ghost2 = new THREE.Mesh(new THREE.BufferGeometry(), ghostMat);
ghost2.raycast = () => {};
ghost2.visible = false;
scene.add(ghost2);
const SINK_PRESETS = {
  cone: [['M3', 3.4, 6.6], ['M4', 4.5, 8.8], ['M5', 5.5, 10.8], ['M6', 6.6, 13.2], ['M8', 9, 17.5]],
  cyl: [['M3', 3.4, 6, 3.4], ['M4', 4.5, 7.5, 4.4], ['M5', 5.5, 9, 5.4], ['M6', 6.6, 10.8, 6.4], ['M8', 9, 14, 8.4]],
};
const sinkOK = () => S.sink !== 'none' && S.sd > S.d + 0.05 && (S.sink === 'cone' ? S.sa >= 30 && S.sa <= 140 : S.sh > 0);
const coneDepth = () => (S.sd - S.d) / 2 / Math.tan(THREE.MathUtils.degToRad(S.sa / 2));
let grid = null, axes = null;

function resize() {
  const r = cv.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  headlight.position.copy(camera.position);
  headlight.target.position.copy(controls.target);
  renderer.render(scene, camera);
})();

/* --------------------------------------------------------- Zustand ---- */

const S = {
  g: null, an: null, detect: null, solid: null,
  original: null, undo: [], redo: [], name: 'modell',
  mode: 'idle',            // idle | hole | resize | new | move | chamfer
  hole: null,              // ausgewählte Bohrung
  anchor: null,            // {point, normal} für neue Bohrung
  d: 5, depth: 5, through: true, step: 0.5, mv: [0, 0, 0],
  ch: 0, ang: 45, chBack: false, chEnds: [true, true],
  sink: 'none', sd: 6.6, sa: 90, sh: 3.4,
};

function solidTest() { return S.solid || (S.solid = C.makeSolidTest(S.g)); }
function endsOf(h) { return h.ends || (h.ends = C.openEnds(h, solidTest())); }

function trisGeometry(tris) {
  const idx = S.g.index.array, pos = S.g.attributes.position.array;
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) out[i * 9 + k * 3 + c] = pos[idx[3 * t + k] * 3 + c];
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g;
}

function setOverlay(m, hole) {
  m.geometry.dispose();
  m.geometry = hole ? trisGeometry(hole.tris) : new THREE.BufferGeometry();
  m.visible = !!hole;
}

function setGeometry(g, first) {
  S.g = g;
  S.an = C.analyze(g);
  S.detect = C.makeDetector(g, S.an);
  S.solid = null;
  mesh.geometry = g;
  S.hole = null; hoverHole = null;
  setOverlay(hoverMesh, null); setOverlay(selMesh, null);
  ghost.visible = false; ghost2.visible = false; setCones([]);
  S.mode = 'idle'; S.anchor = null;
  if (first) {
    const bb = g.boundingBox, size = bb.getSize(new THREE.Vector3());
    if (grid) scene.remove(grid);
    const span = Math.ceil(Math.max(size.x, size.y) * 1.6 / 10) * 10;
    grid = new THREE.GridHelper(span, span / 10, 0x3a4252, 0x252b36);
    grid.rotation.x = Math.PI / 2;
    grid.position.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.min.z - 0.05);
    scene.add(grid);
    if (axes) scene.remove(axes);
    axes = new THREE.AxesHelper(Math.max(10, Math.min(size.x, size.y, size.z) * 0.4));
    axes.position.copy(bb.min);
    scene.add(axes);
    setView('iso');
  }
  renderPanel();
  updateButtons();
}

function updateButtons() {
  $('bUndo').disabled = !S.undo.length;
  $('bRedo').disabled = !S.redo.length;
  $('bReset').disabled = !S.undo.length;
  $('bSave').disabled = !S.g;
}

/* ----------------------------------------------------------- Ansicht --- */

function setView(name) {
  if (!S.g) return;
  const bb = S.g.boundingBox, c = bb.getCenter(new THREE.Vector3());
  const r = S.g.boundingSphere.radius;
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  const dirs = { iso: [0.8, -1.1, 0.75], top: [0, -0.0001, 1], front: [0, -1, 0], right: [1, 0, 0] };
  const d = new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize();
  camera.position.copy(c).addScaledVector(d, dist);
  controls.target.copy(c);
  camera.near = Math.max(0.05, r / 500);
  camera.far = r * 40;
  camera.updateProjectionMatrix();
  controls.update();
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));

/* ------------------------------------------------------ Mausabfrage ---- */

const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;
const ndc = new THREE.Vector2();

function pick(ev) {
  if (!S.g) return null;
  const r = cv.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(mesh, false)[0];
  if (!hit || hit.face.normal.dot(raycaster.ray.direction) > 0) return null;
  const hole = S.detect(hit.faceIndex);
  return { point: hit.point.clone(), normal: hit.face.normal.clone().normalize(), tri: hit.faceIndex, hole };
}

function describe(h) {
  if (!h) return '';
  if (h.partial) return `Rundung Ø ${fmt(h.radius * 2)} mm (keine vollständige Bohrung)`;
  if (!h.concave) return `Zapfen Ø ${fmt(h.radius * 2)} mm`;
  const e = endsOf(h);
  const kind = e[0] && e[1] ? 'durchgehend' : (e[0] || e[1]) ? 'Sackloch' : 'innenliegend';
  const dia = h.uniform ? `Ø ${fmt(h.radius * 2)} mm` : `Ø ${fmt(h.rmin * 2)}–${fmt(h.rmax * 2)} mm (mit Fase/Nut)`;
  return `Bohrung ${dia} · ${fmt(h.length)} mm lang · ${kind}`;
}
const isHole = h => h && h.concave && !h.partial;

let hoverHole = null, lastMove = 0;
const tip = $('tip');
cv.addEventListener('pointermove', ev => {
  if (ev.buttons || !S.g) { tip.style.display = 'none'; return; }
  const now = performance.now();
  if (now - lastMove < 30) return;
  lastMove = now;
  const p = pick(ev);
  const h = p && p.hole;
  if (h !== hoverHole) {
    hoverHole = h;
    setOverlay(hoverMesh, h && h !== S.hole ? h : null);
  }
  cv.style.cursor = isHole(h) ? 'pointer' : S.mode === 'new' ? 'crosshair' : 'default';
  if (h) {
    tip.textContent = describe(h);
    tip.style.display = 'block';
    tip.style.left = ev.clientX + 16 + 'px';
    tip.style.top = ev.clientY + 16 + 'px';
  } else tip.style.display = 'none';
});
cv.addEventListener('pointerleave', () => { tip.style.display = 'none'; });

let down = null;
cv.addEventListener('pointerdown', ev => { down = { x: ev.clientX, y: ev.clientY, b: ev.button }; hideMenu(); });
cv.addEventListener('pointerup', ev => {
  if (!down || down.b !== 0 || Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return;
  const p = pick(ev);
  if (S.mode === 'new') {
    if (p) { S.anchor = { point: p.point, normal: p.normal }; updateGhost(); renderPanelInfo(); }
    return;
  }
  if (p && isHole(p.hole)) selectHole(p.hole);
  else if (S.mode !== 'idle') cancelMode();
});

function selectHole(h) {
  S.hole = h;
  S.mode = 'hole';
  setOverlay(selMesh, h);
  setOverlay(hoverMesh, null);
  ghost.visible = false;
  renderPanel();
}

function cancelMode() {
  S.mode = 'idle'; S.hole = null; S.anchor = null;
  setOverlay(selMesh, null);
  ghost.visible = false; ghost2.visible = false; setCones([]);
  renderPanel();
}

/* ------------------------------------------------------ Kontextmenü ---- */

const menu = $('menu');
function hideMenu() { menu.style.display = 'none'; }
cv.addEventListener('contextmenu', ev => {
  ev.preventDefault();
  if (!S.g) return;
  if (down && down.b === 2 && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) return; // war Verschieben
  const p = pick(ev);
  if (!p) { hideMenu(); return; }
  if (isHole(p.hole)) selectHole(p.hole);
  const items = [];
  if (isHole(p.hole)) {
    items.push(['🔴  Bohrung schließen', () => doClose(p.hole)]);
    items.push(['↔  Durchmesser ändern…', () => startResize(p.hole)]);
    items.push(['✥  Verschieben…', () => startMove(p.hole)]);
    items.push(['◢  Fase anbringen…', () => startChamfer(p.hole)]);
  }
  items.push(['➕  Neue Bohrung hier…', () => startNew(p)]);
  menu.innerHTML = `<div class="head">${p.hole ? describe(p.hole) : 'Fläche'}</div>`;
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { hideMenu(); fn(); };
    menu.appendChild(b);
  }
  menu.style.display = 'block';
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(ev.clientX, innerWidth - w - 8) + 'px';
  menu.style.top = Math.min(ev.clientY, innerHeight - h - 8) + 'px';
});
addEventListener('pointerdown', ev => { if (!menu.contains(ev.target)) hideMenu(); });
cv.addEventListener('wheel', hideMenu);

/* ---------------------------------------------------------- Aktionen --- */

const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 20)));

async function commit(label, fn) {
  toast('Rechne …');
  await nextFrame();
  try {
    const before = S.g;
    const ng = fn();
    S.undo.push(before);
    if (S.undo.length > 25) S.undo.shift();
    S.redo = [];
    setGeometry(ng);
    const ok = S.an.watertight;
    toast(label + (ok ? ' ✓' : ' – Achtung: Netz hat offene Kanten'), ok ? 'ok' : 'bad');
  } catch (e) {
    console.error(e);
    toast('Das hat nicht geklappt: ' + e.message, 'bad', 6000);
    renderPanel();
  }
}

function doClose(h) { commit('Bohrung geschlossen', () => C.closeHole(S.g, h)); }

function startResize(h) {
  S.hole = h; S.mode = 'resize';
  S.d = +((h.uniform ? h.radius : h.rmax) * 2).toFixed(2);
  setOverlay(selMesh, h);
  renderPanel();
  updateGhost();
}

function startMove(h) {
  S.hole = h; S.mode = 'move'; S.mv = [0, 0, 0];
  setOverlay(selMesh, h);
  renderPanel();
  updateGhost();
}

function startChamfer(h) {
  const e = endsOf(h);
  if (!e[0] && !e[1]) return toast('Diese Bohrung hat keine offene Seite – eine Fase gibt es nur am Lochrand.', 'bad', 5000);
  S.hole = h; S.mode = 'chamfer';
  if (!(S.ch > 0)) S.ch = 0.5;
  S.chEnds = [e[0], e[1]];
  setOverlay(selMesh, h);
  renderPanel();
  updateGhost();
}

function endLabel(h, i) {
  const o = C.holeEnd(h, i).origin;
  return `X ${fmt(o.x)} · Y ${fmt(o.y)} · Z ${fmt(o.z)}`;
}

function startNew(p) {
  S.mode = 'new';
  S.hole = null; setOverlay(selMesh, null);
  S.anchor = { point: p.point, normal: p.normal };
  if (S.d <= 0) S.d = 5;
  renderPanel();
  updateGhost();
}

function thickness(a) {
  const rc = new THREE.Raycaster(a.point.clone().addScaledVector(a.normal, -0.01), a.normal.clone().negate());
  rc.firstHitOnly = true;
  const hit = rc.intersectObject(mesh, false)[0];
  return hit ? hit.distance + 0.01 : null;
}

function updateGhost() {
  ghost.geometry.dispose();
  ghost2.visible = false;
  if (S.mode !== 'chamfer') setCones([]);
  if (S.mode === 'resize' && S.hole) {
    const h = S.hole, e = endsOf(h);
    const s0 = e[0] ? 0.4 : 0, s1 = e[1] ? 0.4 : 0;
    ghost.geometry = C.cylinderGeo(S.d / 2, h.length + s0 + s1, h.base.clone().addScaledVector(h.axis, -s0), h.axis);
    ghost.visible = S.d > 0;
  } else if (S.mode === 'chamfer' && S.hole) {
    ghost.visible = false;
    const list = [];
    if (S.ch > 0 && S.ang >= 5 && S.ang <= 85) for (const i of [0, 1]) if (S.chEnds[i]) {
      const e = C.holeEnd(S.hole, i);
      list.push([e.origin, e.dir, e.r, S.ch, S.ang]);
    }
    setCones(list);
    return;
  } else if (S.mode === 'move' && S.hole) {
    ghost.geometry = C.holeGhostGeo(S.hole, new THREE.Vector3(...S.mv), endsOf(S.hole));
    ghost.visible = S.mv.some(v => v !== 0);
  } else if (S.mode === 'new' && S.anchor) {
    const a = S.anchor, th = thickness(a);
    const len = S.through ? (th ?? 20) + 0.6 : S.depth;
    ghost.geometry = C.cylinderGeo(S.d / 2, len + 0.3, a.point.clone().addScaledVector(a.normal, 0.3), a.normal.clone().negate());
    ghost.visible = S.d > 0;
    if (sinkOK()) {
      const inward = a.normal.clone().negate();
      if (S.sink === 'cone') setCones([[a.point, inward, S.d / 2, (S.sd - S.d) / 2, S.sa / 2]]);
      else {
        setCones([]);
        ghost2.geometry.dispose();
        ghost2.geometry = C.cylinderGeo(S.sd / 2, S.sh + 0.3, a.point.clone().addScaledVector(a.normal, 0.3), inward);
        ghost2.visible = true;
      }
    } else if (S.sink === 'none' && S.ch > 0 && S.ang >= 5 && S.ang <= 85) {
      const list = [[a.point, a.normal.clone().negate(), S.d / 2, S.ch, S.ang]];
      if (S.through && S.chBack && th) list.push([a.point.clone().addScaledVector(a.normal, -th), a.normal.clone(), S.d / 2, S.ch, S.ang]);
      setCones(list);
    } else setCones([]);
  } else ghost.visible = false;
}

function nudge(du, dv) {
  const a = S.anchor, n = a.normal;
  const h = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const t1 = new THREE.Vector3().crossVectors(h, n).normalize(); // „rechts“ auf der Fläche
  const t2 = new THREE.Vector3().crossVectors(n, t1).normalize(); // „oben“ auf der Fläche
  const target = a.point.clone().addScaledVector(t1, du * S.step).addScaledVector(t2, dv * S.step);
  // zurück auf die Oberfläche setzen
  const rc = new THREE.Raycaster(target.clone().addScaledVector(n, 3), n.clone().negate());
  rc.firstHitOnly = true;
  const hit = rc.intersectObject(mesh, false)[0];
  a.point = hit && hit.distance < 8 ? hit.point.clone() : target;
  updateGhost();
  renderPanelInfo();
}

/* ------------------------------------------------------------ Panel ---- */

const side = $('side');
const PRESETS = [['M3', 3.4], ['M4', 4.5], ['M5', 5.5], ['M6', 6.6], ['M8', 9]];

function presetsHTML() {
  return `<div class="row" style="flex-wrap:wrap;justify-content:flex-start;gap:5px"><span class="muted" style="width:100%;font-size:12px">Schraubenloch (Durchgang):</span>` +
    PRESETS.map(([n, d]) => `<button data-d="${d}" style="padding:3px 8px">${n}</button>`).join('') + '</div>';
}

function bindPresets() {
  side.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
    S.d = +b.dataset.d; $('inD').value = S.d; updateGhost();
  });
  const d = $('inD');
  if (d) d.oninput = () => { S.d = +d.value || 0; updateGhost(); };
}

function renderPanel() {
  if (!S.g) { side.style.display = 'none'; return; }
  side.style.display = 'block';
  if (S.mode === 'hole' && S.hole) {
    const h = S.hole;
    side.innerHTML = `<h3>🔵 Bohrung ausgewählt</h3>
      <div class="muted">${describe(h)}</div>
      <div class="btns">
        <button class="wide danger" id="aClose">🔴 Bohrung schließen</button>
        <button class="wide" id="aResize">↔ Durchmesser ändern…</button>
        <button class="wide" id="aMove">✥ Verschieben…</button>
        <button class="wide" id="aChamfer">◢ Fase anbringen…</button>
        <button class="wide" id="aNew">➕ Neue Bohrung setzen…</button>
        <button class="wide" id="aCancel">Auswahl aufheben</button>
      </div>`;
    $('aClose').onclick = () => doClose(h);
    $('aResize').onclick = () => startResize(h);
    $('aMove').onclick = () => startMove(h);
    $('aChamfer').onclick = () => startChamfer(h);
    $('aNew').onclick = () => { S.mode = 'new'; S.anchor = null; renderPanel(); toast('Jetzt auf die Stelle am Modell klicken, wo gebohrt werden soll.'); };
    $('aCancel').onclick = cancelMode;
  } else if (S.mode === 'chamfer' && S.hole) {
    const h = S.hole, e = endsOf(h);
    side.innerHTML = `<h3>◢ Fase anbringen</h3>
      <div class="muted">${describe(h)}<br>Die rote Vorschau zeigt, was abgeschrägt wird.</div>
      <div class="row"><label for="inCh">Fasenbreite (mm)</label><input id="inCh" type="number" min="0.1" step="0.1" value="${S.ch}"></div>
      <div class="row"><label for="inAng">Winkel zur Achse (°)</label><input id="inAng" type="number" min="10" max="80" step="5" value="${S.ang}"></div>
      <div class="muted" style="font-size:12px">45° = gleichmäßige Fase. Kleinerer Winkel = flacher und länger ins Loch, größerer = steiler und kürzer.</div>
      <div class="muted" style="margin-top:8px">An welcher Öffnung?</div>
      ${[0, 1].filter(i => e[i]).map(i => `<div class="row"><label><input type="checkbox" data-e="${i}" ${S.chEnds[i] ? 'checked' : ''}> ${endLabel(h, i)}</label></div>`).join('')}
      <div class="stat" id="info"></div>
      <div class="btns">
        <button class="primary" id="aApply">Fase anbringen</button>
        <button id="aCancel">Abbrechen</button>
      </div>`;
    const info = () => { $('info').textContent = `Tiefe der Fase ins Loch: ${fmt(C.chamferDepth(S.ch || 0, S.ang))} mm`; };
    info();
    $('inCh').oninput = ev => { S.ch = +ev.target.value || 0; info(); updateGhost(); };
    $('inAng').oninput = ev => { S.ang = +ev.target.value || 45; info(); updateGhost(); };
    side.querySelectorAll('[data-e]').forEach(cb => cb.onchange = () => { S.chEnds[+cb.dataset.e] = cb.checked; updateGhost(); });
    $('aApply').onclick = () => {
      if (!(S.ch >= 0.05)) return toast('Bitte eine Fasenbreite von mindestens 0,05 mm eingeben.', 'bad');
      if (S.ang < 10 || S.ang > 80) return toast('Der Winkel muss zwischen 10° und 80° liegen.', 'bad');
      const which = [e[0] && S.chEnds[0], e[1] && S.chEnds[1]];
      if (!which[0] && !which[1]) return toast('Bitte mindestens eine Öffnung wählen.', 'bad');
      if (C.chamferDepth(S.ch, S.ang) > h.length) return toast('Die Fase wäre tiefer als die Bohrung. Bitte kleiner wählen.', 'bad', 5000);
      const c = S.ch, a = S.ang;
      commit(`Fase ${fmt(c)} mm × ${fmt(a)}° angebracht`, () => C.chamferHole(S.g, h, which, c, a));
    };
    $('aCancel').onclick = cancelMode;
  } else if (S.mode === 'move' && S.hole) {
    const row = (i, n, c) => `<div class="row"><label for="mv${i}" style="color:${c};font-weight:600">${n}-Achse</label><span><input id="mv${i}" type="number" step="0.5" value="${S.mv[i]}"> mm</span></div>`;
    side.innerHTML = `<h3>✥ Bohrung verschieben</h3>
      <div class="muted">${describe(S.hole)}<br>Maß pro Achse eingeben: <b>+</b> = in Pfeilrichtung, <b>−</b> = Gegenrichtung (z. B. X = −3). Rote Vorschau = neue Lage.</div>
      ${row(0, 'X', '#ff6b6b')}${row(1, 'Y', '#4cd08a')}${row(2, 'Z', '#5aa9ff')}
      <div class="btns">
        <button class="primary" id="aApply">Verschieben</button>
        <button id="aCancel">Abbrechen</button>
      </div>`;
    [0, 1, 2].forEach(i => { $('mv' + i).oninput = e => { S.mv[i] = +e.target.value || 0; updateGhost(); }; });
    $('aApply').onclick = () => {
      if (!S.mv.some(v => v !== 0)) return toast('Bitte bei mindestens einer Achse ein Maß eingeben.', 'bad');
      const h = S.hole, e = endsOf(h), d = new THREE.Vector3(...S.mv);
      commit(`Bohrung um X ${fmt(d.x)} · Y ${fmt(d.y)} · Z ${fmt(d.z)} mm verschoben`, () => C.moveHole(S.g, h, d, e));
    };
    $('aCancel').onclick = cancelMode;
  } else if (S.mode === 'resize' && S.hole) {
    side.innerHTML = `<h3>↔ Durchmesser ändern</h3>
      <div class="muted">Aktuell Ø ${fmt((S.hole.uniform ? S.hole.radius : S.hole.rmax) * 2)} mm${S.hole.uniform ? '' : ' (größte Stelle)'}. Die rote Vorschau zeigt die neue Größe.</div>
      <div class="row"><label for="inD">Neuer Durchmesser (mm)</label><input id="inD" type="number" min="0.5" step="0.1" value="${S.d}"></div>
      ${presetsHTML()}
      <div class="btns">
        <button class="primary" id="aApply">Übernehmen</button>
        <button id="aCancel">Abbrechen</button>
      </div>`;
    bindPresets();
    $('aApply').onclick = () => {
      if (!(S.d >= 0.5)) return toast('Bitte einen Durchmesser von mindestens 0,5 mm eingeben.', 'bad');
      const h = S.hole, e = endsOf(h), d = S.d;
      commit(`Bohrung auf Ø ${fmt(d)} mm geändert`, () => C.resizeHole(S.g, h, d, e));
    };
    $('aCancel').onclick = cancelMode;
  } else if (S.mode === 'new') {
    side.innerHTML = `<h3>➕ Neue Bohrung</h3>
      <div class="muted">Klicke aufs Modell, um die Stelle zu ändern. Rote Vorschau = wird herausgebohrt.</div>
      <div class="row"><label for="inD">Durchmesser (mm)</label><input id="inD" type="number" min="0.5" step="0.1" value="${S.d}"></div>
      ${presetsHTML()}
      <div class="row"><label><input type="checkbox" id="inThru" ${S.through ? 'checked' : ''}> durchgehend</label>
        <span><input id="inDepth" type="number" min="0.5" step="0.5" value="${S.depth}" ${S.through ? 'disabled' : ''} style="width:70px"> mm tief</span></div>
      <div class="row"><label for="inSink">Senkung</label><select id="inSink" style="background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px">
        <option value="none" ${S.sink === 'none' ? 'selected' : ''}>keine</option>
        <option value="cone" ${S.sink === 'cone' ? 'selected' : ''}>Kegel (Senkkopf)</option>
        <option value="cyl" ${S.sink === 'cyl' ? 'selected' : ''}>Zylinder (Zylinderkopf)</option></select></div>
      ${S.sink === 'none' ? `
      <div class="row"><label for="inCh">Fase (mm, 0 = keine)</label><input id="inCh" type="number" min="0" step="0.1" value="${S.ch}"></div>
      <div class="row"><label for="inAng">Winkel zur Achse (°)</label><input id="inAng" type="number" min="10" max="80" step="5" value="${S.ang}"></div>
      <div class="row"><label class="muted"><input type="checkbox" id="inBack" ${S.chBack ? 'checked' : ''} ${S.through ? '' : 'disabled'}> Fase auch auf der Rückseite</label></div>` : `
      <div class="row" style="flex-wrap:wrap;justify-content:flex-start;gap:5px"><span class="muted" style="width:100%;font-size:12px">Passend für Schraube (setzt Loch + Senkung):</span>${SINK_PRESETS[S.sink].map((q, i) => `<button data-sp="${i}" style="padding:3px 8px">${q[0]}</button>`).join('')}</div>
      <div class="row"><label for="inSD">Senk-Ø (mm)</label><input id="inSD" type="number" min="1" step="0.1" value="${S.sd}"></div>
      ${S.sink === 'cone'
        ? `<div class="row"><label for="inSA">Öffnungswinkel (°)</label><input id="inSA" type="number" min="30" max="140" step="1" value="${S.sa}"></div>`
        : `<div class="row"><label for="inSH">Senktiefe (mm)</label><input id="inSH" type="number" min="0.2" step="0.1" value="${S.sh}"></div>`}
      <div class="muted" id="sinkInfo" style="font-size:12px"></div>`}
      <div class="row"><span class="muted">Fein verschieben</span><label class="muted">Schritt <input id="inStep" type="number" min="0.1" step="0.1" value="${S.step}" style="width:60px"> mm</label></div>
      <div class="pad">
        <span></span><button data-n="0,1">▲</button><span></span>
        <button data-n="-1,0">◀</button><span></span><button data-n="1,0">▶</button>
        <span></span><button data-n="0,-1">▼</button><span></span>
      </div>
      <div class="stat" id="info"></div>
      <div class="btns">
        <button class="primary" id="aApply">Bohren</button>
        <button id="aCancel">Abbrechen</button>
      </div>`;
    bindPresets();
    $('inThru').onchange = e => { S.through = e.target.checked; $('inDepth').disabled = S.through; $('inBack').disabled = !S.through; updateGhost(); };
    $('inSink').onchange = e => { S.sink = e.target.value; if (S.sink !== 'none' && !(S.sd > S.d)) S.sd = +(S.d * 2).toFixed(1); renderPanel(); updateGhost(); };
    if (S.sink === 'none') {
      $('inCh').oninput = e => { S.ch = Math.max(0, +e.target.value || 0); updateGhost(); };
      $('inAng').oninput = e => { S.ang = +e.target.value || 45; updateGhost(); };
      $('inBack').onchange = e => { S.chBack = e.target.checked; updateGhost(); };
    } else {
      const info = () => {
        const el = $('sinkInfo');
        if (!el) return;
        el.textContent = !(S.sd > S.d) ? 'Der Senk-Ø muss größer als der Lochdurchmesser sein.'
          : S.sink === 'cone' ? `Senktiefe: ${fmt(coneDepth())} mm` : '';
      };
      info();
      $('inSD').oninput = e => { S.sd = +e.target.value || 0; info(); updateGhost(); };
      if (S.sink === 'cone') $('inSA').oninput = e => { S.sa = +e.target.value || 90; info(); updateGhost(); };
      else $('inSH').oninput = e => { S.sh = +e.target.value || 0; info(); updateGhost(); };
      side.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => {
        const q = SINK_PRESETS[S.sink][+b.dataset.sp];
        S.d = q[1]; S.sd = q[2]; if (q[3]) S.sh = q[3];
        $('inD').value = S.d; $('inSD').value = S.sd; if (S.sink === 'cyl') $('inSH').value = S.sh;
        info(); updateGhost();
      });
      $('inD').addEventListener('input', info);
    }
    $('inDepth').oninput = e => { S.depth = +e.target.value || 0; updateGhost(); };
    $('inStep').oninput = e => { S.step = +e.target.value || 0.5; };
    side.querySelectorAll('[data-n]').forEach(b => b.onclick = () => { const [u, v] = b.dataset.n.split(',').map(Number); if (S.anchor) nudge(u, v); });
    $('aApply').onclick = () => {
      if (!S.anchor) return toast('Erst auf die Stelle am Modell klicken.', 'bad');
      if (!(S.d >= 0.5)) return toast('Bitte einen Durchmesser von mindestens 0,5 mm eingeben.', 'bad');
      if (!S.through && !(S.depth > 0)) return toast('Bitte eine Tiefe angeben.', 'bad');
      if (S.sink === 'none' && S.ch > 0 && (S.ang < 10 || S.ang > 80)) return toast('Der Winkel muss zwischen 10° und 80° liegen.', 'bad');
      const { point, normal } = S.anchor, d = S.d, depth = S.through ? null : S.depth;
      let sink = null;
      if (S.sink !== 'none') {
        if (!sinkOK()) return toast('Bitte die Senkung prüfen: Der Senk-Ø muss größer als der Lochdurchmesser sein.', 'bad', 5000);
        const sdepth = S.sink === 'cone' ? coneDepth() : S.sh, lim = S.through ? thickness(S.anchor) : depth;
        if (lim && sdepth >= lim) return toast(`Die Senkung (${fmt(sdepth)} mm tief) ist tiefer als ${S.through ? 'das Material an dieser Stelle' : 'die Bohrung'} (${fmt(lim)} mm).`, 'bad', 6000);
        sink = S.sink === 'cone' ? { type: 'cone', D: S.sd, angle: S.sa } : { type: 'cyl', D: S.sd, depth: S.sh };
      }
      const ch = S.sink === 'none' && S.ch > 0 ? { c: S.ch, ang: S.ang } : null;
      if (ch && !S.through && C.chamferDepth(ch.c, ch.ang) > depth) return toast('Die Fase wäre tiefer als die Bohrung. Bitte kleiner wählen.', 'bad', 5000);
      const th = thickness(S.anchor);
      const exit = ch && S.through && S.chBack && th ? point.clone().addScaledVector(normal, -th) : null;
      commit(`Bohrung Ø ${fmt(d)} mm gesetzt${sink ? ' (mit Senkung)' : ch ? ' (mit Fase)' : ''}`, () => C.newHole(S.g, point, normal, d, depth, ch, exit, sink));
    };
    $('aCancel').onclick = cancelMode;
    renderPanelInfo();
  } else {
    const bb = S.g.boundingBox, sz = bb.getSize(new THREE.Vector3());
    const an = S.an;
    side.innerHTML = `<h3>📄 ${S.name}</h3>
      <div class="muted">Maße: ${fmt(sz.x)} × ${fmt(sz.y)} × ${fmt(sz.z)} mm</div>
      <div class="muted">Dreiecke: ${an.T.toLocaleString('de-DE')}</div>
      <div class="muted">Netz: ${an.watertight ? '<span style="color:var(--ok)">dicht ✓</span>' : `<span style="color:var(--warn)">${an.openEdges} offene Kanten ⚠</span>`}</div>
      <div class="stat">Fahre mit der Maus über eine <b>Bohrung</b> – sie leuchtet orange. <b>Linksklick</b> wählt sie aus,
      <b>Rechtsklick</b> öffnet das Menü. Rechtsklick auf eine freie Fläche → „Neue Bohrung hier“.</div>`;
  }
}

function renderPanelInfo() {
  const el = $('info');
  if (!el || S.mode !== 'new') return;
  if (!S.anchor) { el.textContent = 'Noch keine Stelle gewählt – bitte aufs Modell klicken.'; return; }
  const th = thickness(S.anchor), p = S.anchor.point;
  el.innerHTML = `Position: X ${fmt(p.x)} · Y ${fmt(p.y)} · Z ${fmt(p.z)}<br>` +
    (th ? `Wandstärke an dieser Stelle: <b>${fmt(th)} mm</b>` : 'Dahinter ist nichts (Tiefe frei wählbar).');
}

/* ------------------------------------------------------ Datei laden ---- */

function toast(msg, kind, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.className = kind || '';
  t.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.style.display = 'none'; }, ms);
}

export function loadBuffer(buf, name) {
  try {
    const g = C.parseSTL(buf);
    S.name = (name || 'modell').replace(/\.stl$/i, '');
    S.undo = []; S.redo = [];
    S.original = g;
    setGeometry(g, true);
    $('drop').classList.add('hidden');
    toast('Geladen: ' + S.name, 'ok');
  } catch (e) {
    console.error(e);
    toast('Datei konnte nicht gelesen werden: ' + e.message, 'bad', 6000);
  }
}
window.__werkstatt = { loadBuffer, S, C, THREE, camera, controls, mesh, pick, doClose, startNew, startResize, startMove, startChamfer };

async function openFile(f) {
  if (f) loadBuffer(await f.arrayBuffer(), f.name);
}
$('bOpen').onclick = $('bOpen2').onclick = () => $('file').click();
$('file').onchange = e => { openFile(e.target.files[0]); e.target.value = ''; };
addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) $('drop').classList.remove('over'); });
addEventListener('drop', e => { e.preventDefault(); $('drop').classList.remove('over'); openFile(e.dataTransfer.files[0]); });

$('bSave').onclick = () => {
  const blob = new Blob([C.writeSTL(S.g)], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = S.name + (S.undo.length ? '_bearbeitet' : '') + '.stl';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Gespeichert als ' + a.download + ' (im Download-Ordner)', 'ok');
};

function undo() { if (S.undo.length) { S.redo.push(S.g); setGeometry(S.undo.pop()); toast('Rückgängig'); } }
function redo() { if (S.redo.length) { S.undo.push(S.g); setGeometry(S.redo.pop()); toast('Wiederholt'); } }
$('bUndo').onclick = undo;
$('bRedo').onclick = redo;
$('bReset').onclick = () => { if (confirm('Alle Änderungen verwerfen und zum Original zurück?')) { S.undo = []; S.redo = []; setGeometry(S.original); toast('Original wiederhergestellt'); } };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 'Escape') { hideMenu(); if (S.mode !== 'idle') cancelMode(); }
});

C.initCSG({ wasmBinary }).catch(e => toast('Rechenmodul konnte nicht geladen werden: ' + e.message, 'bad', 10000));
