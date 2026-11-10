import * as THREE from 'three';

/**
 * The level defines ~25 logical lights (room fixtures, emergency lights).
 * Forward rendering pays for every light on every pixel, so instead a fixed
 * pool of real lights is assigned each frame to the logical lights nearest
 * the camera. The pool size never changes, so shaders never recompile.
 * Walls and fog hide the far lights that are not represented.
 */
export class LightPool {
  private readonly pool: THREE.PointLight[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly virtual: THREE.PointLight[],
    size = 8,
  ) {
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 1.6);
      scene.add(l);
      this.pool.push(l);
    }
  }

  update(camera: THREE.Camera): void {
    const cam = camera.getWorldPosition(this.tmp);
    const ranked = this.virtual
      .filter((v) => v.intensity > 0.01)
      .map((v) => ({ v, d: v.position.distanceToSquared(cam) / Math.max(0.2, v.intensity / 10) }))
      .sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.pool.length; i++) {
      const real = this.pool[i];
      const src = ranked[i]?.v;
      if (!src) {
        real.intensity = 0;
        continue;
      }
      real.position.copy(src.position);
      real.color.copy(src.color);
      real.intensity = src.intensity;
      real.distance = src.distance;
      real.decay = src.decay;
    }
  }
}
