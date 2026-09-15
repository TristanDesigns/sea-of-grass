import { TEX, TARGETS, BUCKET, parseOBJ, warpTri, buildRig, deform,
         project, triNormals } from "./glass.js";

const $ = id => document.getElementById(id);
const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

/* Yaw sign depends on MediaPipe's matrix convention. If the prompts ask you to
 * turn the wrong way on first run, flip this and nothing else. */
const YAW_SIGN = 1;

const W = 600, H = 900;
const FRAME = {x0:44, y0:28, x1:W-44, y1:H-28};
const SPRING = 268, COL = 46, CORNER = 34;
const AP = {x0:112, y0:292, x1:W-112, y1:612};
const BAND = 636;

let M, rig, landmarker, stream = null, running = false;
let slots = TARGETS.map(t => ({target:t, lm:null, yaw:null, score:0, frame:null}));
let texture = null, morph = 0, morphing = false;

/* ------------------------------------------------------------ the frame */

const NS = "http://www.w3.org/2000/svg";
const el = (n,a) => { const e = document.createElementNS(NS,n);
  for (const k in a) e.setAttribute(k,a[k]); return e; };
const P = a => a.map(p => p.map(v => (+v).toFixed(2)).join(",")).join(" ");

function outline(f, spring, corner){
  const {x0,y0,x1,y1}=f, cx=(x0+x1)/2, r=(x1-x0)/2, p=[[x0,y1-corner]];
  for (let i=0;i<=12;i++){ const t=Math.PI - i/12*Math.PI/2;
    p.push([x0+corner+corner*Math.cos(t), y1-corner+corner*Math.sin(t)]); }
  for (let i=0;i<=12;i++){ const t=Math.PI/2 - i/12*Math.PI/2;
    p.push([x1-corner+corner*Math.cos(t), y1-corner+corner*Math.sin(t)]); }
  p.push([x1,spring]);
  for (let i=0;i<=64;i++){ const t=i/64*Math.PI;
    p.push([cx+r*Math.cos(t), spring-(spring-y0)*Math.sin(t)]); }
  p.push([x0,spring]);
  return p;
}
const stud = (cx,cy,r) => { const p=[]; for(let k=0;k<8;k++){ const th=Math.PI/4*k,
  rr=k%2?r*0.3:r; p.push([cx+rr*Math.cos(th), cy+rr*Math.sin(th)]); } return p; };
const eyeShape = (cx,cy,w,h) => { const p=[];
  for(let i=0;i<=22;i++){ const t=-1+i/11; p.push([cx+t*w, cy-h*Math.pow(Math.cos(t*Math.PI/2),.8)]); }
  for(let i=0;i<=22;i++){ const t=1-i/11; p.push([cx+t*w, cy+h*Math.pow(Math.cos(t*Math.PI/2),.8)]); }
  return p; };
const tear = (cx,cy,w,h) => { const p=[[cx,cy-h]];
  for(let i=0;i<=30;i++){ const t=-Math.PI/2+i/30*Math.PI*2;
    p.push([cx+w*Math.cos(t)*.92, cy+h*.42+w*Math.sin(t)*.92]); } return p; };

function lit(parent, pts, closed){
  const d = P(pts);
  for (const c of ["halo","mid","core"])
    parent.appendChild(el(closed?"polygon":"polyline", {points:d, class:"stroke "+c}));
}

const rayGroups = [];
function buildFrame(){
  const frame = $("frame");
  lit(frame, outline(FRAME, SPRING, CORNER), true);
  lit(frame, outline({x0:FRAME.x0+10,y0:FRAME.y0+10,x1:FRAME.x1-10,y1:FRAME.y1-10},
                     SPRING+6, CORNER-4), true);
  for (const sx of [FRAME.x0+COL, FRAME.x1-COL]) lit(frame, [[sx,SPRING+4],[sx,FRAME.y1-52]], false);
  for (let i=0;i<6;i++){
    const sy = SPRING+46 + i*((FRAME.y1-96)-(SPRING+46))/5;
    for (const sx of [FRAME.x0+COL/2+4, FRAME.x1-COL/2-4]) lit(frame, stud(sx,sy,11), true);
  }
  lit(frame, [[AP.x0,AP.y0],[AP.x1,AP.y0],[AP.x1,AP.y1],[AP.x0,AP.y1]], true);
  lit(frame, [[AP.x0,BAND],[AP.x1,BAND]], false);

  const apex=[(FRAME.x0+FRAME.x1)/2, SPRING-6], N=TARGETS.length, raysEl=$("rays");
  for (let i=0;i<N;i++){
    const f=i/(N-1), ang=(-160+140*f)*Math.PI/180;
    const len=132+56*Math.sin(Math.PI*f), sp=5.5*Math.PI/180;
    const tri=[apex,
      [apex[0]+Math.cos(ang-sp)*len, apex[1]+Math.sin(ang-sp)*len],
      [apex[0]+Math.cos(ang+sp)*len, apex[1]+Math.sin(ang+sp)*len]];
    const g=el("g",{});
    g.appendChild(el("polygon",{points:P(tri), class:"stroke unlit"}));
    const on=el("g",{opacity:0}); lit(on,tri,true); g.appendChild(on);
    raysEl.appendChild(g); rayGroups.push(on);
  }

  const eyeG=$("eye"), cx=(FRAME.x0+FRAME.x1)/2;
  lit(eyeG, eyeShape(cx, FRAME.y0+74, 30, 17), true);
  lit(eyeG, [[cx-9,FRAME.y0+74],[cx,FRAME.y0+66],[cx+9,FRAME.y0+74]], false);
  lit(eyeG, tear(cx, FRAME.y0+118, 11, 17), true);
  eyeG.appendChild(el("circle",{cx, cy:FRAME.y0+74, r:5,
    fill:"var(--amber-hi)", filter:"url(#bloom)"}));
}

/* Position the reflection canvas over the SVG's aperture, and the prompt and
 * controls into the empty run of frame between the band and the base. Both are
 * placed from the same constants the frame is drawn from, so nothing drifts
 * out of the box when the glass is resized. */
const GUI_TOP = BAND + 14;          // just clear of the band
const GUI_BOTTOM = FRAME.y1 - 34;   // just clear of the base corner

function placeFeed(){
  const box = $("glassBox"), feed = $("feed"), gui = $("gui");
  const k = box.clientWidth / W;

  feed.style.left = (AP.x0*k)+"px";
  feed.style.top  = (AP.y0*k)+"px";
  feed.style.width  = ((AP.x1-AP.x0)*k)+"px";
  feed.style.height = ((AP.y1-AP.y0)*k)+"px";
  feed.width  = Math.round((AP.x1-AP.x0));
  feed.height = Math.round((AP.y1-AP.y0));

  if (!gui) return;
  // Type scales with the frame, but not all the way down — below about 0.8 the
  // prompt stops being readable, and there is slack in the panel to absorb it.
  const s = Math.max(0.8, Math.min(1, k));
  box.style.setProperty("--s", s.toFixed(3));
  gui.style.left   = (AP.x0*k)+"px";
  gui.style.top    = (GUI_TOP*k)+"px";
  gui.style.width  = ((AP.x1-AP.x0)*k)+"px";
  gui.style.height = ((GUI_BOTTOM-GUI_TOP)*k)+"px";
  gui.classList.toggle("tight", box.clientWidth < 430);
}

/* ------------------------------------------------------------- capture */

function yawFromMatrix(m){
  // Column-major 4x4 from MediaPipe. Head forward transformed into camera space.
  const r02 = m[8], r22 = m[10];
  return YAW_SIGN * Math.atan2(r02, r22) * 180/Math.PI;
}

function sharpness(ctx, w, h){
  // Cheap focus proxy: mean absolute horizontal difference over a centre crop.
  const x0=(w*0.25)|0, y0=(h*0.2)|0, cw=(w*0.5)|0, ch=(h*0.5)|0;
  const d = ctx.getImageData(x0,y0,cw,ch).data;
  let acc=0, n=0;
  for (let y=0;y<ch;y+=3){
    for (let x=3;x<cw;x+=3){
      const i=(y*cw+x)*4, j=(y*cw+x-3)*4;
      acc += Math.abs(d[i]-d[j]); n++;
    }
  }
  return n ? acc/n : 0;
}

function setPrompt(head, sub){ $("pHead").textContent = head; $("pSub").textContent = sub||""; }

function nextTarget(yaw){
  const rem = slots.filter(s => !s.lm);
  if (!rem.length) return null;
  if (yaw === null) return rem.reduce((a,b)=>Math.abs(a.target)<Math.abs(b.target)?a:b);
  return rem.reduce((a,b)=>Math.abs(a.target-yaw)<Math.abs(b.target-yaw)?a:b);
}

async function openGlass(){
  setPrompt("Opening…", "asking for the camera");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video:{width:{ideal:1280}, height:{ideal:960}, facingMode:"user"}, audio:false});
  } catch(e){
    setPrompt("The glass stayed shut", "camera permission was refused");
    return;
  }
  const v = $("video"); v.srcObject = stream; await v.play();

  if (!landmarker){
    setPrompt("Waking…", "loading the detector");
    const {FaceLandmarker, FilesetResolver} = await import(`${MP}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    landmarker = await FaceLandmarker.createFromOptions(files, {
      baseOptions:{modelAssetPath:"./face_landmarker.task", delegate:"GPU"},
      runningMode:"VIDEO", numFaces:1,
      outputFaceBlendshapes:true, outputFacialTransformationMatrixes:true});
  }
  $("open").disabled = true; $("reset").disabled = false;
  running = true; setCapturing(true); requestAnimationFrame(tick);
}

/* The glass looking is a mode, not just a flag: the name field has done its
 * job, the buttons step back, and the keys line says what is available. */
function setCapturing(on){
  $("gui").classList.toggle("capturing", on);
  if (on) setKeys("ESC to quit");
}

function setKeys(s){ $("keys").textContent = s; }

function closeGlass(){
  running = false;
  setCapturing(false);
  if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; }
  $("open").disabled = false;
  $("reset").disabled = true;
  setPrompt("The glass is closed", "nothing is running until you open it");
}

let lastTs = -1;
function tick(){
  if (!running) return;
  const v = $("video"), feed = $("feed"), ctx = feed.getContext("2d", {willReadFrequently:true});
  if (v.readyState >= 2){
    // Cover-fit the video into the aperture, mirrored so it reads as a mirror.
    const tw=feed.width, th=feed.height, s=Math.max(tw/v.videoWidth, th/v.videoHeight);
    const dw=v.videoWidth*s, dh=v.videoHeight*s;
    ctx.save(); ctx.translate(tw,0); ctx.scale(-1,1);
    ctx.drawImage(v, (tw-dw)/2, (th-dh)/2, dw, dh); ctx.restore();

    const ts = performance.now();
    if (ts !== lastTs){
      lastTs = ts;
      const res = landmarker.detectForVideo(v, ts);
      handle(res, v, ctx, feed);
    }
  }
  requestAnimationFrame(tick);
}

function handle(res, v, ctx, feed){
  const got = res.faceLandmarks && res.faceLandmarks.length;
  if (!got){ setPrompt("Step into the glass", "face the camera"); return; }

  const lm = res.faceLandmarks[0];
  const mtx = res.facialTransformationMatrixes?.[0]?.data;
  const yaw = mtx ? yawFromMatrix(mtx) : null;
  const bs = {};
  (res.faceBlendshapes?.[0]?.categories || []).forEach(c => bs[c.categoryName] = c.score);

  // Refuse a frame the face is doing something in: a blink or a grin banked at
  // one angle and not another makes a texture that is subtly wrong for good.
  const blink = Math.max(bs.eyeBlinkLeft||0, bs.eyeBlinkRight||0);
  const open  = bs.jawOpen||0;
  const smile = Math.max(bs.mouthSmileLeft||0, bs.mouthSmileRight||0);
  if (blink > 0.45){ setPrompt("Open your eyes", "look into the glass"); return; }
  if (open  > 0.32){ setPrompt("Close your mouth", "at rest"); return; }
  if (smile > 0.42){ setPrompt("Let your face rest", "no expression, for now"); return; }

  const focus = sharpness(ctx, feed.width, feed.height);
  const tgt = nextTarget(yaw);

  if (tgt && yaw !== null && Math.abs(yaw - tgt.target) <= BUCKET){
    if (focus > tgt.score){
      // Keep the frame itself: the unwrap needs pixels, not just landmarks.
      const keep = document.createElement("canvas");
      keep.width = v.videoWidth; keep.height = v.videoHeight;
      keep.getContext("2d").drawImage(v,0,0);
      tgt.lm = lm; tgt.yaw = yaw; tgt.score = focus; tgt.frame = keep;
      paintRays();
    }
    setPrompt("Be still", "the glass is looking");
  } else if (tgt && yaw !== null){
    const left = tgt.target > yaw;
    setPrompt(left ? "Turn to your left" : "Turn to your right",
              "slowly, eyes upon the glass");
  } else if (!tgt){
    setPrompt("It is done", "save the view");
    $("save").disabled = false;
    setKeys("S to save · ESC to quit");
  }
}

function paintRays(){
  const ordered = [...slots].sort((a,b)=>b.target-a.target);
  ordered.forEach((s,i)=> rayGroups[i].setAttribute("opacity", s.lm ? 1 : 0));
  const done = slots.filter(s=>s.lm).length;
  $("save").disabled = done < slots.length;
}

/* ---------------------------------------------------------- the texture */

/* One pass, best view per triangle. Blending several views in canvas needs a
 * float accumulator; picking the most front-on view for each face gets most of
 * the benefit for a fraction of the work. */
function buildTexture(){
  const c = document.createElement("canvas"); c.width = c.height = TEX;
  const ctx = c.getContext("2d");

  // Flat skin ground first, sampled from the frontal view's cheeks, so the
  // area outside the face island is never black.
  const frontal = slots.reduce((a,b)=>Math.abs(a.yaw)<Math.abs(b.yaw)?a:b);
  ctx.fillStyle = sampleSkin(frontal) || "#caa08c";
  ctx.fillRect(0,0,TEX,TEX);

  const views = slots.filter(s=>s.lm);
  for (let t=0; t<M.tris.length; t++){
    const tri = M.tris[t], n = M.normals[t];
    let best=null, bestQ=-1;
    for (const v of views){
      const a = v.yaw*Math.PI/180;
      const q = n[0]*Math.sin(a) + n[2]*Math.cos(a);   // foreshortening
      if (q > bestQ){ bestQ = q; best = v; }
    }
    if (!best || bestQ <= 0.05) continue;
    const w = best.frame.width, h = best.frame.height;
    const src = tri.map(i => [best.lm[i].x*w, best.lm[i].y*h]);
    const dst = tri.map(i => M.uvPx[i]);
    warpTri(ctx, best.frame, src, dst, 0.8);
  }
  return c;
}

function sampleSkin(view){
  if (!view || !view.frame) return null;
  const f = view.frame, c = document.createElement("canvas");
  c.width = c.height = 24;
  const g = c.getContext("2d");
  // Two cheek patches, below the eye and inboard of the ear.
  let r=0,gs=0,b=0,n=0;
  for (const idx of [50,280,205,425,101,330]){
    const p = view.lm[idx];
    g.drawImage(f, p.x*f.width-12, p.y*f.height-12, 24,24, 0,0,24,24);
    const d = g.getImageData(0,0,24,24).data;
    for (let i=0;i<d.length;i+=4){ r+=d[i]; gs+=d[i+1]; b+=d[i+2]; n++; }
  }
  return n ? `rgb(${(r/n)|0},${(gs/n)|0},${(b/n)|0})` : null;
}

/* ------------------------------------------------------------- the head */

let headYaw = 0, headPitch = 0, headZoom = 0.92, mode = "clay";
let dragging = false, dragX = 0, dragY = 0;
const amounts = {smile:0, jaw:0, brow:0, blink:0, squint:0};

function drawHead(){
  const cv = $("head"), ctx = cv.getContext("2d");
  const S = cv.width;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle = "#0d090a"; ctx.fillRect(0,0,S,S);
  if (!M) return;

  const verts = deform(M.verts, rig, amounts);
  const {pts, rot} = project(verts, headYaw*Math.PI/180, headPitch*Math.PI/180,
                             S, headZoom);
  const nrm = triNormals(rot, M.tris);

  // Painter's algorithm: far faces first, so near ones cover them.
  const order = M.tris.map((t,i)=>[i, (rot[t[0]][2]+rot[t[1]][2]+rot[t[2]][2])/3])
                      .sort((a,b)=>a[1]-b[1]);

  if (mode === "points"){
    ctx.fillStyle = "#ffbe46";
    for (let i=0;i<pts.length;i++){
      ctx.fillRect(pts[i][0]-1, pts[i][1]-1, 2, 2);
    }
    return;
  }

  if (mode === "wire"){
    ctx.strokeStyle = "rgba(255,190,70,.55)"; ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (const [i] of order){
      if (nrm[i][2] <= 0.02) continue;
      const t = M.tris[i];
      ctx.moveTo(pts[t[0]][0], pts[t[0]][1]);
      ctx.lineTo(pts[t[1]][0], pts[t[1]][1]);
      ctx.lineTo(pts[t[2]][0], pts[t[2]][1]);
      ctx.closePath();
    }
    ctx.stroke();
    return;
  }

  // Clay: flat-shaded by facing. Always drawn, so the texture has something
  // to fade in over.
  for (const [i] of order){
    if (nrm[i][2] <= 0.02) continue;
    const tri = M.tris[i], dst = tri.map(j => pts[j]);
    const sh = Math.max(0, Math.min(1, nrm[i][2]));
    const v = (26 + 92*Math.pow(sh, 0.8))|0;
    ctx.fillStyle = `rgb(${v},${(v*0.96)|0},${(v*0.93)|0})`;
    ctx.beginPath();
    ctx.moveTo(dst[0][0],dst[0][1]); ctx.lineTo(dst[1][0],dst[1][1]);
    ctx.lineTo(dst[2][0],dst[2][1]); ctx.closePath(); ctx.fill();
  }

  if (mode === "tex" && texture && morph > 0){
    ctx.globalAlpha = morph;
    for (const [i] of order){
      if (nrm[i][2] <= 0.02) continue;
      const tri = M.tris[i];
      warpTri(ctx, texture, tri.map(j=>M.uvPx[j]), tri.map(j=>pts[j]), 0.7);
    }
    ctx.globalAlpha = 1;
  }
}

function animateMorph(){
  if (!morphing) return;
  morph = Math.min(1, morph + 0.022);
  drawHead();
  if (morph < 1) requestAnimationFrame(animateMorph); else morphing = false;
}

/* ------------------------------------------------------------------ wire */

function syncView(){
  $("s-yaw").value = headYaw.toFixed(0);   $("o-yaw").textContent = headYaw.toFixed(0)+"°";
  $("s-pitch").value = headPitch.toFixed(0); $("o-pitch").textContent = headPitch.toFixed(0)+"°";
  $("s-zoom").value = (headZoom*100).toFixed(0); $("o-zoom").textContent = headZoom.toFixed(2);
}

function bindSliders(){
  for (const k of ["smile","jaw","brow","blink","squint"]){
    const s = $("s-"+k), o = $("o-"+k);
    s.addEventListener("input", ()=>{ amounts[k]=s.value/100; o.textContent=s.value; drawHead(); });
  }
  $("s-yaw").addEventListener("input", e=>{ headYaw=+e.target.value; syncView(); drawHead(); });
  $("s-pitch").addEventListener("input", e=>{ headPitch=+e.target.value; syncView(); drawHead(); });
  $("s-zoom").addEventListener("input", e=>{ headZoom=e.target.value/100; syncView(); drawHead(); });

  const cv=$("head");
  cv.addEventListener("pointerdown", e=>{
    dragging=true; dragX=e.clientX; dragY=e.clientY; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointermove", e=>{
    if(!dragging) return;
    headYaw   = Math.max(-70, Math.min(70, headYaw + (e.clientX-dragX)*0.45));
    headPitch = Math.max(-40, Math.min(40, headPitch - (e.clientY-dragY)*0.35));
    dragX=e.clientX; dragY=e.clientY; syncView(); drawHead();
  });
  addEventListener("pointerup", ()=> dragging=false);
  cv.addEventListener("wheel", e=>{
    e.preventDefault();
    headZoom = Math.max(0.6, Math.min(2.2, headZoom * (e.deltaY > 0 ? 0.94 : 1.06)));
    syncView(); drawHead();
  }, {passive:false});

  document.querySelectorAll(".mode").forEach(b => b.addEventListener("click", ()=>{
    if (b.disabled) return;
    mode = b.dataset.mode;
    document.querySelectorAll(".mode").forEach(x => x.classList.toggle("on", x===b));
    drawHead();
  }));
  $("vreset").addEventListener("click", ()=>{
    headYaw=0; headPitch=0; headZoom=0.92; syncView(); drawHead(); });
}

$("open").addEventListener("click", openGlass);
$("reset").addEventListener("click", ()=>{
  slots = TARGETS.map(t=>({target:t, lm:null, yaw:null, score:0, frame:null}));
  paintRays(); texture=null; morph=0; drawHead();
  $("save").disabled = true;
  setPrompt("Start again", "turn slowly");
  if (running) setKeys("ESC to quit");
});
$("save").addEventListener("click", ()=>{
  texture = buildTexture();
  morph = 0; morphing = true;
  // Switch the viewer to texture so the morph is actually visible.
  mode = "tex";
  $("mTex").disabled = false;
  document.querySelectorAll(".mode").forEach(x => x.classList.toggle("on", x.id==="mTex"));
  animateMorph();
  const nm = $("name").value.trim();
  setPrompt("Kept", nm ? `${nm.toUpperCase()} — the head below is wearing your face` :
                         "the head below is wearing your face");
  running = false;
  setCapturing(false);
  if (stream){ stream.getTracks().forEach(t=>t.stop()); stream = null; }
  $("open").disabled = false;
});

/* Keyboard, for the version of this that runs on a plinth at a show. */
addEventListener("keydown", e => {
  if (e.key === "Escape" && (running || stream)){ e.preventDefault(); closeGlass(); return; }
  const typing = document.activeElement === $("name");
  if (!typing && (e.key === "s" || e.key === "S") && !$("save").disabled){
    e.preventDefault(); $("save").click();
  }
});

addEventListener("resize", placeFeed);

(async () => {
  buildFrame(); placeFeed();
  const text = await (await fetch("./canonical_face_model.obj")).text();
  M = parseOBJ(text);
  rig = buildRig(M.verts);
  $("vstat").textContent =
    `${M.verts.length} vertices · ${M.tris.length} faces · MediaPipe canonical face model`;
  bindSliders(); syncView(); drawHead();
})();
