// Hero background: a particle network standing in for a routing graph.
//
// This lives in its own module on purpose. It is the only thing on the page
// that depends on a third-party CDN (three.js via the import map), and it is
// pure decoration. index.html imports it dynamically inside a try/catch, so an
// unreachable esm.sh — a proxy, an ad-blocker, a CDN outage — costs the page a
// background and nothing else.
//
// It used to be the first statement of the one module that also held the
// scroll-reveal observer, the theme toggle, the copy buttons and the version
// badge. A static `import` that fails aborts the whole module, so a blocked
// CDN left all 24 revealed sections at opacity 0 — the entire page below the
// hero, permanently invisible, with the version frozen at its stale literal.

import * as THREE from 'three';

// ── Canvas & scene setup ─────────────────────
const canvas = document.getElementById('bg-canvas');
const heroEl = document.getElementById('hero');
const renderer = new THREE.WebGLRenderer({canvas, alpha:true, antialias:true});
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 120);
camera.position.set(0, 2, 20);
scene.fog = new THREE.FogExp2(0x000000, 0.022);

function resize() {
  const w = heroEl.clientWidth, h = heroEl.clientHeight;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
resize();
window.addEventListener('resize', resize);

function accentColor() {
  return new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
}

// ── Nodes ────────────────────────────────────
const N = 170, DIST = 4.8, B = 10;
const nodes = Array.from({length: N}, () => {
  const hub = Math.random() > 0.87;
  return {
    x:(Math.random()-.5)*B*2.2, y:(Math.random()-.5)*B*.9, z:(Math.random()-.5)*B*2,
    vx:(Math.random()-.5)*.009, vy:(Math.random()-.5)*.005, vz:(Math.random()-.5)*.007,
    hub, size: hub ? .11 : .035+Math.random()*.03, phase: Math.random()*Math.PI*2,
  };
});

// Point cloud for regular nodes
const ptGeo = new THREE.BufferGeometry();
const ptPos = new Float32Array(N*3);
ptGeo.setAttribute('position', new THREE.BufferAttribute(ptPos, 3));
const ptMat = new THREE.PointsMaterial({size:.09, transparent:true, opacity:.75, sizeAttenuation:true, depthWrite:false});
const pts = new THREE.Points(ptGeo, ptMat);
scene.add(pts);

// Hub spheres
const hubs = nodes.filter(n=>n.hub).map(n=>{
  const g = new THREE.SphereGeometry(n.size, 7, 7);
  const m = new THREE.MeshBasicMaterial({transparent:true, opacity:.88});
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(n.x, n.y, n.z);
  scene.add(mesh);
  return {mesh, mat:m, node:n};
});

// Line segments for connections
const MAX = 450;
const lPos = new Float32Array(MAX*6);
const lGeo = new THREE.BufferGeometry();
lGeo.setAttribute('position', new THREE.BufferAttribute(lPos, 3));
lGeo.setDrawRange(0, 0);
const lMat = new THREE.LineBasicMaterial({transparent:true, opacity:.14, depthWrite:false});
const lines = new THREE.LineSegments(lGeo, lMat);
scene.add(lines);

// ── Routing packet ───────────────────────────
const pkGeo = new THREE.SphereGeometry(.13, 6, 6);
const pkMat = new THREE.MeshBasicMaterial({transparent:true, opacity:0});
const packet = new THREE.Mesh(pkGeo, pkMat);
scene.add(packet);

let path=[], pT=0, pActive=false;

function newPath() {
  const hs = nodes.filter(n=>n.hub);
  if (hs.length<2) return;
  const a=hs[Math.floor(Math.random()*hs.length)];
  let b; do{b=hs[Math.floor(Math.random()*hs.length)]}while(b===a);
  const p=[a]; let cur=a;
  for(let s=0;s<5;s++){
    let best=null,bd=DIST*1.8;
    for(const n of nodes){
      const dx=n.x-cur.x,dy=n.y-cur.y,dz=n.z-cur.z;
      const d=Math.sqrt(dx*dx+dy*dy+dz*dz);
      if(d<bd&&n!==cur&&!p.includes(n)){best=n;bd=d;}
    }
    if(!best) break;
    p.push(best); cur=best; if(cur===b) break;
  }
  p.push(b); path=p; pT=0; pActive=true; pkMat.opacity=.92;
}
newPath();

// ── Mouse parallax ───────────────────────────
let mx=0,my=0;
document.addEventListener('mousemove',e=>{mx=(e.clientX/innerWidth-.5)*2;my=(e.clientY/innerHeight-.5)*2;});

// ── Animation ────────────────────────────────
const clk = new THREE.Clock();
let routeT=0;

function frame() {
  requestAnimationFrame(frame);
  // Always read the clock so the delta never accumulates across skipped
  // frames, then bail before doing any work the viewer cannot see. The hero
  // canvas is decorative and fixed behind the fold; once it is scrolled past
  // (or the tab is hidden) rendering it is pure battery drain.
  const dt=clk.getDelta(), t=clk.getElapsedTime();
  if(document.hidden || scrollY > heroEl.clientHeight) return;
  routeT+=dt;
  if(routeT>3.8){newPath();routeT=0;}

  const col=accentColor();
  ptMat.color=col; lMat.color=col; pkMat.color=col;
  hubs.forEach(h=>{h.mat.color=col;});

  // drift nodes
  for(let i=0;i<N;i++){
    const n=nodes[i];
    n.x+=n.vx; n.y+=n.vy; n.z+=n.vz;
    if(Math.abs(n.x)>B*1.1)n.vx*=-1;
    if(Math.abs(n.y)>B*.5)n.vy*=-1;
    if(Math.abs(n.z)>B*1.1)n.vz*=-1;
    ptPos[i*3]=n.x; ptPos[i*3+1]=n.y; ptPos[i*3+2]=n.z;
  }
  ptGeo.attributes.position.needsUpdate=true;

  // hub positions + pulse
  hubs.forEach(({mesh,node},i)=>{
    mesh.position.set(node.x,node.y,node.z);
    const s=1+.12*Math.sin(t*1.4+i*1.1);
    mesh.scale.setScalar(s);
  });

  // connections
  let lc=0;
  for(let i=0;i<N&&lc<MAX;i++){
    for(let j=i+1;j<N&&lc<MAX;j++){
      const a=nodes[i],b=nodes[j];
      const dx=a.x-b.x,dy=a.y-b.y,dz=a.z-b.z;
      if(dx*dx+dy*dy+dz*dz<DIST*DIST){
        lPos[lc*6]=a.x;lPos[lc*6+1]=a.y;lPos[lc*6+2]=a.z;
        lPos[lc*6+3]=b.x;lPos[lc*6+4]=b.y;lPos[lc*6+5]=b.z;
        lc++;
      }
    }
  }
  lGeo.attributes.position.needsUpdate=true;
  lGeo.setDrawRange(0,lc*2);

  // packet travel
  if(pActive&&path.length>=2){
    pT+=dt*.38;
    const segs=path.length-1, gt=pT*segs;
    const si=Math.min(Math.floor(gt),segs-1);
    const st=gt-si;
    const a=path[si],b=path[si+1]||path[segs];
    packet.position.set(a.x+(b.x-a.x)*st,a.y+(b.y-a.y)*st,a.z+(b.z-a.z)*st);
    if(pT>=1) pkMat.opacity=Math.max(0,pkMat.opacity-dt*1.6);
  }

  // camera parallax — mouse XY + scroll Z
  const scrollFrac=Math.max(0,Math.min(1,scrollY/Math.max(1,heroEl.clientHeight)));
  const targetZ=20-scrollFrac*8;   // drift from z=20 into the network
  const baseY=2+scrollFrac*3;      // drift camera down slightly
  camera.position.x+=(mx*2.5-camera.position.x)*.018;
  camera.position.y+=((-my*1.8+baseY)-camera.position.y)*.018;
  camera.position.z+=(targetZ-camera.position.z)*.04;
  camera.lookAt(0,0,0);

  renderer.render(scene,camera);
}
frame();
