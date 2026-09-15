/*
 * Through The Looking Glass — a study.
 *
 * Everything runs in this tab. MediaPipe ships a WASM build, so detection,
 * unwrapping and merging all happen locally; no frame and no texture is ever
 * sent anywhere. The camera is only opened when you press the button.
 *
 * The head below is the MediaPipe canonical face — 468 vertices, one shared
 * shape for everyone. That is the point rather than a shortcut: the likeness
 * is carried entirely by the texture, which is the claim this whole project
 * rests on. Watch the same geometry become a specific person.
 */

const TEX = 1024;
const TARGETS = [-38, -22, 0, 22, 38];   // yaw angles to collect
const BUCKET = 11;                        // degrees either side of a target

let M = null;            // canonical model
let rig = null;
let landmarker = null;
let stream = null;
const slots = TARGETS.map(t => ({target: t, lm: null, view: null, yaw: null, score: 0}));

const $ = id => document.getElementById(id);

/* ---------------------------------------------------------------- geometry */

/* Parse the OBJ directly, because the model IS the OBJ.
 *
 * The one trap: positions and texture coordinates are indexed SEPARATELY. A
 * face reads `f 174/43 156/119 134/220` — vertex 174 uses UV 43 — so the `vt`
 * block is not in vertex order, and zipping the two blocks together gives a
 * scrambled face that still renders as a face-ish smear. The per-vertex UV
 * table has to be rebuilt by walking the faces. */
function parseOBJ(text) {
  const verts = [], texcoords = [], tris = [], vertUV = new Map();
  for (const line of text.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") verts.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === "vt") texcoords.push([+p[1], +p[2]]);
    else if (p[0] === "f") {
      const corner = [];
      for (let i = 1; i <= 3; i++) {
        const [vs, ts] = p[i].split("/");
        const vi = +vs - 1, ti = +ts - 1;       // OBJ indices are 1-based
        if (!vertUV.has(vi)) vertUV.set(vi, ti);
        corner.push(vi);
      }
      tris.push(corner);
    }
  }
  const uvs = verts.map((_, i) => texcoords[vertUV.get(i)] || [0, 0]);
  const uvPx = uvs.map(([u, v]) => [u * TEX, (1 - v) * TEX]);  // OBJ v is bottom-up

  // Face normals, oriented outward (the canonical face looks down +Z).
  const normals = tris.map(t => {
    const a = verts[t[0]], b = verts[t[1]], c = verts[t[2]];
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const L = Math.hypot(nx,ny,nz) || 1;
    return [nx/L, ny/L, nz/L];
  });
  const mean = normals.reduce((a,n)=>a+n[2], 0) / normals.length;
  const flipped = mean < 0 ? normals.map(n=>[-n[0],-n[1],-n[2]]) : normals;

  return {verts, uvs, uvPx, tris, normals: flipped};
}

/* Affine-map one triangle of `img` onto a destination triangle.
 * The triangles are grown very slightly about their centroid: adjacent
 * clipped paths otherwise leave hairline seams between every face. */
function warpTri(ctx, img, s, d, grow = 0.6) {
  const cx = (d[0][0]+d[1][0]+d[2][0])/3, cy = (d[0][1]+d[1][1]+d[2][1])/3;
  const g = d.map(p => {
    const dx = p[0]-cx, dy = p[1]-cy, L = Math.hypot(dx,dy) || 1;
    return [p[0] + dx/L*grow, p[1] + dy/L*grow];
  });

  const [x0,y0]=s[0], [x1,y1]=s[1], [x2,y2]=s[2];
  const [u0,v0]=g[0], [u1,v1]=g[1], [u2,v2]=g[2];
  const det = (x1-x0)*(y2-y0) - (x2-x0)*(y1-y0);
  if (Math.abs(det) < 1e-8) return;
  const a = ((u1-u0)*(y2-y0) - (u2-u0)*(y1-y0)) / det;
  const c = ((u2-u0)*(x1-x0) - (u1-u0)*(x2-x0)) / det;
  const b = ((v1-v0)*(y2-y0) - (v2-v0)*(y1-y0)) / det;
  const dd = ((v2-v0)*(x1-x0) - (v1-v0)*(x2-x0)) / det;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(g[0][0],g[0][1]); ctx.lineTo(g[1][0],g[1][1]); ctx.lineTo(g[2][0],g[2][1]);
  ctx.closePath(); ctx.clip();
  ctx.setTransform(a, b, c, dd, u0 - a*x0 - c*y0, v0 - b*x0 - dd*y0);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
  ctx.setTransform(1,0,0,1,0,0);
}

/* ------------------------------------------------------------------- rig */

function influence(verts, seeds, sigma) {
  const w = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i++) {
    let best = Infinity;
    for (const s of seeds) {
      const dx = verts[i][0]-verts[s][0], dy = verts[i][1]-verts[s][1],
            dz = verts[i][2]-verts[s][2];
      const d = dx*dx + dy*dy + dz*dz;
      if (d < best) best = d;
    }
    w[i] = Math.exp(-best / (2*sigma*sigma));
  }
  return w;
}

/* Deformations of named landmark groups, each falling off smoothly into the
 * surrounding surface — moving a contour's own vertices alone tears the mesh. */
function buildRig(verts) {
  const span = Math.max(...verts.map(v=>v[0])) - Math.min(...verts.map(v=>v[0]));
  const s = span/100;
  const T = {};
  const make = (seeds, sigma, fn) => {
    const w = influence(verts, seeds, sigma);
    return verts.map((v,i) => { const d = fn(v, i); return [d[0]*w[i], d[1]*w[i], d[2]*w[i]]; });
  };
  T.smile = make([61,291], 12*s, v => [Math.sign(v[0])*2.4*s, 3.2*s, -0.8*s]);
  T.jaw   = make([152,14], 26*s, v => v[1] < verts[13][1] ? [0,-7.5*s,1.5*s] : [0,0,0]);
  T.brow  = make([65,55,52,295,285,282], 14*s, () => [0, 3.4*s, 0]);
  T.blink = make([159,158,157,173,386,385,384,398], 5.5*s, () => [0,-3.0*s,0]);
  T.squint= make([145,144,153,374,373,380], 7*s, () => [0, 1.6*s, 0]);
  return T;
}

function deform(verts, T, amt) {
  return verts.map((v,i) => {
    let x=v[0], y=v[1], z=v[2];
    for (const k in amt) {
      const a = amt[k]; if (!a) continue;
      const t = T[k][i]; x += t[0]*a; y += t[1]*a; z += t[2]*a;
    }
    return [x,y,z];
  });
}

function project(verts, yaw, pitch, size, zoom) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  let mx=0,my=0,mz=0;
  for (const v of verts){ mx+=v[0]; my+=v[1]; mz+=v[2]; }
  mx/=verts.length; my/=verts.length; mz/=verts.length;
  const out = [], rot = [];
  let maxr = 0;
  for (const v of verts) {
    const x0=v[0]-mx, y0=v[1]-my, z0=v[2]-mz;
    const x1 = cy*x0 + sy*z0, z1 = -sy*x0 + cy*z0;
    const y2 = cp*y0 - sp*z1, z2 = sp*y0 + cp*z1;
    rot.push([x1,y2,z2]);
    maxr = Math.max(maxr, Math.abs(x1), Math.abs(y2));
  }
  const k = size/(maxr*2.35)*zoom;
  for (const p of rot) out.push([size/2 + p[0]*k, size/2 - p[1]*k]);
  return {pts: out, rot};
}

function triNormals(rot, tris) {
  return tris.map(t => {
    const a=rot[t[0]], b=rot[t[1]], c=rot[t[2]];
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const L=Math.hypot(nx,ny,nz)||1;
    return [nx/L, ny/L, nz/L];
  });
}

export { TEX, TARGETS, BUCKET, parseOBJ, warpTri, buildRig, deform, project, triNormals, influence };
