import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

// --- Types ---
interface NormalizedLandmark {
  x: number; y: number; z: number; visibility?: number;
}
interface Results {
  multiHandLandmarks: NormalizedLandmark[][];
  image: any;
}

// --- Constants (Renormalized for Camera Z=15) ---
const PARTICLE_COUNT = 1500; 
const TREE_HEIGHT = 12.0;
const BASE_RADIUS = 5.0;
const FLICK_THRESHOLD = 0.08; 
const PINCH_THRESHOLD = 0.06; 
const CENTER_VIEW_POS = new THREE.Vector3(0, 0, 8); // In front of tree, close to camera

// --- IndexedDB Helper ---
const DB_NAME = 'XmasTreeDB';
const STORE_NAME = 'memories';
const DB_VERSION = 1;

const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
};

const savePhotoToDB = async (id: string, base64: string, width: number, height: number) => {
  try {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await tx.objectStore(STORE_NAME).put({ id, base64, width, height, date: Date.now() });
    console.log("Image saved to IndexedDB:", id);
  } catch (err) {
    console.error('Failed to save photo', err);
  }
};

const loadPhotosFromDB = async (): Promise<any[]> => {
  try {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const photos = await new Promise<any[]>((resolve) => {
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
    });
    console.log("Loaded photos from IndexedDB:", photos.length);
    return photos;
  } catch (err) {
    console.error('Failed to load photos', err);
    return [];
  }
};

// ... (Colors and Shaders remain unchanged) ...



// LED Colors
const SPARKLE_COLORS = [
  new THREE.Color('#FF0000'), // Red
  new THREE.Color('#FFD700'), // Gold
  new THREE.Color('#00FF00'), // Green
  new THREE.Color('#0000FF'), // Blue
];

// --- Shaders ---
const treeVertexShader = `
  uniform float uTime;
  attribute float aPhase;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vPhase;

  void main() {
    vColor = aColor;
    vPhase = aPhase;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    // Size attenuation (tuned for Z=15 scale)
    gl_PointSize = (150.0 / -mvPosition.z);
  }
`;

const treeFragmentShader = `
  uniform float uTime;
  varying vec3 vColor;
  varying float vPhase;

  void main() {
    vec2 coord = gl_PointCoord - vec2(0.5);
    float dist = length(coord);
    if(dist > 0.5) discard;
    
    // Intense Blink Effect (LED style)
    float pulse = 0.8 + 1.2 * sin(uTime * 5.0 + vPhase);
    
    // Soft glow edge
    float strength = 1.0 - (dist * 2.0);
    strength = pow(strength, 1.5);
    
    gl_FragColor = vec4(vColor * pulse, strength);
  }
`;

const borderVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const borderFragmentShader = `
  uniform float uTime;
  varying vec2 vUv;

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    // Moving rainbow gradient
    float hue = fract(vUv.x * 0.5 + vUv.y * 0.5 - uTime * 0.8);
    vec3 rgb = hsv2rgb(vec3(hue, 1.0, 1.0));
    gl_FragColor = vec4(rgb, 1.0);
  }
`;

export const ChristmasTree: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [statusText, setStatusText] = useState("SYSTEM READY");
  const [photoCount, setPhotoCount] = useState(0);

  // --- Refs ---
  const raycaster = useRef(new THREE.Raycaster());
  const mouse = useRef(new THREE.Vector2()); 
  
  const state = useRef({
    handNdc: new THREE.Vector2(0, 0),
    prevHandNdc: new THREE.Vector2(0, 0),
    pinchDist: 0,
    prevPinchDist: 0,
    isPinching: false,
    wasPinching: false,
    isHandDetected: false,
    
    viewingPhoto: null as THREE.Object3D | null,
    hoveredPhoto: null as THREE.Object3D | null,
    
    treeRotY: 0,
    targetRotY: 0,
    // INITIAL SCALE: 1.0 (Standard Unit Scale)
    treeScale: 1.0,
    // INITIAL POS: Center of screen (Half height down)
    treePos: new THREE.Vector3(0, -6, 0),
    photoGlobalIndex: 0
  });

  const sceneRefs = useRef({
    scene: null as THREE.Scene | null,
    renderer: null as THREE.WebGLRenderer | null,
    treeGroup: null as THREE.Group | null,
    cursorMesh: null as THREE.Mesh | null,
    photos: [] as THREE.Object3D[],
    sparkleMat: null as THREE.ShaderMaterial | null,
    borderMat: null as THREE.ShaderMaterial | null,
  });

  const handsRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);

  // Load photos on start
  useEffect(() => {
    loadPhotosFromDB().then(savedPhotos => {
      savedPhotos.sort((a,b) => a.date - b.date); // Load in order
      savedPhotos.forEach(p => {
        const img = new Image();
        img.src = p.base64;
        img.onload = () => {
            const tex = new THREE.Texture(img);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = false;
            tex.needsUpdate = true;
            createPhotoMesh(tex, p.width, p.height);
        };
      });
    });
  }, []);

  // --- Photo Logic ---
  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && sceneRefs.current.treeGroup) {
      Array.from(e.target.files).forEach((file: File) => {
        // 1. Create ObjectURL for immediate display
        const url = URL.createObjectURL(file);
        const loader = new THREE.TextureLoader();
        loader.load(url, (tex) => {
           tex.colorSpace = THREE.SRGBColorSpace;
           tex.minFilter = THREE.LinearFilter;
           tex.magFilter = THREE.LinearFilter;
           tex.generateMipmaps = false;
           
           const w = tex.image.width;
           const h = tex.image.height;
           createPhotoMesh(tex, w, h);
           
           // 2. Convert to Base64 for Persistence
           const reader = new FileReader();
           reader.onload = (evt) => {
               const base64 = evt.target?.result as string;
               const id = `photo_${Date.now()}_${Math.random()}`;
               savePhotoToDB(id, base64, w, h);
           };
           reader.readAsDataURL(file);
        });
      });
      e.target.value = '';
    }
  };

  const createPhotoMesh = (texture: THREE.Texture, imgW: number, imgH: number) => {
    if (!sceneRefs.current.treeGroup) return;

    // Aspect Ratio
    const aspect = imgW / imgH;
    const baseSize = 2.5; // Scaled for new world units
    let width = baseSize;
    let height = baseSize;
    if (aspect > 1) height = baseSize / aspect;
    else width = baseSize * aspect;

    const photoGroup = new THREE.Group();

    // 1. Photo
    const geom = new THREE.PlaneGeometry(width, height);
    const mat = new THREE.MeshBasicMaterial({ 
        map: texture, 
        side: THREE.DoubleSide,
        color: 0xffffff // Fallback color
    });
    const photoMesh = new THREE.Mesh(geom, mat);
    photoMesh.name = "visual";
    photoGroup.add(photoMesh);

    // 2. Rainbow Border
    const borderGeom = new THREE.PlaneGeometry(width + 0.2, height + 0.2);
    const borderMat = sceneRefs.current.borderMat || new THREE.MeshBasicMaterial({ color: 0xffffff });
    const border = new THREE.Mesh(borderGeom, borderMat);
    border.position.z = -0.05;
    border.visible = false;
    border.name = "border";
    photoGroup.add(border);

    // 3. Hitbox (Invisible)
    const hitGeom = new THREE.PlaneGeometry(width + 1.0, height + 1.0);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    const hitbox = new THREE.Mesh(hitGeom, hitMat);
    hitbox.position.z = 0.1;
    hitbox.name = "hitbox";
    photoGroup.add(hitbox);

    // Position on Tree: Golden Spiral Distribution
    const index = state.current.photoGlobalIndex;
    state.current.photoGlobalIndex += 1;

    // Golden Angle ~ 2.39996...
    const goldenAngle = Math.PI * (3 - Math.sqrt(5)); 
    
    // Vertical position decreases with index (Top down filling)
    const yStep = 1.0; 
    let y = (TREE_HEIGHT - 2.0) - (index * 0.8); 
    if (y < 2.0) y = Math.max(1.0, (TREE_HEIGHT - 2.0) - (Math.random() * (TREE_HEIGHT - 4.0))); 

    // Increase offset to 0.8 to ensure it floats ABOVE particles and ornaments
    const r = ((1 - y / TREE_HEIGHT) * BASE_RADIUS) + 0.8; 
    const theta = index * goldenAngle;

    photoGroup.position.set(r * Math.cos(theta), y, r * Math.sin(theta));
    photoGroup.lookAt(0, y, 0);
    photoGroup.rotateX(-0.1); 

    photoGroup.userData = {
      isPhoto: true,
      originalPos: photoGroup.position.clone(),
      originalRot: photoGroup.rotation.clone(),
      isReturning: false,
    };

    console.log("Created Photo Mesh at:", y, r); // Debug log
    sceneRefs.current.treeGroup.add(photoGroup);
    sceneRefs.current.photos.push(photoGroup);
    setPhotoCount(prev => prev + 1);
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // --- Init Three.js ---
    const width = window.innerWidth;
    const height = window.innerHeight;
    const scene = new THREE.Scene();
    sceneRefs.current.scene = scene;
    scene.background = new THREE.Color('#010308'); // Deep Space Black

    // Camera: Set to Z=15 as requested
    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
    camera.position.set(0, 0, 15);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    containerRef.current.appendChild(renderer.domElement);
    sceneRefs.current.renderer = renderer;

    // --- Lights ---
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const mainLight = new THREE.PointLight(0xffddaa, 1.5, 50);
    mainLight.position.set(10, 10, 10);
    scene.add(mainLight);

    const fillLight = new THREE.PointLight(0x3366ff, 1.0, 50);
    fillLight.position.set(-10, 5, 10);
    scene.add(fillLight);

    // --- Materials ---
    const borderMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: borderVertexShader,
      fragmentShader: borderFragmentShader,
      side: THREE.DoubleSide,
      transparent: true
    });
    sceneRefs.current.borderMat = borderMat;

    const sparkleMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: treeVertexShader,
      fragmentShader: treeFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    sceneRefs.current.sparkleMat = sparkleMat;

    // --- Tree Construction ---
    const treeGroup = new THREE.Group();
    treeGroup.position.copy(state.current.treePos);
    treeGroup.scale.setScalar(state.current.treeScale);
    scene.add(treeGroup);
    sceneRefs.current.treeGroup = treeGroup;

    // 1. Sparkle Particles
    const treeGeom = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];
    const phases = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const h = Math.random() * TREE_HEIGHT;
      const relH = h / TREE_HEIGHT;
      const r = (1 - relH) * BASE_RADIUS;
      const angle = h * 1.5 + Math.random() * Math.PI * 2;
      const fuzzy = Math.random() * 0.5; // Tighter fuzz for smaller scale
      
      positions.push(Math.cos(angle) * (r + fuzzy), h, Math.sin(angle) * (r + fuzzy));
      
      const c = SPARKLE_COLORS[Math.floor(Math.random() * SPARKLE_COLORS.length)];
      colors.push(c.r, c.g, c.b);
      phases.push(Math.random() * Math.PI * 2);
    }
    treeGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    treeGeom.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    treeGeom.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
    treeGroup.add(new THREE.Points(treeGeom, sparkleMat));

    // 2. Ornaments (Deep Red & Deep Dark Blue)
    const ornamentGeom = new THREE.SphereGeometry(0.35, 24, 24); // Size ~0.35
    
    const matRed = new THREE.MeshPhysicalMaterial({
        color: 0x880000, 
        metalness: 0.7, 
        roughness: 0.2, 
        clearcoat: 1.0,
        emissive: 0x220000,
        emissiveIntensity: 0.2
    });
    const matBlue = new THREE.MeshPhysicalMaterial({
        color: 0x000088, 
        metalness: 0.7, 
        roughness: 0.2, 
        clearcoat: 1.0,
        emissive: 0x000022,
        emissiveIntensity: 0.2
    });

    for (let i = 0; i < 60; i++) {
        const isRed = Math.random() > 0.5;
        const mesh = new THREE.Mesh(ornamentGeom, isRed ? matRed : matBlue);
        
        const h = Math.random() * (TREE_HEIGHT - 2) + 1; 
        const r = ((1 - h / TREE_HEIGHT) * BASE_RADIUS) + 0.3; 
        const angle = Math.random() * Math.PI * 2;
        
        mesh.position.set(Math.cos(angle) * r, h, Math.sin(angle) * r);
        treeGroup.add(mesh);
    }

    // 3. Star Topper
    const starGeom = new THREE.OctahedronGeometry(0.8, 0);
    const starMat = new THREE.MeshStandardMaterial({
        color: 0xffd700, emissive: 0xffaa00, emissiveIntensity: 2.0, metalness: 0.8, roughness: 0.2
    });
    const starMesh = new THREE.Mesh(starGeom, starMat);
    starMesh.position.y = TREE_HEIGHT + 0.5;
    treeGroup.add(starMesh);

    // 4. Cursor
    const cursorMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.8 })
    );
    scene.add(cursorMesh);
    sceneRefs.current.cursorMesh = cursorMesh;

    const interactPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    // --- Animation Loop ---
    const animate = (time: number) => {
      const tSeconds = time * 0.001;
      
      if (sceneRefs.current.sparkleMat) sceneRefs.current.sparkleMat.uniforms.uTime.value = tSeconds;
      if (sceneRefs.current.borderMat) sceneRefs.current.borderMat.uniforms.uTime.value = tSeconds;
      
      starMesh.rotation.y = tSeconds * 1.5;

      // Inputs
      const currentPinch = state.current.pinchDist < PINCH_THRESHOLD;
      state.current.isPinching = currentPinch;
      const justPinched = currentPinch && !state.current.wasPinching;
      const pinchVelocity = state.current.pinchDist - state.current.prevPinchDist;

      mouse.current.lerp(state.current.handNdc, 0.3);

      // --- PRIORITY LOGIC ---
      let cursorColor = 0xff0000; // Default Red
      let cursorScale = 1.0;

      if (state.current.isHandDetected) {
          
          raycaster.current.setFromCamera(mouse.current, camera);

          // 1. Cursor Follow
          const target = new THREE.Vector3();
          raycaster.current.ray.intersectPlane(interactPlane, target);
          if (target) {
              cursorMesh.visible = true;
              target.z = Math.max(-5, Math.min(10, target.z));
              cursorMesh.position.copy(target);
          }

          // 2. Identify Hit Photo
          let hitPhoto = null;
          if (!state.current.viewingPhoto) {
              const intersects = raycaster.current.intersectObjects(sceneRefs.current.photos, true);
              if (intersects.length > 0) {
                 let obj = intersects[0].object;
                 while (obj.parent && obj.parent.type !== 'Scene' && !obj.userData.isPhoto) {
                    obj = obj.parent;
                 }
                 if (obj.userData.isPhoto) hitPhoto = obj;
              }
          }

          // --- STATE MACHINE ---

          // A. VIEWING PHOTO (Focused)
          if (state.current.viewingPhoto) {
              const photo = state.current.viewingPhoto;
              
              if (!currentPinch && pinchVelocity > FLICK_THRESHOLD) {
                  // Flick to Dismiss
                  returnPhotoToTree(photo);
                  setStatusText("RETURNING...");
              } else {
                  // Drag/Parallax
                  const lookTarget = CENTER_VIEW_POS.clone();
                  lookTarget.x += mouse.current.x * 2.0;
                  lookTarget.y += mouse.current.y * 2.0;
                  photo.position.lerp(lookTarget, 0.1);
                  photo.lookAt(camera.position);
                  photo.scale.lerp(new THREE.Vector3(2.5, 2.5, 2.5), 0.1); // Scale up in focus
                  setStatusText("FLICK TO DISMISS");
              }
          }
          
          // B. HOVERING PHOTO
          else if (hitPhoto) {
              if (state.current.hoveredPhoto && state.current.hoveredPhoto !== hitPhoto) {
                  unhover(state.current.hoveredPhoto);
              }
              state.current.hoveredPhoto = hitPhoto;
              
              const border = hitPhoto.getObjectByName('border');
              if (border) border.visible = true;
              hitPhoto.scale.lerp(new THREE.Vector3(1.2, 1.2, 1.2), 0.2); // Small hover scale
              
              cursorColor = 0xffff00; // Yellow
              
              if (justPinched) {
                  state.current.viewingPhoto = hitPhoto;
                  sceneRefs.current.scene?.attach(hitPhoto); // Detach from tree, attach to scene
                  setStatusText("OPENING...");
              } else {
                  setStatusText("PINCH TO OPEN");
              }
          }

          // C. TREE INTERACTION (Empty Space)
          else {
              // Clear previous hover
              if (state.current.hoveredPhoto) {
                  unhover(state.current.hoveredPhoto);
                  state.current.hoveredPhoto = null;
              }

              if (state.current.isPinching) {
                  // --- ROTATE TREE ---
                  cursorColor = 0x0088ff; // Blue
                  cursorScale = 1.5;
                  
                  const deltaX = state.current.handNdc.x - state.current.prevHandNdc.x;
                  state.current.targetRotY += deltaX * 4.0; 
                  setStatusText("ROTATING TREE");
              } else {
                  // --- SCALE TREE ---
                  // Map Pinch distance (approx 0.05 to 0.3) to Scale
                  const spread = Math.min(1, Math.max(0, (state.current.pinchDist - 0.05) / 0.25));
                  const targetScale = 0.5 + spread * 1.5; // Range 0.5 to 2.0
                  state.current.treeScale += (targetScale - state.current.treeScale) * 0.08;
                  setStatusText("PINCH AIR TO ROTATE");
              }
          }

      } else {
          cursorMesh.visible = false;
          setStatusText("WAVE HAND TO START");
      }

      // Physics Application
      if (treeGroup) {
          state.current.treeRotY += (state.current.targetRotY - state.current.treeRotY) * 0.1;
          treeGroup.rotation.y = state.current.treeRotY;
          treeGroup.scale.setScalar(state.current.treeScale);
      }

      (cursorMesh.material as THREE.MeshBasicMaterial).color.setHex(cursorColor);
      cursorMesh.scale.setScalar(cursorScale);

      // History
      state.current.prevHandNdc.copy(state.current.handNdc);
      state.current.prevPinchDist = state.current.pinchDist;
      state.current.wasPinching = currentPinch;

      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);

    // Helpers
    const unhover = (obj: THREE.Object3D) => {
        obj.scale.lerp(new THREE.Vector3(1,1,1), 0.2);
        const b = obj.getObjectByName('border');
        if(b) b.visible = false;
    };

    const returnPhotoToTree = (photo: THREE.Object3D) => {
        state.current.viewingPhoto = null;
        photo.userData.isReturning = true;
        
        const border = photo.getObjectByName('border');
        if (border) border.visible = false;

        // Create a dummy target to calculate world position inside the rotating tree
        const dummy = new THREE.Object3D();
        dummy.position.copy(photo.userData.originalPos);
        dummy.rotation.copy(photo.userData.originalRot);
        sceneRefs.current.treeGroup?.add(dummy);

        const startPos = photo.position.clone();
        const startRot = photo.quaternion.clone();
        const startScale = photo.scale.clone();
        let p = 0;

        const loop = () => {
            p += 0.05;
            const ease = 1 - Math.pow(1 - p, 3);
            
            const tPos = new THREE.Vector3();
            const tRot = new THREE.Quaternion();
            dummy.getWorldPosition(tPos);
            dummy.getWorldQuaternion(tRot);

            photo.position.lerpVectors(startPos, tPos, ease);
            photo.quaternion.slerp(tRot, ease);
            photo.scale.lerpVectors(startScale, new THREE.Vector3(1,1,1), ease);

            if (p < 1) requestAnimationFrame(loop);
            else {
                sceneRefs.current.treeGroup?.attach(photo);
                photo.position.copy(photo.userData.originalPos);
                photo.rotation.copy(photo.userData.originalRot);
                photo.userData.isReturning = false;
                sceneRefs.current.treeGroup?.remove(dummy);
            }
        };
        loop();
    };

    // --- MediaPipe ---
    const initMediaPipe = async () => {
       const Hands = (window as any).Hands;
       const Camera = (window as any).Camera;
       
       const hands = new Hands({
          locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
       });
       hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5
       });

       hands.onResults((results: Results) => {
          if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
             const lm = results.multiHandLandmarks[0];
             const thumb = lm[4];
             const index = lm[8];
             
             state.current.pinchDist = Math.sqrt(Math.pow(thumb.x - index.x, 2) + Math.pow(thumb.y - index.y, 2));
             
             const avgX = (thumb.x + index.x) / 2;
             const avgY = (thumb.y + index.y) / 2;
             
             state.current.handNdc.set(
                 -((avgX * 2) - 1), 
                 -((avgY * 2) - 1)
             );
             state.current.isHandDetected = true;
          } else {
             state.current.isHandDetected = false;
          }
       });
       
       handsRef.current = hands;
       if (videoRef.current) {
          const cam = new Camera(videoRef.current, {
             onFrame: async () => {
                if (videoRef.current && handsRef.current) await handsRef.current.send({ image: videoRef.current });
             },
             width: 640,
             height: 480
          });
          cam.start();
          cameraRef.current = cam;
       }
    };
    initMediaPipe();

    const handleResize = () => {
       const w = window.innerWidth;
       const h = window.innerHeight;
       camera.aspect = w / h;
       camera.updateProjectionMatrix();
       renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
       window.removeEventListener('resize', handleResize);
       containerRef.current?.removeChild(renderer.domElement);
       if(handsRef.current) handsRef.current.close();
       if(cameraRef.current) cameraRef.current.stop();
    };
  }, []);

  return (
    <div className="relative w-full h-full overflow-hidden">
      <video ref={videoRef} className="input_video hidden" playsInline muted />
      <div ref={containerRef} className="absolute inset-0 z-10" />
      
      {/* HUD */}
      <div className="absolute top-0 left-0 p-6 z-20 pointer-events-none w-full">
        <div className="flex justify-between items-start">
           <div>
              <h1 className="text-white/40 font-bold tracking-[0.2em] text-[10px] mb-2 uppercase">Christmas AR Final</h1>
              <div className="text-2xl md:text-3xl font-mono font-bold drop-shadow-xl text-cyan-300">
                {statusText}
              </div>
           </div>
           
           <div className="pointer-events-auto">
              <input 
                 type="file" 
                 multiple 
                 accept="image/*" 
                 className="hidden" 
                 ref={fileInputRef}
                 onChange={handleUpload}
              />
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="bg-white/10 hover:bg-white/20 text-white border border-white/30 px-5 py-2 rounded-full backdrop-blur-md transition-all active:scale-95 flex items-center gap-2"
              >
                 <span className="text-lg">📷</span> 
                 <span className="font-bold tracking-wider text-xs">ADD MEMORIES ({photoCount})</span>
              </button>
           </div>
        </div>
      </div>
      
      <div className="absolute bottom-6 w-full text-center z-20 pointer-events-none">
          <p className="text-white/50 text-[10px] tracking-widest uppercase">
             Pinch Air to Rotate • Open Hand to Scale • Pinch Photo to Open
          </p>
      </div>
    </div>
  );
};
