import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { useRef } from "react";
import type { MutableRefObject } from "react";
import * as THREE from "three";

export interface ImmersiveAlbum {
  title: string;
  artist: string;
  code: string;
  cover: string;
}

interface ImmersiveSceneProps {
  albums: readonly ImmersiveAlbum[];
  activeIndex: number;
  lookRef: MutableRefObject<{ x: number; y: number }>;
  onSelect: (index: number) => void;
}

// The restored room is an illustration with camera parallax, not a modeled CRT room.
const SCREEN_POSITIONS = [
  [-6.9, 3.65, -7.15, -0.2, 0.86],
  [-3.8, 3.55, -6.95, -0.1, 0.82],
  [-0.25, 3.35, -6.65, 0, 1.08],
  [3.9, 3.5, -6.95, 0.1, 0.86],
  [6.9, 3.55, -7.15, 0.2, 0.82],
  [-7.1, 1.05, -7.05, -0.2, 0.76],
  [-3.75, 0.95, -6.8, -0.1, 0.98],
  [0.05, 0.95, -6.55, 0, 0.94],
  [3.9, 1.0, -6.8, 0.1, 0.96],
  [7.05, 0.95, -7.05, 0.2, 0.74],
  [-6.1, -1.5, -6.9, -0.16, 0.82],
  [-2.25, -1.5, -6.7, -0.07, 0.95],
  [2.15, -1.48, -6.7, 0.07, 0.95],
  [6.05, -1.45, -6.9, 0.16, 0.82],
] as const;

function ScreenRegion({ index, onSelect }: { index: number; onSelect: () => void }) {
  const [x, y, z, rotation, scale] = SCREEN_POSITIONS[index % SCREEN_POSITIONS.length];
  const glitchRef = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    if (glitchRef.current) {
      const pulse = [1, 8, 12].includes(index) ? Math.max(0, Math.sin(clock.elapsedTime * 7.3 + index) - 0.78) * 2.8 : 0;
      glitchRef.current.opacity = pulse * 0.12;
    }
  });
  return (
    <mesh position={[x, y, z]} rotation={[0, rotation, 0]} scale={scale}
      onPointerOver={onSelect} onClick={(event) => { event.stopPropagation(); onSelect(); }}>
      <planeGeometry args={[1.34, 1.34]} />
      <meshBasicMaterial ref={glitchRef} transparent opacity={0} depthWrite={false}
        color={index % 2 === 0 ? "#dcf4e8" : "#ef6a53"} blending={THREE.AdditiveBlending} />
    </mesh>
  );
}

function Room({ albums, onSelect }: Pick<ImmersiveSceneProps, "albums" | "onSelect">) {
  const texture = useLoader(THREE.TextureLoader, "/media/landing-tv-room-detail-v2.png");
  const gl = useThree((state) => state.gl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
  return (
    <group>
      <mesh position={[0, 1.05, -8.2]}>
        <planeGeometry args={[39.6, 16.68]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      {albums.map((album, index) => <ScreenRegion key={album.title} index={index} onSelect={() => onSelect(index)} />)}
    </group>
  );
}

function CameraRig({ lookRef }: Pick<ImmersiveSceneProps, "lookRef">) {
  useFrame(({ camera }, delta) => {
    const { x, y } = lookRef.current;
    camera.position.x = THREE.MathUtils.damp(camera.position.x, x * 1.55, 3.2, delta);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, 1.15 - y * 0.9, 3.2, delta);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, 8.2 - Math.abs(x) * 1.65, 3.2, delta);
    camera.lookAt(0, 1, -6.6);
  });
  return null;
}

export function ImmersiveScene({ albums, lookRef, onSelect }: ImmersiveSceneProps) {
  return (
    <Canvas className="immersive-canvas" dpr={[1, 2]}
      camera={{ position: [0, 1.15, 8.1], fov: 47, near: 0.1, far: 80 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      onCreated={({ gl }) => gl.setClearColor("#050606", 0)}>
      <CameraRig lookRef={lookRef} />
      <Room albums={albums} onSelect={onSelect} />
    </Canvas>
  );
}
