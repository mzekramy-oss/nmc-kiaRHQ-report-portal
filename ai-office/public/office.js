// 3D office: rooms, desks, and one animated character per employee.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ------------------------------------------------------------------ layout
const ROWS = { a: -11, b: -7.5, c: -1.5, d: 2, e: 9, f: 12.5 };
const ZONES = {
  management: { rect: [-19.6, -12.6, -13, -4.8], rows: [ROWS.a, ROWS.b], cols: [-17.6, -14.6] },
  people: { rect: [-11.2, -0.8, -13, -4.8], rows: [ROWS.a, ROWS.b], cols: [-9, -6, -3] },
  technology: { rect: [-19.6, -12.6, -3.6, 4.4], rows: [ROWS.c, ROWS.d], cols: [-17.6, -14.6] },
  marketing: { rect: [-11.2, 4.6, -3.6, 4.4], rows: [ROWS.c, ROWS.d], cols: [-9, -6, -3, 0, 3] },
  operations: { rect: [-19.6, 4.6, 6.8, 14.6], rows: [ROWS.e, ROWS.f], cols: [-17.6, -14.6, -11.6, -8.6, -5.6, -2.6, 0.4, 3.4] },
};
const ROOM_DOOR_Z = -6;
const MEET_TABLE = { x: 13, z: -7 };
const ENTRANCE = new THREE.Vector3(5.2, 0, 16);
const AISLE_X = 5.2;

export const CAMERA_PRESETS = {
  overview: { pos: [2, 30, 34], target: [0, 0, 0] },
  top: { pos: [0, 50, 0.01], target: [0, 0, 0] },
  work: { pos: [-7, 11, 17], target: [-7, 0, -2] },
  meeting: { pos: [13, 9, 5], target: [13, 0, -7.5] },
  lounge: { pos: [13, 7, 13], target: [13, 0, 3.5] },
  cafeteria: { pos: [9.5, 7, 21], target: [9.5, 0, 10.5] },
  playground: { pos: [16.5, 7, 21], target: [16.5, 0, 10.5] },
};

// --------------------------------------------------------------- materials
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
const M = {
  wall: mat('#f1f0ec'),
  deskTop: mat('#f4f4f2', { roughness: 0.5 }),
  deskBody: mat('#7d7f83', { roughness: 0.95 }),
  laptop: mat('#9ea3aa', { metalness: 0.4, roughness: 0.4 }),
  orange: mat('#f07a2a', { roughness: 0.5 }),
  potWhite: mat('#f3f3f3'),
  leaf: mat('#3f8a3a'),
  terracotta: mat('#c8774a'),
  chair: mat('#2a2522', { roughness: 0.6 }),
  wood: mat('#6a3b22', { roughness: 0.6 }),
  glass: new THREE.MeshStandardMaterial({ color: '#8fb3ea', emissive: '#4a78c6', emissiveIntensity: 0.35, roughness: 0.15, metalness: 0.1 }),
  frame: mat('#1d1f24'),
  sofa: mat('#e6e2da'),
  black: mat('#151515'),
  pendant: new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4d8', emissiveIntensity: 0.6 }),
  cord: mat('#333'),
  shirt: mat('#f5f5f5'),
  trousers: mat('#1f1f24'),
  shoe: mat('#0d0d0d'),
  tv: new THREE.MeshStandardMaterial({ color: '#0b0d12', emissive: '#1e3a6a', emissiveIntensity: 0.4 }),
};

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, material, x = 0, y = 0, z = 0, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#d9a46c';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const r = Math.random();
    g.fillStyle = r < 0.45 ? '#c88d55' : r < 0.8 ? '#e8bd88' : r < 0.95 ? '#a8693c' : '#f5e1c0';
    g.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 3, 1 + Math.random() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 8);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function floorLabel(text, w = 6) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(40,40,40,0.55)';
  g.font = '600 46px system-ui, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(text, 10, 48);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, (w * 96) / 512), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

// ------------------------------------------------------------------ props
function makePlant(scale = 1, pot = M.potWhite) {
  const g = new THREE.Group();
  g.add(cyl(0.09 * scale, 0.07 * scale, 0.16 * scale, pot, 0, 0.08 * scale, 0));
  for (let i = 0; i < 7; i++) {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.03 * scale, 0.32 * scale, 5), M.leaf);
    const a = (i / 7) * Math.PI * 2;
    leaf.position.set(Math.cos(a) * 0.03 * scale, 0.3 * scale, Math.sin(a) * 0.03 * scale);
    leaf.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
    g.add(leaf);
  }
  return g;
}

function makeBigPlant() {
  const g = new THREE.Group();
  g.add(cyl(0.38, 0.28, 0.7, M.terracotta, 0, 0.35, 0));
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.35 + Math.random() * 0.15, 10, 8), M.leaf);
    s.position.set((Math.random() - 0.5) * 0.7, 1.1 + Math.random() * 0.9, (Math.random() - 0.5) * 0.7);
    s.castShadow = true;
    g.add(s);
  }
  return g;
}

function makeLamp() {
  const g = new THREE.Group();
  g.add(cyl(0.09, 0.1, 0.03, M.orange, 0, 0.015, 0));
  const a1 = cyl(0.012, 0.012, 0.42, M.orange, 0, 0.2, 0, 6);
  a1.rotation.z = 0.35;
  a1.position.x = -0.07;
  g.add(a1);
  const a2 = cyl(0.012, 0.012, 0.36, M.orange, 0.06, 0.44, 0, 6);
  a2.rotation.z = -1.0;
  g.add(a2);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.16, 14, 1, true), M.orange);
  shade.material.side = THREE.DoubleSide;
  shade.position.set(0.22, 0.5, 0);
  shade.rotation.z = 0.6;
  g.add(shade);
  return g;
}

function makeChair() {
  const g = new THREE.Group();
  g.add(box(0.46, 0.05, 0.44, M.chair, 0, 0.47, 0));
  g.add(box(0.46, 0.5, 0.05, M.chair, 0, 0.75, 0.2));
  for (const [x, z] of [[-0.2, -0.18], [0.2, -0.18], [-0.2, 0.18], [0.2, 0.18]]) g.add(box(0.04, 0.47, 0.04, M.chair, x, 0.235, z));
  return g;
}

function makeDesk() {
  const g = new THREE.Group();
  g.add(box(1.7, 0.06, 0.85, M.deskTop, 0, 0.76, 0));
  g.add(box(1.6, 0.72, 0.7, M.deskBody, 0, 0.37, -0.05));
  const screenMat = new THREE.MeshStandardMaterial({ color: '#30343c', emissive: '#000000', roughness: 0.3 });
  const laptop = new THREE.Group();
  laptop.add(box(0.42, 0.02, 0.3, M.laptop, 0, 0.8, 0.05));
  const screen = box(0.42, 0.28, 0.015, M.laptop, 0, 0.94, -0.1);
  screen.rotation.x = -0.25;
  laptop.add(screen);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.24), screenMat);
  glow.position.set(0, 0.94, -0.09);
  glow.rotation.x = -0.25;
  laptop.add(glow);
  g.add(laptop);
  const lamp = makeLamp();
  lamp.position.set(-0.62, 0.79, -0.2);
  g.add(lamp);
  const plant = makePlant(1);
  plant.position.set(0.66, 0.79, -0.22);
  g.add(plant);
  const chair = makeChair();
  chair.position.set(0, 0, 0.72);
  g.add(chair);
  g.userData.screenMat = screenMat;
  return g;
}

function makeWindowWall(scene) {
  scene.add(box(40.4, 3.4, 0.3, M.wall, 0, 1.7, -14.15));
  for (let x = -18; x <= 18; x += 4) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 2.5), M.glass);
    pane.position.set(x, 1.75, -13.98);
    scene.add(pane);
    scene.add(box(3.4, 0.08, 0.1, M.frame, x, 0.5, -13.95));
    scene.add(box(3.4, 0.08, 0.1, M.frame, x, 3.0, -13.95));
    for (const dx of [-1.67, 0, 1.67]) scene.add(box(0.07, 2.55, 0.1, M.frame, x + dx, 1.75, -13.95));
    scene.add(box(3.4, 0.05, 0.1, M.frame, x, 2.2, -13.95));
  }
}

function makeRooms(scene) {
  // Side walls.
  scene.add(box(0.3, 3.4, 30.6, M.wall, -20.15, 1.7, 0.6));
  scene.add(box(0.3, 3.4, 30.6, M.wall, 20.15, 1.7, 0.6));
  // Meeting room partition (door gap around z = -6) and glass front.
  scene.add(box(0.2, 3, 6.8, M.wall, 6, 1.5, -10.6));
  scene.add(box(0.2, 3, 4.6, M.wall, 6, 1.5, -2.3));
  const glass = new THREE.Mesh(new THREE.BoxGeometry(14, 2.6, 0.06), new THREE.MeshStandardMaterial({ color: '#cfe3f5', transparent: true, opacity: 0.25 }));
  glass.position.set(13, 1.3, 0);
  scene.add(glass);
  scene.add(box(14, 0.08, 0.1, M.frame, 13, 2.6, 0));
  // Low walls for lounge / cafeteria / playground.
  scene.add(box(14, 1.1, 0.15, M.wall, 13, 0.55, 7));
  scene.add(box(0.15, 1.1, 7.6, M.wall, 13, 0.55, 11));

  // Meeting room: long table, chairs, TV.
  scene.add(box(8.4, 0.08, 1.8, M.wood, MEET_TABLE.x, 0.76, MEET_TABLE.z));
  scene.add(box(0.2, 0.72, 0.2, M.wood, MEET_TABLE.x - 3.6, 0.36, MEET_TABLE.z));
  scene.add(box(0.2, 0.72, 0.2, M.wood, MEET_TABLE.x + 3.6, 0.36, MEET_TABLE.z));
  for (const seat of meetingSeats()) {
    const c = makeChair();
    // Chair sits just behind the person, back facing away from the table.
    c.position.set(seat.x - Math.sin(seat.face) * 0.1, 0, seat.z - Math.cos(seat.face) * 0.1);
    c.rotation.y = seat.face + Math.PI;
    scene.add(c);
  }
  scene.add(box(3.2, 1.8, 0.08, M.tv, MEET_TABLE.x, 1.9, -13.9));
  const mp = makeBigPlant();
  mp.position.set(19, 0, -13);
  scene.add(mp);

  // Lounge.
  scene.add(box(4.5, 0.45, 1.1, M.sofa, 12, 0.22, 5.8));
  scene.add(box(4.5, 0.7, 0.25, M.sofa, 12, 0.6, 6.3));
  scene.add(box(1.1, 0.45, 3, M.sofa, 9.4, 0.22, 3.9));
  scene.add(box(0.25, 0.7, 3, M.sofa, 8.95, 0.6, 3.9));
  scene.add(box(1.8, 0.35, 1, M.wood, 12, 0.18, 3.8));
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(6, 4.4), mat('#c9c2b6'));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(12.5, 0.012, 3.9);
  rug.receiveShadow = true;
  scene.add(rug);
  for (const [x, z] of [[18.8, 1.2], [18.8, 6.2]]) {
    const p = makeBigPlant();
    p.position.set(x, 0, z);
    scene.add(p);
  }

  // Cafeteria.
  scene.add(box(5.6, 1.05, 0.7, M.deskBody, 9.6, 0.52, 13.9));
  scene.add(box(5.6, 0.06, 0.8, M.deskTop, 9.6, 1.07, 13.9));
  scene.add(box(0.5, 0.6, 0.45, M.black, 7.6, 1.4, 13.9));
  for (const [x, z] of [[8.4, 9.4], [11, 10.6]]) {
    scene.add(cyl(0.6, 0.6, 0.05, M.deskTop, x, 0.75, z, 24));
    scene.add(cyl(0.05, 0.05, 0.72, M.frame, x, 0.37, z));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      scene.add(cyl(0.18, 0.18, 0.05, M.orange, x + Math.cos(a) * 0.95, 0.5, z + Math.sin(a) * 0.95));
      scene.add(cyl(0.03, 0.03, 0.48, M.frame, x + Math.cos(a) * 0.95, 0.24, z + Math.sin(a) * 0.95));
    }
  }

  // Playground: ping-pong table, bean bags.
  scene.add(box(2.7, 0.06, 1.5, mat('#1f5fa8'), 16.6, 0.76, 10.4));
  scene.add(box(0.03, 0.16, 1.5, mat('#eeeeee'), 16.6, 0.87, 10.4));
  scene.add(box(2.5, 0.72, 0.1, M.frame, 16.6, 0.36, 10.4));
  const bagColors = ['#e05a47', '#f2c14e', '#4aa3a2'];
  bagColors.forEach((c, i) => {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), mat(c));
    b.scale.y = 0.6;
    b.position.set(14.4 + i * 2, 0.27, 13.4);
    b.castShadow = true;
    scene.add(b);
  });

  // Room labels on the floor.
  const labels = [
    ['Meeting room', 9.6, -1.4, 4.5],
    ['Lounge', 15.5, 1.3, 3],
    ['Cafeteria', 7, 7.9, 3],
    ['Playground', 14, 7.9, 3.4],
  ];
  for (const [t, x, z, w] of labels) {
    const l = floorLabel(t, w);
    l.position.set(x, 0.02, z);
    scene.add(l);
  }
}

export function meetingSeats() {
  const seats = [];
  // Head of table for the GM.
  seats.push({ x: MEET_TABLE.x + 4.6, z: MEET_TABLE.z, face: -Math.PI / 2 });
  for (let i = 0; i < 6; i++) {
    const x = MEET_TABLE.x - 3.2 + i * 1.3;
    seats.push({ x, z: MEET_TABLE.z + 1.35, face: Math.PI });
    seats.push({ x, z: MEET_TABLE.z - 1.35, face: 0 });
  }
  return seats;
}

// --------------------------------------------------------------- characters
const capsule = (r, len, material) => {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), material);
  m.castShadow = true;
  return m;
};

function makePerson(look, empId) {
  const skin = mat(look.skin, { roughness: 0.7 });
  const hair = mat(look.hair, { roughness: 0.9 });
  const suit = mat(look.suit, { roughness: 0.75 });
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const legs = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.11, 0.92, 0);
    const thigh = capsule(0.085, 0.3, M.trousers);
    thigh.position.y = -0.23;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.46;
    const shin = capsule(0.075, 0.3, M.trousers);
    shin.position.y = -0.22;
    knee.add(shin);
    const shoe = box(0.11, 0.07, 0.24, M.shoe, 0, -0.43, 0.05);
    knee.add(shoe);
    hip.add(knee);
    body.add(hip);
    legs.push({ hip, knee });
  }

  const torso = capsule(0.19, 0.38, suit);
  torso.scale.set(1.18, 1, 0.75);
  torso.position.y = 1.24;
  body.add(torso);
  const shirt = box(0.12, 0.26, 0.02, M.shirt, 0, 1.36, 0.135);
  body.add(shirt);
  const neck = cyl(0.055, 0.06, 0.12, skin, 0, 1.56, 0);
  body.add(neck);

  const head = new THREE.Group();
  head.position.y = 1.74;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.135, 18, 14), skin);
  skull.scale.y = 1.12;
  skull.castShadow = true;
  head.add(skull);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.145, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.1), hair);
  cap.position.set(0, 0.03, -0.012);
  cap.scale.y = 1.05;
  head.add(cap);
  if (look.gender === 'f') {
    const back = capsule(0.12, 0.16, hair);
    back.position.set(0, -0.06, -0.08);
    back.scale.set(1.15, 1, 0.7);
    head.add(back);
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), hair);
    bun.position.set(0, 0.1, -0.14);
    head.add(bun);
  }
  body.add(head);

  const arms = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.27, 1.45, 0);
    const upper = capsule(0.065, 0.22, suit);
    upper.position.y = -0.16;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.33;
    const fore = capsule(0.058, 0.2, suit);
    fore.position.y = -0.14;
    elbow.add(fore);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), skin);
    hand.position.y = -0.3;
    elbow.add(hand);
    shoulder.add(elbow);
    shoulder.rotation.z = side * 0.08;
    body.add(shoulder);
    arms.push({ shoulder, elbow });
  }

  root.traverse((o) => (o.userData.empId = empId));
  return { root, body, legs, arms, head };
}

// ------------------------------------------------------------------ Office
export class Office {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.people = new Map();
    this.desks = [];
    this.clock = new THREE.Clock();

    const w = container.clientWidth;
    const h = container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, h);
    this.labels.domElement.className = 'labels-layer';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#e9edf2');
    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 300);
    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2.15;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 80;
    this.flyTo('overview', true);

    this.buildWorld();
    this.bindEvents();
    this.animate();
  }

  buildWorld() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#ffffff', '#b98b5c', 1.1));
    const sun = new THREE.DirectionalLight('#fff6e8', 1.6);
    sun.position.set(-12, 30, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 22, bottom: -22, near: 1, far: 80 });
    sun.shadow.bias = -0.0005;
    s.add(sun);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40.4, 30.6), new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = 0.6;
    floor.receiveShadow = true;
    s.add(floor);

    makeWindowWall(s);
    makeRooms(s);

    for (const [x, z] of [[-19.2, -13.2], [4.6, -13.2], [-19.2, 5.6]]) {
      const p = makeBigPlant();
      p.position.set(x, 0, z);
      s.add(p);
    }
  }

  setDepartments(departments) {
    this.departments = departments;
    if (this.zonesBuilt) return;
    this.zonesBuilt = true;
    for (const [dept, z] of Object.entries(ZONES)) {
      const [x1, x2, z1, z2] = z.rect;
      const rug = new THREE.Mesh(
        new THREE.PlaneGeometry(x2 - x1, z2 - z1),
        new THREE.MeshStandardMaterial({ color: departments[dept]?.color ?? '#ccc', roughness: 1, transparent: true, opacity: 0.55 }),
      );
      rug.rotation.x = -Math.PI / 2;
      rug.position.set((x1 + x2) / 2, 0.01, (z1 + z2) / 2);
      rug.receiveShadow = true;
      this.scene.add(rug);
      const label = floorLabel(departments[dept]?.label ?? dept, 5);
      label.position.set(x1 + 2.8, 0.02, z2 - 0.4);
      this.scene.add(label);

      for (const row of z.rows) {
        for (const col of z.cols) {
          const desk = makeDesk();
          desk.position.set(col, 0, row);
          this.scene.add(desk);
          this.desks.push({ dept, x: col, z: row, owner: null, mesh: desk });
          if (Math.random() < 0.3) {
            const cord = cyl(0.005, 0.005, 1.4, M.cord, col, 3.1, row);
            const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), M.pendant);
            bulb.position.set(col, 2.35, row);
            this.scene.add(cord, bulb);
          }
        }
      }
    }
  }

  deskFor(emp) {
    const owned = this.desks.find((d) => d.owner === emp.id);
    if (owned) return owned;
    const free = this.desks.find((d) => d.dept === emp.dept && !d.owner) ?? this.desks.find((d) => d.dept === 'operations' && !d.owner) ?? this.desks.find((d) => !d.owner);
    if (free) free.owner = emp.id;
    return free;
  }

  /** Add/refresh employees. New hires walk in from the entrance. */
  syncEmployees(employees, { animateNew = false } = {}) {
    for (const emp of employees) {
      const existing = this.people.get(emp.id);
      if (existing) {
        existing.emp = emp;
        this.updateTag(existing);
        continue;
      }
      const desk = this.deskFor(emp);
      if (!desk) continue;
      const p = makePerson(emp.look ?? { skin: '#b07c5a', hair: '#111', suit: '#333', gender: 'm' }, emp.id);
      const seat = { x: desk.x, z: desk.z + 0.62, face: Math.PI };
      const person = { emp, desk, seat, ...p, path: [], mode: 'sit', phase: Math.random() * 10, status: emp.status };

      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.addEventListener('click', () => this.onSelect?.(emp.id));
      person.tagEl = tag;
      const tagObj = new CSS2DObject(tag);
      tagObj.position.set(0, 2.2, 0);
      p.root.add(tagObj);
      const bubble = document.createElement('div');
      bubble.className = 'bubble hidden';
      person.bubbleEl = bubble;
      const bubbleObj = new CSS2DObject(bubble);
      bubbleObj.position.set(0, 2.55, 0);
      p.root.add(bubbleObj);

      this.scene.add(p.root);
      this.people.set(emp.id, person);
      this.updateTag(person);

      if (animateNew) {
        p.root.position.copy(ENTRANCE);
        person.mode = 'walk';
        person.path = [new THREE.Vector3(AISLE_X, 0, ENTRANCE.z - 1), new THREE.Vector3(AISLE_X, 0, desk.z + 1.6), new THREE.Vector3(seat.x, 0, desk.z + 1.6), new THREE.Vector3(seat.x, 0, seat.z)];
        person.onArrive = () => this.sitAt(person, seat);
        this.flyToPoint(desk.x, desk.z);
      } else {
        this.sitAt(person, seat);
      }
    }
    // Remove anyone no longer employed (e.g. after reset).
    const ids = new Set(employees.map((e) => e.id));
    for (const [id, person] of this.people) {
      if (!ids.has(id)) {
        person.root.traverse((o) => o.element?.remove());
        this.scene.remove(person.root);
        person.desk.owner = null;
        this.people.delete(id);
      }
    }
  }

  updateTag(person) {
    const e = person.emp;
    person.tagEl.innerHTML = `<span class="dot ${person.status ?? 'idle'}"></span><b>${e.name}</b><span class="role">${e.role}</span>`;
  }

  setStatus(id, status) {
    const p = this.people.get(id);
    if (!p) return;
    p.status = status;
    this.updateTag(p);
    const screen = p.desk.mesh.userData.screenMat;
    screen.emissive.set(status === 'working' ? '#3a7bd5' : '#000000');
    screen.emissiveIntensity = status === 'working' ? 0.9 : 0;
  }

  say(id, text, ms = 4500) {
    const p = this.people.get(id);
    if (!p) return;
    p.bubbleEl.textContent = text;
    p.bubbleEl.classList.remove('hidden');
    clearTimeout(p.bubbleTimer);
    p.bubbleTimer = setTimeout(() => p.bubbleEl.classList.add('hidden'), ms);
  }

  sitAt(person, seat) {
    person.mode = 'sit';
    person.path = [];
    person.root.position.set(seat.x, 0, seat.z);
    person.root.rotation.y = seat.face;
  }

  walkPath(person, points, onArrive) {
    person.mode = 'walk';
    person.path = points.map(([x, z]) => new THREE.Vector3(x, 0, z));
    person.onArrive = onArrive;
  }

  startMeeting(ids) {
    const seats = meetingSeats();
    let i = 1;
    ids.forEach((id) => {
      const p = this.people.get(id);
      if (!p) return;
      const seat = id === 'rami' ? seats[0] : seats[i++] ?? { x: 8 + Math.random() * 10, z: -12, face: 0 };
      const sideZ = seat.z > MEET_TABLE.z ? -4.4 : -10.2;
      const back = p.desk.z + 1.6;
      this.walkPath(p, [[p.seat.x, back], [AISLE_X, back], [AISLE_X, ROOM_DOOR_Z], [7.4, ROOM_DOOR_Z], [7.4, sideZ], [seat.x, sideZ], [seat.x, seat.z]], () => this.sitAt(p, seat));
      p.inMeeting = seat;
    });
    this.flyTo('meeting');
  }

  endMeeting() {
    for (const p of this.people.values()) {
      if (!p.inMeeting) continue;
      const seat = p.inMeeting;
      p.inMeeting = null;
      const sideZ = seat.z > MEET_TABLE.z ? -4.4 : -10.2;
      const back = p.desk.z + 1.6;
      this.walkPath(p, [[seat.x, sideZ], [7.4, sideZ], [7.4, ROOM_DOOR_Z], [AISLE_X, ROOM_DOOR_Z], [AISLE_X, back], [p.seat.x, back], [p.seat.x, p.seat.z]], () => this.sitAt(p, p.seat));
    }
  }

  // ---------------------------------------------------------- camera
  flyTo(name, instant = false) {
    const preset = CAMERA_PRESETS[name];
    if (!preset) return;
    this.camTarget = { pos: new THREE.Vector3(...preset.pos), target: new THREE.Vector3(...preset.target), t: instant ? 1 : 0 };
    if (instant) {
      this.camera.position.copy(this.camTarget.pos);
      this.controls.target.copy(this.camTarget.target);
    }
  }

  flyToPoint(x, z) {
    this.camTarget = { pos: new THREE.Vector3(x + 2, 7, z + 8), target: new THREE.Vector3(x, 0.8, z), t: 0 };
  }

  focus(id) {
    const p = this.people.get(id);
    if (p) this.flyToPoint(p.root.position.x, p.root.position.z);
  }

  bindEvents() {
    addEventListener('resize', () => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.labels.setSize(w, h);
    });
    const ray = new THREE.Raycaster();
    const v = new THREE.Vector2();
    let down = null;
    const el = this.labels.domElement;
    el.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
      const r = el.getBoundingClientRect();
      v.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(v, this.camera);
      const roots = [...this.people.values()].map((p) => p.root);
      const hit = ray.intersectObjects(roots, true)[0];
      if (hit?.object.userData.empId) this.onSelect?.(hit.object.userData.empId);
    });
    this.controls.addEventListener('start', () => (this.camTarget = null));
  }

  // ---------------------------------------------------------- animation
  pose(p, t, dt) {
    const { legs, arms, body, head } = p;
    if (p.mode === 'walk') {
      const target = p.path[0];
      if (!target) {
        p.mode = 'stand';
        p.onArrive?.();
        return;
      }
      const pos = p.root.position;
      const dir = new THREE.Vector3().subVectors(target, pos);
      const dist = dir.length();
      const step = 2.4 * dt;
      if (dist <= step) {
        pos.copy(target);
        p.path.shift();
      } else {
        dir.normalize();
        pos.addScaledVector(dir, step);
        const want = Math.atan2(dir.x, dir.z);
        let d = want - p.root.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        p.root.rotation.y += d * Math.min(1, dt * 10);
      }
      const s = Math.sin(t * 9);
      body.position.y = Math.abs(Math.cos(t * 9)) * 0.04;
      legs[0].hip.rotation.x = s * 0.55;
      legs[1].hip.rotation.x = -s * 0.55;
      legs[0].knee.rotation.x = Math.max(0, -s) * 0.8;
      legs[1].knee.rotation.x = Math.max(0, s) * 0.8;
      arms[0].shoulder.rotation.x = -s * 0.45;
      arms[1].shoulder.rotation.x = s * 0.45;
      arms[0].elbow.rotation.x = arms[1].elbow.rotation.x = -0.25;
      head.rotation.x = 0;
      return;
    }
    if (p.mode === 'stand') {
      body.position.y = 0;
      for (const l of legs) l.hip.rotation.x = l.knee.rotation.x = 0;
      for (const a of arms) (a.shoulder.rotation.x = 0), (a.elbow.rotation.x = -0.1);
      return;
    }
    // Sitting (at desk or meeting table).
    body.position.y = -0.41 + Math.sin(t * 1.6 + p.phase) * 0.006;
    for (const l of legs) {
      l.hip.rotation.x = -Math.PI / 2;
      l.knee.rotation.x = Math.PI / 2;
    }
    const working = p.status === 'working' && !p.inMeeting;
    if (working) {
      arms.forEach((a, i) => {
        a.shoulder.rotation.x = -0.55;
        a.elbow.rotation.x = -1.05 + Math.sin(t * 18 + i * Math.PI) * 0.07;
      });
      head.rotation.x = 0.25 + Math.sin(t * 2 + p.phase) * 0.03;
      head.rotation.y = Math.sin(t * 0.7 + p.phase) * 0.08;
    } else {
      arms.forEach((a) => {
        a.shoulder.rotation.x = -0.35;
        a.elbow.rotation.x = -0.9;
      });
      head.rotation.x = 0.08;
      head.rotation.y = Math.sin(t * 0.4 + p.phase) * 0.25;
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.2);
    const t = this.clock.elapsedTime;
    if (this.camTarget && this.camTarget.t < 1) {
      this.camTarget.t = Math.min(1, this.camTarget.t + dt * 1.1);
      const k = 1 - Math.pow(1 - this.camTarget.t, 3);
      this.camera.position.lerp(this.camTarget.pos, k * 0.25 + 0.02);
      this.controls.target.lerp(this.camTarget.target, k * 0.25 + 0.02);
    }
    for (const p of this.people.values()) this.pose(p, t, dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
