# THE LAST INSTRUCTION — Stage 1 audit, architecture and roadmap

## 1. What was available

| Item | Finding |
|---|---|
| `aurolok_front` repo | Empty: one `.DS_Store` and one unrelated PNG (`Sarki fény…png`, left untouched). |
| `arulok_bakc` repo | Empty: one zero-byte `a.txt`. Not used by v1 (no backend needed; no social features in v1). |
| Game engines | **None installed**: no Unity, Godot, .NET or Mono. Unity cannot run in this headless Linux environment (licence activation, GUI editor, Windows build target). |
| Tooling present | Node 22, npm registry access, Python 3.13, headless Chromium + Playwright, 4 CPU / 15 GB RAM, no GPU (software WebGL via SwiftShader). |

## 2. Engine decision

The brief prefers Unity/C#, but Unity can't be installed, compiled, run or tested here. A Unity project written blind would break the brief's own rules: "keep the project runnable", "fix compilation errors", "test important systems", "do not create fake functionality".

**Chosen stack: TypeScript + Three.js (WebGL2) + Vite, with Vitest for unit tests and Playwright for in-browser smoke tests.**

- Everything is compiled, unit-tested, run, and screenshotted in this environment.
- The repo name (`…_front`) suggests a web client was already intended.
- **Windows PC delivery**: wrap the static build with Electron (or Tauri) to produce a `.exe`. This adds no gameplay code. Planned for Stage 7.
- **Porting insurance**: the gameplay simulation (`src/sim/`) has no dependency on Three.js or the DOM. It is plain, deterministic TypeScript. To move to Unity later, `src/sim` is a direct C# translation target (classes map 1:1 to the brief's suggested systems). Only `src/game` and `src/ui` would be rewritten.

## 3. Is the environment ready?

Yes, for the chosen stack: `npm install && npm run dev` runs the game, `npm test` runs the simulation tests, and `npm run build && npm run smoke` boots the built game headlessly. The cloud container has no GPU, so headless frame rates (~2–8 fps) say nothing about real hardware.

## 4. Project structure

```
src/
  core/            Engine-agnostic utilities
    EventBus.ts      typed pub/sub between simulation and presentation
    Rng.ts           seeded PRNG: every shift is reproducible from its seed
    EventHistory.ts  everything important that happened, with reasons (→ incident report)
  sim/             THE GAME RULES. No rendering, no DOM, fully unit-tested.
    SimWorld.ts      composition root; the game layer feeds it player pos/input
    PlayerState.ts   inventory, keycard, flashlight battery
    facility/
      FacilityMap.ts       ASCII grid → rooms, doors, furniture cells, A* pathfinding
      FacilityState.ts     power, per-room lights, doors (keycard/auto-close), noises
      PointsOfInterest.ts  light switches, generator panel, hiding spots, pickups
    npc/
      Personality.ts   trait data for Daniel / Emily / Robert / Lucas (designer-tunable)
      Commands.ts      the instruction set + how ambiguous each one is
      Interpreter.ts   utility scoring: comply / hesitate / question / misread / independent / refuse
      NpcAgent.ts      FSM (Idle, Following, MovingToLocation, PerformingTask, Investigating,
                       Hiding, Panicking, Injured, Suspicious, Communicating, Dead),
                       fear/stress/trust dynamics, memory, autonomy, task execution
      Dialogue*.ts     contextual line banks with fallback + anti-repetition
    radio/RadioSystem.ts  latency, per-room signal quality, garbling, authenticity flag
    story/
      StoryDirector.ts   Chapter 1 beats (check-in → outage → first unknown transmission)
      IncidentReport.ts  end-of-shift report built from EventHistory
  game/            Three.js presentation
    Game.ts            orchestration, input, interaction, sim-event → audio/visual wiring
    LevelBuilder.ts    merged geometry, props, doors, pickups, notes from the map
    LightPool.ts       renders ~25 logical lights with 8 real ones (no shader recompiles)
    PlayerController.ts  FPS movement, sprint/stamina, crouch, head-bob, grid collision
    NpcView.ts         articulated primitive figures (placeholder for rigged models)
    Renderer.ts        ACES tone mapping, soft shadows, bloom, grade/grain/vignette/interference
    AudioManager.ts    WebAudio: HRTF 3D audio, radio chain, synthesized placeholder cues
    textures.ts        procedural PBR-ish textures (placeholder for authored texture sets)
  ui/              Hud.ts (prompts, subtitles, notes, report), RadioUI.ts (the handset)
tests/             Vitest: map integrity, interpreter distributions, dialogue, integration
scripts/smoke.mjs  Playwright: boots the build, fails on console errors, captures screenshots
```

How the brief's suggested Unity systems map onto this structure:
- GameManager → `Game` + `SimWorld`
- CommandSystem → `Commands` + `Interpreter`
- NPCBrain → `NpcAgent`
- NPCPersonality → `Personality`
- FacilityPowerSystem → `FacilityState`
- StoryManager → `StoryDirector`
- UIManager → `Hud` + `RadioUI`
- ScriptableObjects → the plain data modules (`Personality.ts`, `Commands.ts`, `DialogueLines.ts`, `FACILITY_LAYOUT`)
- EntityAI, DynamicEventManager, SecurityCameraSystem and SaveSystem come in Stages 4, 5 and 7.

## 5. How the instruction system works (the core mechanic)

1. You transmit an instruction. It is delivered after radio latency, at a signal quality set by both rooms (the restricted sector and generator room are noisy).
2. The NPC builds an `InterpretContext`:
   - fear, stress, trust;
   - signal quality;
   - risk of the destination (darkness, bad memories, restricted sector);
   - whether you're repeating yourself (insisting / confirming);
   - whether it contradicts an order from moments ago;
   - whether something nearby is grabbing their attention.
3. `Interpreter` scores six responses from **named factors** (e.g. "afraid of the destination", "obedient", "poor signal"), with ±0.06 seeded jitter. The winner's top factors become the reason stored in the history. Every surprising outcome can be explained afterwards.
4. The NPC acts on its reading:
   - **Misread** has concrete, defensible alternatives. "Turn off the lights" can mean *your* room's lights. "Investigate the noise" can mean an older noise. "Do not open the door" can mean "don't leave".
   - **Literalness** persists. Robert never forgets "do not open the door", gets stuck behind the next closed door, and waits where a task ended.
5. Continuous dynamics:
   - Darkness raises fear.
   - Company and your presence lower it.
   - Unexplained noises startle.
   - Above a personality-dependent threshold they **panic**, run to a hiding spot, and recover later. Obedient NPCs then resume your interrupted order.
   - Autonomy: idle, brave, independent NPCs investigate noises on their own, even while ordered to stay.
6. Status reports are honest except where personality says otherwise. A proud NPC hiding in a locker reports "all clear".

Unit tests check the design promises statistically across hundreds of seeds. For example: the same dark-room order makes Robert comply more than 90% of the time, Emily resist about half the time, and Lucas question it. Insisting turns Emily around. Bad signal causes misreadings.

## 6. Main technical risks

| Risk | Mitigation |
|---|---|
| Visual fidelity vs. "realistic, cinematic" | WebGL won't match Unity HDRP. Strong lighting, fog, grading and procedural materials get close for an underground facility. The real gap is **assets**: authored PBR textures, rigged character models, mo-cap. These are listed as missing, not faked. |
| No character models or animation | Articulated primitive figures with posture by state. Replace `NpcView.build` with GLTF + skeletal animation (Mixamo-licensed or commissioned). |
| No recorded voice or SFX | All audio is synthesized placeholders, clearly labelled (`docs/AUDIO_ASSETS.md`). Each cue has a `file` slot that is used automatically once filled. |
| NPC behaviour reading as random | Factor-based scoring with logged reasons, small jitter, and statistical tests that lock in personality differences. |
| Chaos feeling unfair (Stage 5) | Events will need priorities, cooldowns, prerequisites and an intensity budget. The `EventHistory` + seed make any run reproducible for tuning. |
| Lighting performance | `LightPool` keeps per-pixel light cost fixed. Only the flashlight casts shadows. Needs profiling on low-end GPUs in Stage 7. |
| Windows packaging | Electron wrapper; validate on real Windows hardware (pointer lock, audio autoplay, GPU blocklists). |

## 7. Roadmap

| Stage | Status | Content |
|---|---|---|
| 1 Audit & architecture | ✅ | This document. |
| 2 Playable foundation | ✅ | FPS controller, 7-area facility, interaction, doors, keycard, flashlight + batteries, radio handset UI, command selection. |
| 3 NPC system | ✅ first pass (pulled forward so the radio has someone to talk to) | 4 personalities, utility interpreter, FSM, fear/stress/trust, memory, autonomy, panic/hide/recover, contextual dialogue, face-to-face orders. |
| 4 THE LISTENER | 🟡 first pass | `sim/entity/Listener.ts`: attention + dread model and a scare director (hazard rate scaled by dread; cooldowns; phase gating; no repeats). Scare kinds: footsteps, whisper-behind, apparition, lunge (jumpscare), blackout, door slam, false teammate voice, false order in the player's own voice (NPCs may obey it). Presentation: `MonsterView` (the creature), `ScareController`. Still to do: voice imitation, camera-based sightings, direct contact with the player, interference driven by the entity. |
| 5 Chaos system | ⏳ | `DynamicEventManager` on top of the bus (ambient noises and the outage already exist): priorities, cooldowns, prerequisites, intensity budget, chained events. |
| 6 First complete demo | ⏳ | Chapters 2–5, climax, ≥2 endings, full incident report (the report exists already). |
| 7 Polish | ⏳ | Assets, audio, animation, camera system, save system, settings menu, Electron `.exe`, performance. |

## 8. Placeholder assets in this build

- Textures, props and characters: procedural, built in code.
- Audio: synthesized; full list in `docs/AUDIO_ASSETS.md`.
- Voice lines: subtitles only, with a band-limited murmur so radio replies have presence. **This is not voice acting.**
