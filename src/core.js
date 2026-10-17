// Kernlogik der STL-Werkstatt: STL lesen/schreiben, Bohrungen erkennen, Bohrungen schließen/ändern/setzen.
// Enthält bewusst keinen Browser-Code, damit sie auch im Terminal testbar ist.
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import Module from 'manifold-3d';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

/* ---------------------------------------------------------------- STL ---- */

export function parseSTL(buffer) {
  const dv = new DataView(buffer);
  let positions;
  if (buffer.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buffer.byteLength) {
      positions = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) positions[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
    }
  }
  if (!positions) {
    const text = new TextDecoder().decode(buffer);
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
    if (out.length < 9 || out.length % 9) throw new Error('Das ist keine gültige STL-Datei.');
    positions = new Float32Array(out);
  }
  return buildGeometry(positions);
}

/** Verschweißt Punkte, die (fast) aufeinander liegen – auch über Rastergrenzen hinweg. */
function weld(positions, indexed, tol = 1e-5) {
  const cell = tol * 4;
  const grid = new Map();
  const map = new Int32Array(positions.length / 3);
  const out = [];
  const key = (i, j, k) => i * 73856093 ^ j * 19349663 ^ k * 83492791;
  for (let v = 0; v < map.length; v++) {
    const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2];
    const ci = Math.floor(x / cell), cj = Math.floor(y / cell), ck = Math.floor(z / cell);
    let found = -1;
    search: for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      const list = grid.get(key(ci + di, cj + dj, ck + dk));
      if (!list) continue;
      for (const w of list) {
        if (Math.abs(out[3 * w] - x) <= tol && Math.abs(out[3 * w + 1] - y) <= tol && Math.abs(out[3 * w + 2] - z) <= tol) { found = w; break search; }
      }
    }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      const kk = key(ci, cj, ck);
      if (grid.has(kk)) grid.get(kk).push(found); else grid.set(kk, [found]);
    }
    map[v] = found;
  }
  const src = indexed || Array.from({ length: map.length }, (_, i) => i);
  const idx = [];
  for (let t = 0; t < src.length; t += 3) {
    const a = map[src[t]], b = map[src[t + 1]], c = map[src[t + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { pos: new Float32Array(out), idx };
}

/** Baut aus (ggf. nicht indizierten) Positionen ein sauberes, verschweißtes Netz. */
export function buildGeometry(positions, indexed) {
  const { pos, idx } = weld(positions, indexed);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  g.computeBoundsTree();
  return g;
}

export function writeSTL(geometry) {
  const idx = geometry.index.array, pos = geometry.attributes.position.array;
  const n = idx.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  new TextEncoder().encodeInto('STL-Werkstatt', new Uint8Array(buf, 0, 80));
  dv.setUint32(80, n, true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < n; t++) {
    a.fromArray(pos, idx[3 * t] * 3);
    b.fromArray(pos, idx[3 * t + 1] * 3);
    c.fromArray(pos, idx[3 * t + 2] * 3);
    const nrm = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const o = 84 + t * 50;
    dv.setFloat32(o, nrm.x, true); dv.setFloat32(o + 4, nrm.y, true); dv.setFloat32(o + 8, nrm.z, true);
    [a, b, c].forEach((v, k) => {
      dv.setFloat32(o + 12 + k * 12, v.x, true);
      dv.setFloat32(o + 16 + k * 12, v.y, true);
      dv.setFloat32(o + 20 + k * 12, v.z, true);
    });
  }
  return buf;
}

/* ------------------------------------------------------------ Analyse ---- */

/** Flächennormalen, Nachbardreieck-Tabelle, Dichtigkeit und Volumen. */
export function analyze(g) {
  const idx = g.index.array, pos = g.attributes.position.array;
  const T = idx.length / 3, nv = pos.length / 3;
  const tn = new Float32Array(T * 3), ta = new Float32Array(T);
  const nbr = new Int32Array(T * 3).fill(-1);
  const edges = new Map();
  let nonManifold = 0, volume = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (let t = 0; t < T; t++) {
    a.fromArray(pos, idx[3 * t] * 3); b.fromArray(pos, idx[3 * t + 1] * 3); c.fromArray(pos, idx[3 * t + 2] * 3);
    e1.subVectors(b, a); e2.subVectors(c, a);
    const n = e1.cross(e2);
    const len = n.length();
    ta[t] = len / 2;
    if (len > 0) n.divideScalar(len);
    tn[3 * t] = n.x; tn[3 * t + 1] = n.y; tn[3 * t + 2] = n.z;
    volume += a.dot(b.clone().cross(c)) / 6;
    for (let e = 0; e < 3; e++) {
      const p = idx[3 * t + e], q = idx[3 * t + (e + 1) % 3];
      const key = p < q ? p * nv + q : q * nv + p;
      const prev = edges.get(key);
      if (prev === undefined) edges.set(key, t * 3 + e);
      else if (prev === -1) nonManifold++;
      else {
        const ot = Math.floor(prev / 3);
        nbr[3 * t + e] = ot;
        nbr[prev] = t;
        edges.set(key, -1);
      }
    }
  }
  let open = 0;
  for (const v of edges.values()) if (v >= 0) open++;
  return { T, tn, ta, nbr, openEdges: open, nonManifold, volume, watertight: open === 0 && nonManifold === 0 };
}

/* ------------------------------------------------- Bohrungserkennung ---- */

function eigenSym3(m) {
  const A = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 40; sweep++) {
    if (Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]) < 1e-15) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(A[p][q]) < 1e-20) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const x = A[k][p], y = A[k][q]; A[k][p] = c * x - s * y; A[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = A[p][k], y = A[q][k]; A[p][k] = c * x - s * y; A[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
    }
  }
  const vals = [A[0][0], A[1][1], A[2][2]];
  const vecs = [0, 1, 2].map(i => new THREE.Vector3(V[0][i], V[1][i], V[2][i]));
  return { vals, vecs };
}

function solve3(M, r) {
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-12) return null;
  return [0, 1, 2].map(i => det(M.map((row, j) => row.map((v, k) => (k === i ? r[j] : v)))) / D);
}

function axisFromNormals(an, tris) {
  const m = [0, 0, 0, 0, 0, 0];
  let total = 0;
  for (const t of tris) {
    const w = an.ta[t], x = an.tn[3 * t], y = an.tn[3 * t + 1], z = an.tn[3 * t + 2];
    m[0] += w * x * x; m[1] += w * x * y; m[2] += w * x * z; m[3] += w * y * y; m[4] += w * y * z; m[5] += w * z * z;
    total += w;
  }
  const { vals, vecs } = eigenSym3(m.map(v => v / total));
  let k = 0;
  for (let i = 1; i < 3; i++) if (vals[i] < vals[k]) k = i;
  return vecs[k].normalize();
}

/**
 * Prüft, ob Dreieck t0 zu einer zylindrischen Fläche gehört. Gibt eine Beschreibung
 * {axis, base, length, radius, rmax, concave, coverage, tris} zurück oder null.
 */
export function detectCylinder(g, an, t0) {
  const idx = g.index.array, pos = g.attributes.position.array;
  const MAXT = 6000, cosLim = Math.cos(42 * Math.PI / 180);
  const dot = (s, t) => an.tn[3 * s] * an.tn[3 * t] + an.tn[3 * s + 1] * an.tn[3 * t + 1] + an.tn[3 * s + 2] * an.tn[3 * t + 2];
  const seen = new Set([t0]);
  const stack = [t0];
  while (stack.length) {
    const t = stack.pop();
    for (let e = 0; e < 3; e++) {
      const n = an.nbr[3 * t + e];
      if (n < 0 || seen.has(n) || dot(t, n) < cosLim) continue;
      seen.add(n);
      if (seen.size > MAXT) return { fail: [...seen] };
      stack.push(n);
    }
  }
  if (seen.size < 6) return { fail: [...seen] };

  // Achse: die Richtung, die auf allen Wand-Normalen senkrecht steht
  let tris = [...seen];
  let axis = axisFromNormals(an, tris);
  const prune = ax => {
    const ok = new Set();
    for (const t of tris) {
      const d = an.tn[3 * t] * ax.x + an.tn[3 * t + 1] * ax.y + an.tn[3 * t + 2] * ax.z;
      if (Math.abs(d) < 0.75) ok.add(t);
    }
    if (!ok.has(t0)) return null;
    const comp = new Set([t0]);
    const st = [t0];
    while (st.length) {
      const t = st.pop();
      for (let e = 0; e < 3; e++) {
        const n = an.nbr[3 * t + e];
        if (n >= 0 && ok.has(n) && !comp.has(n)) { comp.add(n); st.push(n); }
      }
    }
    return [...comp];
  };
  let comp = prune(axis);
  if (!comp || comp.length < 6) return { fail: [...seen] };
  tris = comp;
  axis = axisFromNormals(an, tris);
  comp = prune(axis);
  if (!comp || comp.length < 6) return { fail: [...seen] };
  tris = comp;

  // Kreis in der Ebene senkrecht zur Achse einpassen
  const h = Math.abs(axis.x) < 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(axis, h).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  const verts = new Set();
  for (const t of tris) for (let k = 0; k < 3; k++) verts.add(idx[3 * t + k]);
  const P = [];
  let tmin = Infinity, tmax = -Infinity, mx = 0, my = 0;
  const p = new THREE.Vector3();
  for (const i of verts) {
    p.fromArray(pos, i * 3);
    const x = p.dot(u), y = p.dot(v), z = p.dot(axis);
    P.push([x, y]);
    mx += x; my += y;
    if (z < tmin) tmin = z;
    if (z > tmax) tmax = z;
  }
  mx /= P.length; my /= P.length;
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sr = 0, sxr = 0, syr = 0;
  for (const [X, Y] of P) {
    const x = X - mx, y = Y - my, r2 = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sr += r2; sxr += x * r2; syr += y * r2;
  }
  const n = P.length;
  const sol = solve3([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], [sxr, syr, sr]);
  if (!sol) return { fail: [...seen] };
  const cx = sol[0] / 2, cy = sol[1] / 2;
    // Drehkörper-Test: Vertices auf gleicher Höhe müssen gleichen Abstand zur Achse haben
  // (so werden auch Bohrungen mit Fase, Nut oder Kegelstück erkannt, nicht nur glatte Zylinder).
  let rmax = 0, rmin = Infinity, rsum = 0;
  const angles = [], rings = new Map();
  let k0 = 0;
  for (const i of verts) {
    const [X, Y] = P[k0++];
    p.fromArray(pos, i * 3);
    const d = Math.hypot(X - mx - cx, Y - my - cy);
    rmax = Math.max(rmax, d); rmin = Math.min(rmin, d); rsum += d;
    angles.push(Math.atan2(Y - my - cy, X - mx - cx));
    const key = Math.round(p.dot(axis) * 50);
    const r = rings.get(key);
    if (r) { r.min = Math.min(r.min, d); r.max = Math.max(r.max, d); } else rings.set(key, { min: d, max: d, z: p.dot(axis) });
  }
  const radius = rsum / n;
  let spread = 0;
  for (const r of rings.values()) spread = Math.max(spread, r.max - r.min);
  if (rmin < 0.15 || rmax > 1000 || spread > 0.05 * rmax + 0.03) return { fail: [...seen] };
  const profile = [...rings.values()].sort((a, b) => a.z - b.z).map(r => ({ t: r.z - tmin, r: (r.min + r.max) / 2 }));
  const uniform = rmax - rmin < 0.03 * rmax + 0.02;

  angles.sort((a, b) => a - b);
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  const coverage = 360 - gap * 180 / Math.PI;

  // Loch (Normalen zeigen zur Achse) oder Zapfen (Normalen zeigen nach außen)?
  const centerXY = new THREE.Vector3().addScaledVector(u, mx + cx).addScaledVector(v, my + cy);
  let inward = 0, outward = 0;
  const c = new THREE.Vector3(), nn = new THREE.Vector3(), rad = new THREE.Vector3();
  for (const t of tris) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(p.fromArray(pos, idx[3 * t + k] * 3));
    c.divideScalar(3);
    rad.copy(c).addScaledVector(axis, -c.dot(axis)).sub(centerXY);
    nn.set(an.tn[3 * t], an.tn[3 * t + 1], an.tn[3 * t + 2]);
    if (nn.dot(rad) < 0) inward += an.ta[t]; else outward += an.ta[t];
  }
  const base = centerXY.clone().addScaledVector(axis, tmin);
  return { axis, base, length: tmax - tmin, radius, rmin, rmax, uniform, profile, concave: inward > outward, coverage, partial: coverage < 280, tris, u, v };
}

/** Wie detectCylinder, aber mit Zwischenspeicher pro Dreieck. */
export function makeDetector(g, an) {
  const cache = new Map();
  return t0 => {
    if (cache.has(t0)) return cache.get(t0);
    const r = detectCylinder(g, an, t0);
    if (r.fail) { for (const t of r.fail) cache.set(t, null); return null; }
    for (const t of r.tris) cache.set(t, r);
    return r;
  };
}

/* ------------------------------------------------------ Punkt im Körper -- */

export function makeSolidTest(g) {
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const rc = new THREE.Raycaster();
  rc.firstHitOnly = true;
  const dir = new THREE.Vector3(0.5773, 0.6101, 0.5411).normalize();
  return p => {
    rc.set(p, dir);
    const hit = rc.intersectObject(mesh, false)[0];
    return !!hit && hit.face.normal.dot(dir) > 0;
  };
}

/** Welche Enden der Bohrung liegen offen (an der Außenfläche)? [unten, oben] */
export function openEnds(hole, isSolid) {
  const res = [];
  for (const sgn of [-1, 1]) {
    let air = 0;
    const tEnd = sgn < 0 ? 0 : hole.length;
    for (const dir of [hole.u, hole.v, hole.u.clone().negate(), hole.v.clone().negate()]) {
      const p = hole.base.clone().addScaledVector(hole.axis, tEnd + sgn * 0.1).addScaledVector(dir, hole.rmax + 0.4);
      if (!isSolid(p)) air++;
    }
    res.push(air >= 3);
  }
  return res;
}

/* ---------------------------------------------------- Boolesche Ops ---- */

let M = null; // Manifold-Bibliothek (WebAssembly), muss einmal mit initCSG() geladen werden

export async function initCSG(options) {
  const wasm = await Module(options);
  wasm.setup();
  M = wasm;
}

function toManifold(g) {
  const mesh = new M.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(g.attributes.position.array),
    triVerts: new Uint32Array(g.index.array),
  });
  const m = new M.Manifold(mesh);
  if (m.status() !== 'NoError') throw new Error('Das Modell ist nicht geschlossen genug für diese Änderung (' + m.status() + ').');
  return m;
}

function fromManifold(m) {
  const out = m.getMesh();
  const nProp = out.numProp;
  const pos = new Float32Array(out.vertProperties.length / nProp * 3);
  for (let i = 0, n = pos.length / 3; i < n; i++) for (let k = 0; k < 3; k++) pos[3 * i + k] = out.vertProperties[i * nProp + k];
  return buildGeometry(pos, Array.from(out.triVerts));
}

export function cylinderManifold(radius, length, base, axis) {
  const seg = Math.min(192, Math.max(48, Math.ceil(radius * 28 / 2) * 2));
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
  const mat = new THREE.Matrix4().compose(base, q, new THREE.Vector3(1, 1, 1));
  return M.Manifold.cylinder(length, radius, radius, seg, false).transform(Array.from(mat.elements));
}

/** Für die Vorschau im Viewer: gleiche Zylinderform als THREE-Geometrie. */
export function cylinderGeo(radius, length, base, axis) {
  const g = new THREE.CylinderGeometry(radius, radius, length, 64, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  g.applyMatrix4(new THREE.Matrix4().compose(base.clone().addScaledVector(axis, length / 2), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

function boolean(g, cyl, subtract) {
  const a = toManifold(g);
  return fromManifold(subtract ? a.subtract(cyl) : a.add(cyl));
}

const OVER_OPEN = 0.4;  // Fräser ragt an offenen Enden heraus (sicherer Schnitt)

function segment(hole, e0, e1) {
  return { base: hole.base.clone().addScaledVector(hole.axis, -e0), length: hole.length + e0 + e1 };
}

/** Füllt eine Bohrung mit einem passenden Stopfen. */
export function closeHole(g, hole) {
  return boolean(g, cylinderManifold(hole.rmax + 0.02, hole.length, hole.base, hole.axis), false);
}

/** Bohrt entlang einer Achse. */
export function drill(g, radius, base, axis, length) {
  return boolean(g, cylinderManifold(radius, length, base, axis), true);
}

/** Ändert den Durchmesser einer vorhandenen Bohrung. ends = [unten offen, oben offen]. */
export function resizeHole(g, hole, newDiameter, ends, sink = null, sinkEnd = 0) {
  const R = newDiameter / 2;
  const cur = R < hole.rmax - 0.005 ? closeHole(g, hole) : g;
  const s = segment(hole, ends[0] ? OVER_OPEN : 0, ends[1] ? OVER_OPEN : 0);
  let cutter = cylinderManifold(R, s.length, s.base, hole.axis);
  if (sink) { const e = holeEnd(hole, sinkEnd); cutter = cutter.add(sinkCutter(e.origin, e.dir, R, sink)); }
  return fromManifold(toManifold(cur).subtract(cutter));
}

/**
 * Kegel-Fräser für eine Fase am Lochrand. origin = Punkt auf der Oberfläche in der Lochmitte,
 * dir = Richtung ins Loch hinein, r = Lochradius, c = Fasenbreite (mm), ang = Winkel zur Achse (°).
 */
export function chamferDepth(c, ang) { return c / Math.tan(ang * Math.PI / 180); }

function chamferCutter(origin, dir, r, c, ang) {
  const tn = Math.tan(ang * Math.PI / 180), depth = c / tn, ov = 0.4, ext = 0.2;
  const poly = [[0, -ov], [r + c + ov * tn, -ov], [Math.max(0.01, r - ext * tn), depth + ext], [0, depth + ext]];
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  const mat = new THREE.Matrix4().compose(origin, q, new THREE.Vector3(1, 1, 1));
  return M.Manifold.revolve([poly], 96).transform(Array.from(mat.elements));
}

/** Vorschau des Fasenkegels im Viewer. */
export function chamferGhostGeo(origin, dir, r, c, ang) {
  const depth = chamferDepth(c, ang);
  const g = new THREE.LatheGeometry([new THREE.Vector2(r + c, 0), new THREE.Vector2(r, depth)], 64);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyMatrix4(new THREE.Matrix4().compose(origin, q, new THREE.Vector3(1, 1, 1)));
  return g;
}

/** Position und Richtung der Öffnung (0 = unten, 1 = oben) einer vorhandenen Bohrung. */
export function holeEnd(hole, i) {
  return i === 0
    ? { origin: hole.base.clone(), dir: hole.axis.clone(), r: hole.profile[0].r }
    : { origin: hole.base.clone().addScaledVector(hole.axis, hole.length), dir: hole.axis.clone().negate(), r: hole.profile[hole.profile.length - 1].r };
}

/** Bringt an den gewählten offenen Enden einer Bohrung eine Fase an. */
export function chamferHole(g, hole, which, c, ang) {
  let m = toManifold(g);
  for (const i of [0, 1]) {
    if (!which[i]) continue;
    const e = holeEnd(hole, i);
    m = m.subtract(chamferCutter(e.origin, e.dir, e.r, c, ang));
  }
  return fromManifold(m);
}

/** Neue Bohrung ab einem Punkt auf der Oberfläche, nach innen. depth=null → durchgehend.
 *  ch = {c, ang} für eine Fase am Eintritt; exitPoint für eine Fase auf der Rückseite. */
/** Fräser für eine Senkung am Lochrand (r = Lochradius, dir = ins Loch hinein). */
export function sinkCutter(origin, dir, r, sink) {
  if (sink.type === 'cone') return chamferCutter(origin, dir, r, (sink.D - 2 * r) / 2, sink.angle / 2);
  const ov = 0.4;
  return cylinderManifold(sink.D / 2, ov + sink.depth, origin.clone().addScaledVector(dir, -ov), dir);
}

export function newHole(g, point, normal, diameter, depth, ch = null, exitPoint = null, sink = null) {
  const ov = 1;
  const len = ov + (depth == null ? g.boundingSphere.radius * 2 + 10 : depth);
  const base = point.clone().addScaledVector(normal, ov);
  const inward = normal.clone().negate();
  let cutter = cylinderManifold(diameter / 2, len, base, inward);
  if (sink) {
    cutter = cutter.add(sinkCutter(point, inward, diameter / 2, sink));
  } else if (ch) {
    cutter = cutter.add(chamferCutter(point, inward, diameter / 2, ch.c, ch.ang));
    if (exitPoint) cutter = cutter.add(chamferCutter(exitPoint, normal, diameter / 2, ch.c, ch.ang));
  }
  return fromManifold(toManifold(g).subtract(cutter));
}

/** Der „Hohlraum“ einer Bohrung als Drehkörper (mit Fase/Nut), um delta verschoben. */
function voidManifold(hole, ends, delta) {
  const ov = 0.4;
  const pts = hole.profile.map(q => [q.r, q.t]);
  if (pts.length === 1) pts.push([pts[0][0], pts[0][1] + hole.length]);
  pts[0][1] = 0;
  pts[pts.length - 1][1] = hole.length;
  if (ends[0]) pts.unshift([pts[0][0], -ov]);
  if (ends[1]) pts.push([pts[pts.length - 1][0], hole.length + ov]);
  const poly = [[0, pts[0][1]], ...pts, [0, pts[pts.length - 1][1]]];
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), hole.axis);
  const mat = new THREE.Matrix4().compose(hole.base.clone().add(delta), q, new THREE.Vector3(1, 1, 1));
  return M.Manifold.revolve([poly], 96).transform(Array.from(mat.elements));
}

/** Verschiebt eine Bohrung um delta (mm): alte Stelle füllen, gleiche Form an neuer Stelle bohren. */
export function moveHole(g, hole, delta, ends, sink = null, sinkEnd = 0) {
  const filled = toManifold(closeHole(g, hole));
  let cutter = voidManifold(hole, ends, delta);
  if (sink) { const e = holeEnd(hole, sinkEnd); cutter = cutter.add(sinkCutter(e.origin.clone().add(delta), e.dir, e.r, sink)); }
  return fromManifold(filled.subtract(cutter));
}

export function holeGhostGeo(hole, delta, ends) {
  const ov = 0.4, s0 = ends[0] ? ov : 0, s1 = ends[1] ? ov : 0;
  return cylinderGeo(hole.rmax, hole.length + s0 + s1,
    hole.base.clone().add(delta).addScaledVector(hole.axis, -s0), hole.axis);
}
