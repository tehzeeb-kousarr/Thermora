import React, { useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';

// Classic Ashima Arts 2D simplex noise, inlined so the shader has no external deps.
const NOISE_GLSL = `
  vec3 mod289(vec3 x){return x - floor(x * (1.0/289.0)) * 289.0;}
  vec2 mod289(vec2 x){return x - floor(x * (1.0/289.0)) * 289.0;}
  vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
  float snoise(vec2 v){
    const vec4 C = vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
  float fbm(vec2 p){
    float v = 0.0;
    float a = 0.55;
    for (int i = 0; i < 4; i++){
      v += a * snoise(p);
      p *= 2.02;
      a *= 0.55;
    }
    return v;
  }
`;

const VERTEX_SHADER = `
  uniform float uTime;
  uniform vec2 uMouse;
  varying float vHeight;
  varying vec2 vUv;

  ${NOISE_GLSL}

  void main(){
    vUv = uv;
    vec3 pos = position;
    float n = fbm(pos.xy * 0.55 + vec2(0.0, uTime * 0.055));
    n += 0.18 * fbm(pos.xy * 1.6 - uMouse * 0.6 + uTime * 0.08);
    pos.z += n * 1.35;
    vHeight = n;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  varying float vHeight;
  varying vec2 vUv;
  uniform vec3 uCold;
  uniform vec3 uMid;
  uniform vec3 uHot;
  uniform vec3 uPeak;
  uniform float uOpacity;
  uniform float uFadeRadius;
  uniform float uFadeSoftness;

  void main(){
    float h = clamp((vHeight + 1.0) / 2.0, 0.0, 1.0);
    vec3 color;
    if (h < 0.32) {
      color = mix(uCold, uMid, h / 0.32);
    } else if (h < 0.66) {
      color = mix(uMid, uHot, (h - 0.32) / 0.34);
    } else {
      color = mix(uHot, uPeak, (h - 0.66) / 0.34);
    }
    // Radial falloff from center — controllable so the terrain can visibly
    // dissolve well before the edges of the canvas instead of hard-cropping.
    float edge = smoothstep(uFadeRadius, uFadeRadius + uFadeSoftness, distance(vUv, vec2(0.5, 0.42)));
    float alpha = (1.0 - edge) * uOpacity;
    gl_FragColor = vec4(color, alpha);
  }
`;

const WIRE_FRAGMENT_SHADER = `
  precision mediump float;
  varying float vHeight;
  varying vec2 vUv;
  uniform float uOpacity;
  uniform float uFadeRadius;
  uniform float uFadeSoftness;
  void main(){
    float edge = smoothstep(uFadeRadius, uFadeRadius + uFadeSoftness, distance(vUv, vec2(0.5, 0.42)));
    float alpha = (1.0 - edge) * 0.16 * uOpacity;
    gl_FragColor = vec4(1.0, 0.82, 0.6, alpha);
  }
`;

function Terrain({ pointer, opacity, fadeRadius, fadeSoftness }) {
  const matRef = useRef(null);
  const wireMatRef = useRef(null);
  const groupRef = useRef(null);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uMouse: { value: [0, 0] },
      uCold: { value: [0.14, 0.06, 0.29] }, // deep violet — coolest
      uMid: { value: [0.78, 0.13, 0.11] }, // ember red
      uHot: { value: [0.98, 0.45, 0.09] }, // thermora orange
      uPeak: { value: [0.99, 0.85, 0.55] }, // white-hot peak
      uOpacity: { value: opacity },
      uFadeRadius: { value: fadeRadius },
      uFadeSoftness: { value: fadeSoftness },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useFrame((state, delta) => {
    uniforms.uTime.value += delta;
    uniforms.uMouse.value = [pointer.current.x, pointer.current.y];
    uniforms.uOpacity.value = opacity;
    uniforms.uFadeRadius.value = fadeRadius;
    uniforms.uFadeSoftness.value = fadeSoftness;
    if (matRef.current) matRef.current.uniformsNeedUpdate = true;

    if (groupRef.current) {
      const targetX = -1.15 + pointer.current.y * 0.12;
      const targetY = pointer.current.x * 0.18;
      groupRef.current.rotation.x += (targetX - groupRef.current.rotation.x) * 0.04;
      groupRef.current.rotation.y += (targetY - groupRef.current.rotation.y) * 0.04;
    }
  });

  return (
    <group ref={groupRef} rotation={[-1.15, 0, 0]} position={[0, -0.35, 0]}>
      <mesh>
        <planeGeometry args={[9, 9, 110, 110]} />
        <shaderMaterial
          ref={matRef}
          vertexShader={VERTEX_SHADER}
          fragmentShader={FRAGMENT_SHADER}
          uniforms={uniforms}
          transparent
        />
      </mesh>
      <mesh position={[0, 0, 0.01]}>
        <planeGeometry args={[9, 9, 44, 44]} />
        <shaderMaterial
          ref={wireMatRef}
          vertexShader={VERTEX_SHADER}
          fragmentShader={WIRE_FRAGMENT_SHADER}
          uniforms={uniforms}
          transparent
          wireframe
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function Rig({ pointer }) {
  const { camera } = useThree();
  useFrame(() => {
    camera.position.x += (pointer.current.x * 0.6 - camera.position.x) * 0.03;
    camera.position.y += (1.35 - pointer.current.y * 0.3 - camera.position.y) * 0.03;
    camera.lookAt(0, -0.2, 0);
  });
  return null;
}

/**
 * Full-bleed interactive thermal terrain: a live-updating heightfield
 * colored with a true thermal (cold → peak) gradient. Tilts gently with
 * the visitor's cursor, standing in for Thermora's hyperlocal heat data.
 *
 * Renders as a plain absolutely-positioned <div><Canvas/></div> with no
 * internal z-index or fixed positioning — stacking relative to sibling
 * content is entirely controlled by the parent via className/z-index.
 *
 * Props:
 *  - opacity (0–1, default 0.5): overall terrain opacity, applied inside
 *    the shader (real alpha, not a CSS approximation over a canvas).
 *  - fadeRadius (0–1, default 0.28): distance from center where the
 *    radial fade begins. Smaller = terrain shrinks toward the middle.
 *  - fadeSoftness (0–1, default 0.35): how gradual the falloff is past
 *    fadeRadius. Larger = softer, longer dissolve into transparent.
 */
export default function ThermalTerrain3D({
  className = '',
  opacity = 0.5,
  fadeRadius = 0.28,
  fadeSoftness = 0.35,
}) {
  const pointer = useRef({ x: 0, y: 0 });

  const handlePointerMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    pointer.current = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: ((e.clientY - rect.top) / rect.height) * 2 - 1,
    };
  };

  const handlePointerLeave = () => {
    pointer.current = { x: 0, y: 0 };
  };

  return (
    <div
      className={className}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      aria-hidden="true"
    >
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [0, 1.35, 3.4], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
      >
        <Rig pointer={pointer} />
        <Terrain pointer={pointer} opacity={opacity} fadeRadius={fadeRadius} fadeSoftness={fadeSoftness} />
      </Canvas>
    </div>
  );
}