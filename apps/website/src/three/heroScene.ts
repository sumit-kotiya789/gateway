// Hero 3D scene: a faceted core (your app) inside a geodesic shell, orbit rings carrying address nodes, chain blocks
// drifting around it and streams of deposits flowing in. Loaded lazily; pauses off-screen and in hidden tabs;
// renders a single still frame for prefers-reduced-motion. No textures from URLs (CSP): glows are canvas-drawn.
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Group,
  IcosahedronGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  type Object3D,
  OctahedronGeometry,
  PerspectiveCamera,
  PMREMGenerator,
  PointLight,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export interface HeroScene { dispose(): void }

const GREEN = 0x34d65c;
const MINT = 0x8dffb0;
const TEAL = 0x2be4c4;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function glowTexture(inner: string, outer: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (g) {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, inner);
    grd.addColorStop(0.25, outer);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

const STREAM_VERT = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;
attribute vec3 aStart;
attribute vec3 aCtrl;
attribute float aSeed;
attribute float aSpeed;
varying float vAlpha;
varying float vT;
void main() {
  float t = fract(uTime * aSpeed + aSeed);
  float e = t * t * (3.0 - 2.0 * t) * 0.4 + t * 0.6;
  float it = 1.0 - e;
  vec3 p = it * it * aStart + 2.0 * it * e * aCtrl;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * (0.55 + 0.9 * e) * (10.0 / -mv.z);
  vAlpha = smoothstep(0.0, 0.14, t) * (1.0 - smoothstep(0.8, 0.96, t));
  vT = e;
}`;

const STREAM_FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
varying float vAlpha;
varying float vT;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  gl_FragColor = vec4(mix(uColorA, uColorB, vT), a * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createHeroScene(canvas: HTMLCanvasElement, opts: { reducedMotion: boolean }): HeroScene {
  const host = canvas.parentElement ?? canvas;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04).texture;
  scene.environment = env;
  const rand = rng(7);
  const textures: CanvasTexture[] = [];
  const glow = glowTexture('rgba(255,255,255,1)', 'rgba(140,255,176,0.35)');
  const dot = glowTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0.4)');
  textures.push(glow, dot);

  const root = new Group();
  scene.add(root);
  const tilt = new Group();
  root.add(tilt);

  // Core: faceted, iridescent crystal with lit edges and a halo.
  const coreGeo = new IcosahedronGeometry(1.12, 0);
  const core = new Mesh(
    coreGeo,
    new MeshPhysicalMaterial({
      color: 0x1d9a45,
      metalness: 0.4,
      roughness: 0.14,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      iridescence: 0.85,
      iridescenceIOR: 1.7,
      envMapIntensity: 1.5,
      flatShading: true,
      emissive: 0x05391a,
      emissiveIntensity: 0.7,
    }),
  );
  const coreEdges = new LineSegments(new EdgesGeometry(coreGeo), new LineBasicMaterial({ color: MINT, transparent: true, opacity: 0.6, blending: AdditiveBlending, depthWrite: false }));
  coreEdges.scale.setScalar(1.004);
  core.add(coreEdges);
  const inner = new Mesh(new OctahedronGeometry(0.42, 0), new MeshBasicMaterial({ color: 0xc8ffd7 }));
  core.add(inner);
  tilt.add(core);

  const halo = new Sprite(new SpriteMaterial({ map: glow, color: GREEN, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false }));
  halo.scale.setScalar(7.5);
  tilt.add(halo);

  // Geodesic shell with glowing vertices.
  const shellGeo = new IcosahedronGeometry(2.05, 1);
  const shell = new Group();
  shell.add(new LineSegments(new EdgesGeometry(shellGeo), new LineBasicMaterial({ color: GREEN, transparent: true, opacity: 0.17, depthWrite: false })));
  const seen = new Set<string>();
  const verts: number[] = [];
  const pos = shellGeo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    verts.push(x, y, z);
  }
  const vGeo = new BufferGeometry();
  vGeo.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
  shell.add(new Points(vGeo, new PointsMaterial({ color: MINT, size: 0.12, map: dot, transparent: true, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true })));
  tilt.add(shell);

  // Orbit rings with address nodes.
  const nodeGeo = new SphereGeometry(0.055, 16, 16);
  const nodeMat = new MeshBasicMaterial({ color: 0xe2ffe9 });
  const nodeGlowMat = new SpriteMaterial({ map: glow, color: GREEN, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false });
  const spinners: { g: Group; speed: number }[] = [];
  const ringDefs = [
    { r: 2.85, rot: [1.25, 0.18, 0.1], speed: 0.16, nodes: 3, color: GREEN, opacity: 0.4 },
    { r: 3.45, rot: [1.05, -0.62, 0.35], speed: -0.1, nodes: 4, color: TEAL, opacity: 0.26 },
    { r: 4.15, rot: [1.48, 0.55, -0.3], speed: 0.06, nodes: 2, color: GREEN, opacity: 0.18 },
  ] as const;
  for (const d of ringDefs) {
    const g = new Group();
    g.rotation.set(d.rot[0], d.rot[1], d.rot[2]);
    g.add(new Mesh(new TorusGeometry(d.r, 0.0065, 6, 240), new MeshBasicMaterial({ color: d.color, transparent: true, opacity: d.opacity, depthWrite: false })));
    const spin = new Group();
    for (let i = 0; i < d.nodes; i++) {
      const a = (i / d.nodes) * Math.PI * 2 + rand();
      const n = new Mesh(nodeGeo, nodeMat);
      n.position.set(Math.cos(a) * d.r, Math.sin(a) * d.r, 0);
      const s = new Sprite(nodeGlowMat);
      s.scale.setScalar(0.55);
      n.add(s);
      spin.add(n);
    }
    g.add(spin);
    tilt.add(g);
    spinners.push({ g: spin, speed: d.speed });
  }

  // Chain blocks drifting around the core.
  const blockGeo = new BoxGeometry(0.34, 0.34, 0.34);
  const blockEdgeGeo = new EdgesGeometry(blockGeo);
  const blockMat = new MeshPhysicalMaterial({ color: 0x0e2c17, metalness: 0.6, roughness: 0.25, transparent: true, opacity: 0.6, envMapIntensity: 1.2 });
  const blockLine = new LineBasicMaterial({ color: 0x6dfa8e, transparent: true, opacity: 0.75 });
  const blocks: { m: Mesh; base: Vector3; phase: number; spin: Vector3 }[] = [];
  for (let i = 0; i < 11; i++) {
    // Mostly beside and behind the core: nothing drifts toward the camera or up into the header.
    const dir = new Vector3(rand() * 2 - 1, (rand() * 2 - 1) * 0.6, -0.2 - rand() * 0.8).normalize();
    const base = dir.multiplyScalar(3.1 + rand() * 2);
    base.y = Math.max(-2.6, Math.min(2.2, base.y));
    const m = new Mesh(blockGeo, blockMat);
    m.add(new LineSegments(blockEdgeGeo, blockLine));
    m.position.copy(base);
    m.scale.setScalar(0.6 + rand() * 0.6);
    m.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    root.add(m);
    blocks.push({ m, base, phase: rand() * Math.PI * 2, spin: new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.6) });
  }

  // Deposit streams: particles riding quadratic curves from far away into the core (computed on the GPU).
  const STREAMS = 18;
  const PER = 46;
  const N = STREAMS * PER;
  const aStart = new Float32Array(N * 3);
  const aCtrl = new Float32Array(N * 3);
  const aSeed = new Float32Array(N);
  const aSpeed = new Float32Array(N);
  const tmp = new Vector3();
  for (let s = 0; s < STREAMS; s++) {
    const dir = new Vector3(rand() * 2 - 1, (rand() * 2 - 1) * 0.8, (rand() * 2 - 1) * 0.6).normalize();
    const start = dir.clone().multiplyScalar(6.5 + rand() * 3);
    const perp = tmp.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).cross(dir).normalize().multiplyScalar(1.4 + rand() * 1.8);
    const ctrl = start.clone().multiplyScalar(0.42).add(perp);
    const speed = 0.045 + rand() * 0.04;
    for (let p = 0; p < PER; p++) {
      const i = s * PER + p;
      const j = () => (rand() - 0.5) * 0.16;
      aStart.set([start.x + j(), start.y + j(), start.z + j()], i * 3);
      aCtrl.set([ctrl.x + j() * 2, ctrl.y + j() * 2, ctrl.z + j() * 2], i * 3);
      aSeed[i] = p / PER + rand() * 0.015;
      aSpeed[i] = speed;
    }
  }
  const streamGeo = new BufferGeometry();
  streamGeo.setAttribute('position', new BufferAttribute(new Float32Array(N * 3), 3));
  streamGeo.setAttribute('aStart', new BufferAttribute(aStart, 3));
  streamGeo.setAttribute('aCtrl', new BufferAttribute(aCtrl, 3));
  streamGeo.setAttribute('aSeed', new BufferAttribute(aSeed, 1));
  streamGeo.setAttribute('aSpeed', new BufferAttribute(aSpeed, 1));
  const streamMat = new ShaderMaterial({
    vertexShader: STREAM_VERT,
    fragmentShader: STREAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: 9 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uColorA: { value: new Color(TEAL) },
      uColorB: { value: new Color(0xb9ffc9) },
    },
  });
  const streams = new Points(streamGeo, streamMat);
  streams.frustumCulled = false;
  tilt.add(streams);

  // Dust.
  const DUST = 1300;
  const dust = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    const v = new Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize().multiplyScalar(8 + rand() * 20);
    dust.set([v.x, v.y, v.z], i * 3);
  }
  const dustGeo = new BufferGeometry();
  dustGeo.setAttribute('position', new BufferAttribute(dust, 3));
  const dustPts = new Points(dustGeo, new PointsMaterial({ color: 0x9dffbe, size: 0.09, map: dot, transparent: true, opacity: 0.55, depthWrite: false, blending: AdditiveBlending }));
  scene.add(dustPts);

  // Light.
  scene.add(new AmbientLight(0x88aa99, 0.35));
  const key = new PointLight(GREEN, 45, 0, 2);
  key.position.set(4, 3, 5);
  const rim = new PointLight(TEAL, 32, 0, 2);
  rim.position.set(-5, -2.5, 2);
  const fill = new DirectionalLight(0xffffff, 0.7);
  fill.position.set(0, 4, 6);
  scene.add(key, rim, fill);

  // Layout, input, loop.
  let wide = true;
  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    wide = camera.aspect > 1.15;
    const halfW = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z * camera.aspect;
    root.position.x = wide ? Math.min(3.4, halfW * 0.44) : 0;
    root.position.y = wide ? 0 : 0.9;
    const s = wide ? 1 : Math.min(0.82, camera.aspect * 1.05);
    root.userData.scale = s;
    if (opts.reducedMotion) root.scale.setScalar(s);
    if (opts.reducedMotion) renderer.render(scene, camera);
  };

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointer = (e: PointerEvent) => {
    pointer.tx = e.clientX / window.innerWidth - 0.5;
    pointer.ty = e.clientY / window.innerHeight - 0.5;
  };

  let raf = 0;
  let running = false;
  let visible = true;
  let last = performance.now();
  let time = 0;
  const t0 = last;

  const frame = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    const intro = Math.min(1, (now - t0) / 1800);
    const ease = 1 - Math.pow(1 - intro, 3);
    const baseScale = typeof root.userData.scale === 'number' ? root.userData.scale : 1;
    root.scale.setScalar(baseScale * (0.72 + 0.28 * ease));

    pointer.x += (pointer.tx - pointer.x) * 0.045;
    pointer.y += (pointer.ty - pointer.y) * 0.045;
    const scroll = Math.min(1, window.scrollY / Math.max(1, host.clientHeight));
    tilt.rotation.x = pointer.y * 0.35 + scroll * 0.5;
    tilt.rotation.y = pointer.x * 0.55 + scroll * 0.9;
    camera.position.z = 10 + scroll * 3.5;

    core.rotation.y += dt * 0.32;
    core.rotation.x += dt * 0.12;
    inner.rotation.y -= dt * 0.9;
    shell.rotation.y -= dt * 0.05;
    shell.rotation.z += dt * 0.02;
    for (const s of spinners) s.g.rotation.z += dt * s.speed;
    for (const b of blocks) {
      b.m.position.set(b.base.x, b.base.y + Math.sin(time * 0.6 + b.phase) * 0.18, b.base.z);
      b.m.rotation.x += dt * b.spin.x;
      b.m.rotation.y += dt * b.spin.y;
    }
    root.rotation.y = time * 0.03;
    dustPts.rotation.y = time * 0.008;
    halo.material.opacity = 0.42 + Math.sin(time * 1.4) * 0.08;
    const u = streamMat.uniforms.uTime;
    if (u) u.value = time;

    renderer.render(scene, camera);
    if (running) raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (running || opts.reducedMotion || !visible || document.hidden) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  const io = new IntersectionObserver((es) => {
    visible = es.some((e) => e.isIntersecting);
    if (visible) start();
    else stop();
  });
  io.observe(host);
  const onVis = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVis);
  if (!opts.reducedMotion) window.addEventListener('pointermove', onPointer, { passive: true });

  resize();
  if (opts.reducedMotion) {
    // A still, slightly turned frame.
    core.rotation.set(0.4, 0.6, 0);
    tilt.rotation.set(0.12, -0.25, 0);
    const u = streamMat.uniforms.uTime;
    if (u) u.value = 3;
    renderer.render(scene, camera);
  } else start();

  return {
    dispose() {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointermove', onPointer);
      scene.traverse((o: Object3D) => {
        const m = o as Partial<Mesh>;
        m.geometry?.dispose();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => { x.dispose(); });
        else mat?.dispose();
      });
      for (const t of textures) t.dispose();
      env.dispose();
      pmrem.dispose();
      room.dispose();
      renderer.dispose();
    },
  };
}
