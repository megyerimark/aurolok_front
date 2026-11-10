import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * Final grade, applied after tone mapping: cool shadows / warm highlights,
 * vignette, film grain, and a signal-interference distortion that THE
 * LISTENER and bad radio reception drive through `interference`.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    interference: { value: 0 },
    vignette: { value: 0.9 },
    grain: { value: 0.055 },
    exposure: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time, interference, vignette, grain, exposure;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      // interference: horizontal tearing + chromatic split
      float band = step(0.985 - interference * 0.12, hash(vec2(floor(uv.y * 90.0), floor(time * 24.0))));
      uv.x += band * (hash(vec2(time, uv.y)) - 0.5) * 0.06 * interference;
      vec2 dir = (uv - 0.5);
      float ca = 0.0015 + interference * 0.012;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir * ca).b;
      col *= exposure;
      // grade: lift shadows toward teal, warm the highlights slightly
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      vec3 shadowTint = vec3(0.86, 1.0, 1.04);
      vec3 highTint = vec3(1.05, 1.0, 0.93);
      col *= mix(shadowTint, highTint, smoothstep(0.05, 0.6, l));
      col = mix(vec3(l), col, 0.82); // slight desaturation
      // vignette
      float v = smoothstep(0.95, 0.25, length(dir) * vignette * 1.25);
      col *= mix(0.35, 1.0, v);
      // grain (+ heavier snow during interference)
      float n = hash(vUv * vec2(1920.0, 1080.0) + fract(time) * 100.0) - 0.5;
      col += n * (grain + interference * 0.25);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private grade: ShaderPass;
  private bloom: UnrealBloomPass;
  private render: RenderPass;

  constructor(container: HTMLElement, scene: THREE.Scene, camera: THREE.Camera) {
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    container.appendChild(this.gl.domElement);

    this.composer = new EffectComposer(this.gl);
    this.render = new RenderPass(scene, camera);
    this.composer.addPass(this.render);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.55, 0.6, 0.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    window.addEventListener('resize', () => this.resize(camera as THREE.PerspectiveCamera));
  }

  set interference(v: number) {
    this.grade.uniforms.interference.value = v;
  }

  resize(camera: THREE.PerspectiveCamera): void {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    this.gl.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  draw(time: number): void {
    this.grade.uniforms.time.value = time;
    this.composer.render();
  }
}
