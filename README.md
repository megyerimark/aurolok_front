# THE LAST INSTRUCTION

First-person psychological horror. You are the night-shift supervisor of an
underground research facility in lockdown. Your team is trapped in different
sectors and you are the only one on the radio.

> **You give the instructions. They make the decisions. You deal with the consequences.**

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulation unit + integration tests
npm run build      # typecheck + production build into dist/
npm run smoke      # headless browser boot test + screenshots (after build)
```

Add `?seed=1234` to the URL to replay a shift deterministically.

## Controls

| Key | Action |
|---|---|
| WASD / mouse | Move / look |
| Shift / Ctrl (or C) | Sprint (stamina) / crouch |
| E | Interact. Hold for repairs. Face an employee to give an order in person |
| F / B | Flashlight / swap in a spare battery |
| R | Raise/lower the radio |
| Q (or Tab) | Radio: change channel (ALL, Daniel, Emily, Robert, Lucas) |
| 1–9 | Radio: transmit an instruction |
| Esc | Pause |

## What is in this build (Stages 1–3, first pass)

- **Facility**: seven areas (Central Control, Security Corridor, Laboratory, Generator Room, Medical, Storage, Restricted Research Sector). Includes:
  - auto-closing sliding doors and a keycard door;
  - light switches, power and emergency lighting;
  - notes, pickups, and environmental storytelling.
- **Player**:
  - movement: walk, sprint and crouch, with head-bob;
  - tools: flashlight with battery drain and spares;
  - inventory and contextual prompts;
  - hold-to-repair at the generator.
- **Radio**: an industrial handset UI. It shows per-employee badge telemetry (location, heart rate, signal, activity), and flags acknowledgements, hesitation, requests to confirm, refusals, missing replies, and unregistered transmitters.
- **Four employees**, each driven by a utility-scored instruction interpreter and a state machine:
  - Daniel: overconfident;
  - Emily: anxious;
  - Robert: literal;
  - Lucas: suspicious.

  They respond to fear, darkness, noise, trust and signal quality. They can misread, question, refuse, act on their own, panic and hide, and they say why.
- **Chapter 1 slice**: check-in → generator failure → restore power (yourself or by sending someone) → the first transmission nobody sent → the restricted sector.
- **Incident report** at the end of the shift, built from the event history.

See `docs/ARCHITECTURE.md` for the audit, engine decision, structure, risks and roadmap, and `docs/AUDIO_ASSETS.md` for which audio is still placeholder.
