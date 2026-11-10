# Audio assets — status

**No recorded audio exists yet.** Every cue below is played by a synthesized
WebAudio placeholder in `src/game/AudioManager.ts`. These are integration
stand-ins, not production sound design.

To replace a cue: put the file in `public/audio/`, then set `file` for that cue
in `AUDIO_CUES` (e.g. `'sfx.door': { file: 'door_servo_01.ogg', ... }`). The
sample is used automatically; the synth stays as the fallback.

| Cue id | Needed asset | Notes |
|---|---|---|
| `amb.roomtone` | Room tone loop: ventilation + fluorescent buzz | Drops to near-silence on power loss (deliberate "sudden silence"). |
| `amb.generator` | Generator drone loop | Positional (HRTF), in the Generator Room. |
| `sfx.footstep` | Boots on vinyl, 6+ variations, walk/run/crouch | Player steps trigger per stride. |
| `sfx.door` | Sliding door servo + latch | Positional; open and close variants. |
| `sfx.door_denied` | Keycard reader reject | |
| `sfx.impact_metal` | Distant metallic impacts, 4+ | Ambient sim noises; NPCs react to these. |
| `sfx.pipes` | Pipe knocking | Ambient sim noise. |
| `sfx.vent` | Vent rattle | Ambient sim noise. |
| `sfx.power_down` / `sfx.power_up` | Breaker trip + spin-down / spin-up + relays | |
| `sfx.pickup`, `sfx.switch`, `sfx.flashlight` | Foley | |
| `radio.squelch` | PTT open/close | |
| `radio.static` | Interference bursts, by intensity | Driven by signal quality. |
| `radio.voice_bed` | **Voice lines** | Placeholder murmur. Real lines should be recorded per dialogue line (see `src/sim/npc/DialogueLines.ts`; roughly 150 lines across 4 characters + shared). Process through the radio chain (band-pass + soft clip) at runtime, not baked. |
| `radio.unknown` | THE LISTENER transmission | Later stages need voice-imitation variants of each character and of the player. |
| `player.breath` | Exhausted breathing loop | Driven by stamina. |
