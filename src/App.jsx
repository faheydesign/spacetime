import { useEffect, useRef, useState, useCallback } from "react";
import "./App.css";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Clock,
  Color,
  DoubleSide,
  FogExp2,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector2,
  WebGLRenderer,
} from "three";

const GRID = 24;
let SEGS = 80;
let MAX_MASSES = 4;
const NUM_PARTICLES = 18;
const TRAIL_LENGTH = 90;
const G = 2.8;
const MASS_MIN = 0.5;
const MASS_MAX = 8.0;

let nextId = 1;

const PARTICLE_COLORS = [
  [0.4, 0.9, 1.0],[1.0, 0.6, 0.2],[0.5, 1.0, 0.6],[1.0, 0.3, 0.5],
  [0.7, 0.4, 1.0],[0.2, 0.8, 1.0],[1.0, 0.85, 0.2],[0.9, 0.4, 1.0],
  [0.3, 1.0, 0.8],[1.0, 0.5, 0.3],[0.5, 0.7, 1.0],[0.8, 1.0, 0.3],
  [1.0, 0.3, 0.7],[0.3, 0.9, 0.6],[0.9, 0.7, 0.3],[0.4, 0.6, 1.0],
  [1.0, 0.4, 0.4],[0.6, 1.0, 0.5],
];

// Color temperature: dim amber (low mass) → golden (mid) → blue-white (high)
function massColor(mass) {
  const t = Math.max(0, Math.min(1, (mass - MASS_MIN) / (MASS_MAX - MASS_MIN)));
  let r, g, b;
  if (t < 0.5) {
    // amber → warm white
    const u = t / 0.5;
    r = 1.0;
    g = 0.45 + u * 0.45;
    b = 0.08 + u * 0.55;
  } else {
    // warm white → blue-white
    const u = (t - 0.5) / 0.5;
    r = 1.0 - u * 0.18;
    g = 0.9 + u * 0.08;
    b = 0.63 + u * 0.37;
  }
  return new Color(r, g, b);
}

// Neutral white radial glow — tinted per-mass via SpriteMaterial.color
function createGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.15)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  return new CanvasTexture(canvas);
}

function spawnParticle(idx) {
  const orbitR = 3.5 + (idx % 6) * 1.1 + Math.random() * 1.5;
  const angle = (idx / NUM_PARTICLES) * Math.PI * 2 + Math.random() * 0.4;
  const px = Math.cos(angle) * orbitR;
  const pz = Math.sin(angle) * orbitR;
  const speed = Math.sqrt(G * 3.8 / orbitR) * (0.85 + Math.random() * 0.3);
  return { px, pz, vx: -Math.sin(angle) * speed, vz: Math.cos(angle) * speed, trail: [] };
}

function buildMassVisual(massVal, glowTex) {
  const col = massColor(massVal);
  const grp = new Group();
  grp.add(new Mesh(
    new SphereGeometry(0.1 + massVal * 0.04, 12, 12),
    new MeshBasicMaterial({ color: col })
  ));
  grp.add(new Mesh(
    new TorusGeometry(0.3 + massVal * 0.06, 0.02, 8, 40),
    new MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false })
  ));
  const sprite = new Sprite(new SpriteMaterial({
    map: glowTex, color: col, blending: AdditiveBlending, transparent: true, opacity: 0.75, depthWrite: false,
  }));
  sprite.scale.setScalar(massVal * 1.6);
  grp.add(sprite);
  return grp;
}

export default function SpacetimeCurvature() {
  const mountRef = useRef(null);
  const hideAddMassTooltipRef = useRef(() => {});

  // Shared simulation state — Three.js reads directly from these refs
  const massesRef = useRef([]);          // [{ id, x, z, mass }]
  const massVisualsRef = useRef(new Map()); // id → Group

  // Exposed imperative handles so React callbacks can reach into the Three.js scene
  const sceneApiRef = useRef(null);

  // React UI state — only drives panel re-render
  const [massesUI, setMassesUI] = useState([]);
  const [showAddMassTooltip, setShowAddMassTooltip] = useState(true);
  const [isMobileUI, setIsMobileUI] = useState(() => window.innerWidth < 768);
  const [drawerOpen, setDrawerOpen] = useState(false);

  hideAddMassTooltipRef.current = () => setShowAddMassTooltip(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobileUI(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // ── REACT CALLBACKS ───────────────────────────────────────────────────────
  const handleSlider = useCallback((id, rawVal) => {
    const val = parseFloat(rawVal);
    const m = massesRef.current.find(m => m.id === id);
    if (!m) return;
    m.mass = val;

    const grp = massVisualsRef.current.get(id);
    if (grp) {
      const col = massColor(val);
      grp.children[0].geometry.dispose();
      grp.children[0].geometry = new SphereGeometry(0.1 + val * 0.04, 12, 12);
      grp.children[0].material.color.copy(col);
      grp.children[1].geometry.dispose();
      grp.children[1].geometry = new TorusGeometry(0.3 + val * 0.06, 0.02, 8, 40);
      grp.children[1].material.color.copy(col);
      grp.children[2].material.color.copy(col);
      grp.children[2].scale.setScalar(val * 1.6);
    }

    setMassesUI(massesRef.current.map(m => ({ ...m })));
  }, []);

  const handleRemove = useCallback((id) => {
    massesRef.current = massesRef.current.filter(m => m.id !== id);
    const grp = massVisualsRef.current.get(id);
    if (grp && sceneApiRef.current) {
      sceneApiRef.current.massGroup.remove(grp);
      grp.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    massVisualsRef.current.delete(id);
    setMassesUI(massesRef.current.map(m => ({ ...m })));
  }, []);

  // ── THREE.JS SETUP ────────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    SEGS = 80;
    MAX_MASSES = 4;
    if (window.innerWidth < 768) {
      SEGS = 48;
      MAX_MASSES = 2;
    }

    let W = mount.clientWidth, H = mount.clientHeight;

    const simState = {
      theta: 0.6, phi: 1.05, radius: 32,
      isDragging: false, hasDragged: false,
      isPinching: false,
      prevPinchDist: 0,
      prevMouse: { x: 0, y: 0 },
      ripples: [],
      particles: Array.from({ length: NUM_PARTICLES }, (_, i) => spawnParticle(i)),
    };

    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x020307, 1);
    mount.appendChild(renderer.domElement);

    const scene = new Scene();
    scene.fog = new FogExp2(0x020307, 0.012);

    const camera = new PerspectiveCamera(38, W / H, 0.1, 500);
    const updateCamera = () => {
      const { theta, phi, radius } = simState;
      camera.position.set(
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.cos(theta)
      );
      camera.lookAt(0, -2, 0);
    };
    updateCamera();

    // Stars
    const starPos = new Float32Array(2500 * 3);
    for (let i = 0; i < 2500; i++) {
      const t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
      const r = 160 + Math.random() * 80;
      starPos[i*3] = r*Math.sin(p)*Math.cos(t); starPos[i*3+1] = r*Math.sin(p)*Math.sin(t); starPos[i*3+2] = r*Math.cos(p);
    }
    const starGeo = new BufferGeometry();
    starGeo.setAttribute("position", new BufferAttribute(starPos, 3));
    scene.add(new Points(starGeo, new PointsMaterial({ color: 0xffffff, size: 0.25, transparent: true, opacity: 0.45, sizeAttenuation: true })));

    // Grid
    const geo = new PlaneGeometry(GRID, GRID, SEGS, SEGS);
    geo.rotateX(-Math.PI / 2);
    const origPos = Float32Array.from(geo.attributes.position.array);
    const numVerts = origPos.length / 3;
    const cols = new Float32Array(numVerts * 3);
    geo.setAttribute("color", new BufferAttribute(cols, 3));
    scene.add(new Mesh(geo, new MeshBasicMaterial({
      vertexColors: true, wireframe: true, transparent: true, opacity: 0.7, depthWrite: false,
    })));

    // Raycast plane
    const hitPlane = new Mesh(
      new PlaneGeometry(120, 120),
      new MeshBasicMaterial({ visible: false, side: DoubleSide })
    );
    hitPlane.rotateX(-Math.PI / 2);
    scene.add(hitPlane);

    // Mass group
    const massGroup = new Group();
    scene.add(massGroup);
    sceneApiRef.current = { massGroup };
    const glowTex = createGlowTexture();

    const getGridY = (x, z) => {
      let disp = 0;
      for (const m of massesRef.current) {
        const dx = x - m.x, dz = z - m.z;
        disp -= m.mass / (Math.sqrt(dx * dx + dz * dz) + 0.65);
      }
      return Math.max(disp, -7.5);
    };

    const addMass = (x, z, massVal) => {
      // Enforce max — remove oldest
      if (massesRef.current.length >= MAX_MASSES) {
        const oldest = massesRef.current[0];
        handleRemove(oldest.id);
      }
      const id = nextId++;
      const entry = { id, x, z, mass: massVal };
      massesRef.current.push(entry);
      simState.ripples.push({ x, z, age: 0 });

      const grp = buildMassVisual(massVal, glowTex);
      grp.position.set(x, getGridY(x, z), z);
      massGroup.add(grp);
      massVisualsRef.current.set(id, grp);

      setMassesUI(massesRef.current.map(m => ({ ...m })));
    };

    // Trails
    const trailGroup = new Group();
    scene.add(trailGroup);

    const trailLines = simState.particles.map((_, idx) => {
      const positions = new Float32Array(TRAIL_LENGTH * 3);
      const trailGeo = new BufferGeometry();
      trailGeo.setAttribute("position", new BufferAttribute(positions, 3));
      trailGeo.setDrawRange(0, 0);
      const [r, g, b] = PARTICLE_COLORS[idx % PARTICLE_COLORS.length];
      const line = new Line(trailGeo, new LineBasicMaterial({
        color: new Color(r, g, b), transparent: true, opacity: 0.75,
        blending: AdditiveBlending, depthWrite: false,
      }));
      trailGroup.add(line);
      return line;
    });

    const particleSprites = simState.particles.map((_, idx) => {
      const [r, g, b] = PARTICLE_COLORS[idx % PARTICLE_COLORS.length];
      const canvas = document.createElement("canvas");
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext("2d");
      const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      const rc = Math.round(r*255), gc = Math.round(g*255), bc = Math.round(b*255);
      grad.addColorStop(0, `rgba(${rc},${gc},${bc},1)`);
      grad.addColorStop(0.4, `rgba(${rc},${gc},${bc},0.4)`);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 64);
      const sprite = new Sprite(new SpriteMaterial({
        map: new CanvasTexture(canvas), blending: AdditiveBlending,
        transparent: true, opacity: 0.9, depthWrite: false,
      }));
      sprite.scale.setScalar(0.6);
      scene.add(sprite);
      return sprite;
    });

    // Seed initial mass
    addMass(0, 0, 3.8);

    const clock = new Clock();
    let animId;

    const updateParticles = (dt) => {
      const SIM_STEPS = 3, subDt = dt / SIM_STEPS;
      simState.particles.forEach((p, idx) => {
        for (let s = 0; s < SIM_STEPS; s++) {
          let ax = 0, az = 0;
          for (const m of massesRef.current) {
            const dx = m.x - p.px, dz = m.z - p.pz;
            const dist2 = dx*dx + dz*dz + 0.5, dist = Math.sqrt(dist2);
            const force = G * m.mass / dist2;
            ax += force * dx / dist; az += force * dz / dist;
          }
          p.vx = (p.vx + ax * subDt) * 0.9995;
          p.vz = (p.vz + az * subDt) * 0.9995;
          p.px += p.vx * subDt; p.pz += p.vz * subDt;
        }
        const dist = Math.sqrt(p.px*p.px + p.pz*p.pz);
        const spd = Math.sqrt(p.vx*p.vx + p.vz*p.vz);
        if (dist > GRID * 0.7 || dist < 0.3 || spd > 25) {
          const f = spawnParticle(idx);
          Object.assign(p, f);
        }
        const y = getGridY(p.px, p.pz);
        p.trail.push([p.px, y + 0.12, p.pz]);
        if (p.trail.length > TRAIL_LENGTH) p.trail.shift();
        const line = trailLines[idx];
        const posArr = line.geometry.attributes.position.array;
        const len = p.trail.length;
        for (let i = 0; i < len; i++) {
          posArr[i*3] = p.trail[i][0]; posArr[i*3+1] = p.trail[i][1]; posArr[i*3+2] = p.trail[i][2];
        }
        line.geometry.setDrawRange(0, len);
        line.geometry.attributes.position.needsUpdate = true;
        line.material.opacity = Math.min(0.85, 0.35 + spd * 0.04);
        particleSprites[idx].position.set(p.px, y + 0.18, p.pz);
        particleSprites[idx].scale.setScalar(Math.min(0.45 + spd * 0.018, 1.1));
      });
    };

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.getElapsedTime();

      simState.ripples = simState.ripples.filter(r => { r.age += dt; return r.age < 1.4; });
      if (!simState.isDragging) simState.theta += dt * 0.04;

      const positions = geo.attributes.position.array;
      const colorArr = geo.attributes.color.array;
      for (let i = 0; i < numVerts; i++) {
        const ox = origPos[i*3], oz = origPos[i*3+2];
        let y = getGridY(ox, oz);
        for (const r of simState.ripples) {
          const dx = ox - r.x, dz = oz - r.z, dist = Math.sqrt(dx*dx + dz*dz);
          y += Math.sin(dist * 1.8 - r.age * 10) * 0.35 * (1 - r.age / 1.4) * Math.exp(-dist * 0.25);
        }
        positions[i*3+1] = Math.max(y, -7.5);
        const d = Math.pow(Math.min(Math.abs(y) / 7.5, 1), 0.6);
        colorArr[i*3] = 0.03 + d*0.55; colorArr[i*3+1] = 0.12 + d*0.7; colorArr[i*3+2] = 0.32 + d*0.65;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;

      massesRef.current.forEach((m, i) => {
        const grp = massVisualsRef.current.get(m.id);
        if (!grp) return;
        grp.position.y = getGridY(m.x, m.z);
        grp.children[1].rotation.y = t * 1.2 + i * 1.3;
        grp.children[1].rotation.x = Math.sin(t * 0.7 + i) * 0.4;
        grp.children[0].scale.setScalar(1 + 0.1 * Math.sin(t * 2.5 + i * 1.7));
        grp.children[2].material.opacity = 0.55 + 0.2 * Math.sin(t * 1.8 + i);
      });

      updateParticles(dt);
      updateCamera();
      renderer.render(scene, camera);
    };
    animate();

    const raycaster = new Raycaster();
    const mouse = new Vector2();

    const pinchDistance = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    const applyOrbit = (dx, dy) => {
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) simState.hasDragged = true;
      simState.theta -= dx * 0.007;
      simState.phi = Math.max(0.28, Math.min(1.48, simState.phi + dy * 0.007));
    };

    const tryPlaceMass = (clientX, clientY) => {
      hideAddMassTooltipRef.current();
      const rect = mount.getBoundingClientRect();
      mouse.x = ((clientX - rect.left) / W) * 2 - 1;
      mouse.y = -((clientY - rect.top) / H) * 2 + 1;
      raycaster.setFromCamera(mouse, camera);
      const hits = raycaster.intersectObject(hitPlane);
      if (hits.length > 0) {
        const pt = hits[0].point;
        if (Math.abs(pt.x) <= GRID / 2 && Math.abs(pt.z) <= GRID / 2) {
          addMass(pt.x, pt.z, 2.2 + Math.random() * 2.2);
        }
      }
    };

    const onMouseDown = (e) => {
      simState.isDragging = true;
      simState.hasDragged = false;
      simState.isPinching = false;
      simState.prevMouse = { x: e.clientX, y: e.clientY };
    };
    const onMouseMove = (e) => {
      if (!simState.isDragging || simState.isPinching) return;
      const dx = e.clientX - simState.prevMouse.x;
      const dy = e.clientY - simState.prevMouse.y;
      applyOrbit(dx, dy);
      simState.prevMouse = { x: e.clientX, y: e.clientY };
    };
    const onMouseUp = (e) => {
      if (simState.isDragging && !simState.hasDragged) tryPlaceMass(e.clientX, e.clientY);
      simState.isDragging = false;
    };
    const onWheel = (e) => {
      simState.radius = Math.max(14, Math.min(60, simState.radius + e.deltaY * 0.04));
    };

    const onTouchStart = (e) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
        simState.isPinching = true;
        simState.isDragging = false;
        simState.hasDragged = true;
        simState.prevPinchDist = pinchDistance(e.touches);
        return;
      }
      const t = e.touches[0];
      simState.isPinching = false;
      simState.isDragging = true;
      simState.hasDragged = false;
      simState.prevMouse = { x: t.clientX, y: t.clientY };
    };
    const onTouchMove = (e) => {
      if (e.touches.length >= 2) {
        e.preventDefault();
        const dist = pinchDistance(e.touches);
        if (!simState.isPinching) {
          simState.isPinching = true;
          simState.isDragging = false;
          simState.hasDragged = true;
          simState.prevPinchDist = dist;
          return;
        }
        const delta = dist - simState.prevPinchDist;
        simState.radius = Math.max(14, Math.min(60, simState.radius - delta * 0.08));
        simState.prevPinchDist = dist;
        return;
      }
      if (!simState.isDragging || simState.isPinching) return;
      e.preventDefault();
      const t = e.touches[0];
      const dx = t.clientX - simState.prevMouse.x;
      const dy = t.clientY - simState.prevMouse.y;
      applyOrbit(dx, dy);
      simState.prevMouse = { x: t.clientX, y: t.clientY };
    };
    const onTouchEnd = (e) => {
      if (simState.isPinching) {
        if (e.touches.length < 2) {
          simState.isPinching = false;
          if (e.touches.length === 1) {
            simState.isDragging = true;
            simState.hasDragged = true;
            simState.prevMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          } else {
            simState.isDragging = false;
          }
        }
        return;
      }
      if (simState.isDragging && !simState.hasDragged) {
        const t = e.changedTouches[0];
        if (t) tryPlaceMass(t.clientX, t.clientY);
      }
      simState.isDragging = false;
    };

    mount.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    mount.addEventListener("wheel", onWheel, { passive: true });
    mount.addEventListener("touchstart", onTouchStart, { passive: false });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    const onResize = () => {
      W = mount.clientWidth; H = mount.clientHeight;
      camera.aspect = W / H; camera.updateProjectionMatrix(); renderer.setSize(W, H);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(animId);
      mount.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      mount.removeEventListener("wheel", onWheel);
      mount.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("resize", onResize);
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [handleRemove]);

  // ── UI ────────────────────────────────────────────────────────────────────
  const sliderFill = (mass) =>
    `${((mass - MASS_MIN) / (MASS_MAX - MASS_MIN)) * 100}%`;

  return (
    <div className={`app${isMobileUI ? " is-mobile" : ""}`}>
      <div className="canvas-mount">
        <div ref={mountRef} className="canvas-surface" />
        {showAddMassTooltip && (
          <p className="grid-tooltip">
            {isMobileUI ? "Tap to add mass" : "Click to add mass"}
          </p>
        )}
      </div>

      <div className="title-block">
        <div className="title-main">SPACETIME CURVATURE</div>
        <div className="title-sub">GENERAL RELATIVITY · RUBBER SHEET ANALOGY</div>
      </div>

      {massesUI.length > 0 && (
        <div
          className={`controls-panel${isMobileUI ? " controls-drawer" : ""}${isMobileUI && drawerOpen ? " is-open" : ""}`}
        >
          {isMobileUI && (
            <div className="drawer-bar">
              {drawerOpen ? (
                <>
                  <span className="drawer-title">MASS CONTROLS</span>
                  <button
                    type="button"
                    className="drawer-close"
                    onClick={() => setDrawerOpen(false)}
                    aria-label="Close mass controls"
                  >
                    ×
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="drawer-handle"
                  onClick={() => setDrawerOpen(true)}
                  aria-expanded={false}
                >
                  MASS CONTROLS
                </button>
              )}
            </div>
          )}
          <div className="drawer-body">
            {!isMobileUI && <div className="controls-heading">MASS CONTROLS</div>}
            {massesUI.map((m, i) => (
              <div key={m.id} className="mass-card">
                <div className="mass-card-header">
                  <span className="mass-label">
                    BODY {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="mass-value">{m.mass.toFixed(1)}</span>
                  <button
                    type="button"
                    className="mass-remove"
                    onClick={() => handleRemove(m.id)}
                  >
                    REMOVE
                  </button>
                </div>

                <div className="mass-slider-wrap">
                  <input
                    type="range"
                    className="mass-slider"
                    min={MASS_MIN}
                    max={MASS_MAX}
                    step={0.1}
                    value={m.mass}
                    style={{ "--fill": sliderFill(m.mass) }}
                    onChange={(e) => handleSlider(m.id, e.target.value)}
                  />
                </div>

                <div className="mass-slider-labels">
                  <span className="mass-slider-bound">{MASS_MIN}m</span>
                  <span className="mass-slider-bound">{MASS_MAX}m</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="hint">
        DRAG TO ORBIT &nbsp;·&nbsp;{" "}
        {isMobileUI ? "PINCH TO ZOOM" : "SCROLL TO ZOOM"}
      </div>
    </div>
  );
}
