# Urevo SpaceWalk 5L (URTM054) BLE Protocol — Findings & Build Plan

Status: **Start/Stop/Pause/Set-Speed all confirmed working on our actual hardware — and the Set Speed trailer mystery is solved.** This device (URTM054) shares its exact GATT layout with the Urevo E1L (URTM041), documented and captured by the [TreadSpan project](https://github.com/blak3r/treadspan/tree/main/protocol-analysis/urevo-E1L). Start/Stop/Pause use fixed bytes lifted directly from that project's capture and work as-is.

The Set Speed trailer byte is a **lookup table keyed by target speed alone** (not current, not delta) — confirmed via a real HCI snoop capture (Samsung device, official Urevo app, root access) of an actual app session on this exact treadmill, cross-checked against our own independent hardware tests. `control.js` ships with the confirmed table and auto-searches (then remembers) any target it hasn't seen yet. Incline is out of scope for implementation, but its command structure is documented below since the real capture revealed it essentially for free.

## 1. Connection setup

1. Connect, discover all services/characteristics (standard GATT).
2. Enable notifications (write CCCD `01 00`) on:
   - `2acd` (Treadmill Data, service `1826`) — standard FTMS, low value (see §4)
   - `fff1` (service `fff0`) — **this is the real live telemetry channel**
3. Write handshake to `fff2` (service `fff0`), in order:
   - `02 51 0b 03`
   - `02 50 03 09 03`

   This is required — without it, `fff1` never emits anything (matches our own earlier "silence" test — we hadn't sent this handshake yet).

## 2. Control commands (write to `fff2`)

Frame shape: `02 <CMD> <SUBCMD> [DATA...] <TRAILER> 03` (`02`/`03` are start/end markers).

| Action | Bytes to write | Confidence |
|---|---|---|
| **Start / Resume** | `02 53 01 00 00 00 00 00 00 00 00 0e 03` immediately followed by `02 40 02 18 03` | **Confirmed on hardware** — both frames sent together; belt actually starts, telemetry status transitions to "running" |
| **Stop** | `02 53 03 0c 03` | **Confirmed on hardware** — belt actually stops |
| **Pause** (temporary ramp-to-0, resumable) | `02 53 0a 07 03` | **Confirmed on hardware** — belt actually pauses |
| **Set speed** | `02 53 02 <target_lo> <target_hi=00> <trailer> 03` | **Solved.** The trailer is a lookup table keyed by **target alone**, confirmed across 3 independent sessions (our own calibration, our own manual searches, and a real HCI capture of the official app): target=10→`0x05`, 11→`0x3a`, 12→`0x3b`, 13→`0x38`, 14→`0x39`, 15→`0x3e`, 16→`0x3f`, 17→`0x3c`, 18→`0x3d`, 19→`0x32`, 20→`0x33`, 25→`0x34` (baked into `control.js` as `SPEED_TRAILER_TABLE`). No linear/CRC8/quadratic formula fits this table — it's almost certainly a firmware-side calibration table (e.g. motor/PWM constants per speed), not computed math. Large jumps work fine in a single command once the target's trailer is known (earlier "large jumps rejected" theory was wrong — it was hitting an untested target, not a jump-size limit). Unknown targets are found via an exhaustive 0-255 search (ground-truthed against telemetry) and remembered for the rest of the process. Confirmed scale: raw 20 = 2.0 km/h (×0.1 km/h, matches the FTMS channel's assumed scale). |
| Set incline | `02 53 02 0a <level×10> <trailer> 03` | **Structure confirmed, not implemented (out of scope).** Same `02 53 02` prefix as speed, but byte 4 is a fixed selector `0x0a` (not part of a 2-byte target) and byte 5 is the incline level ×10 (0, 10, 20... for levels 0-5). Confirmed trailers: level 0→`0x05`, 10→`0x33`, 20→`0x29`, 30→`0x27`, 40→`0xdd`, 50→`0xcb` — also target-only, not current-dependent (same value going up or down). The real app's "jump directly to a level" UI action is actually implemented client-side as a rapid burst of individual step commands (~0.2s apart), not a special jump command — worth remembering if we ever build multi-step speed/incline transitions. |
| Toggle beep | `02 40 03 01 00×15 1e 03` (20 bytes, mostly zero-padded) | Confirmed from capture — same stateless "toggle" frame sent for both on and off, device tracks the on/off state internally. Not implemented, low priority. |

## 3. Live telemetry (notify on `fff1`)

The app does **not** rely on standard FTMS (`2acd`) for live data — it fires only 2-3 times then goes silent. All real telemetry rides on `fff1`, prefixed `02 51 ...`. **Frame length varies by state — do not assume a fixed size** (an earlier version of `control.js` assumed exactly 19 bytes and silently dropped everything once real frames showed up shorter/longer; fixed by checking length ranges instead of an exact value):

- **6 bytes**, idle/minimal ping (seen at status `0x00`, before Start): `02 51 <status> <pad> <checksum> 03` — no speed field.
- **19 or 25 bytes**, "full telemetry" (seen once running): `02 51 <status> <speed_lo> <speed_hi=00> <elapsed> ... <checksum> 03` — status and speed are at the same offset in both variants; the 25-byte one just has extra trailing fields (a slower-incrementing counter, likely distance, plus reserved/constant bytes).

Other prefixes (`02 40`, `02 50`, `02 53`) also appear on this same channel occasionally (acks/echoes) — a different message class entirely, safely ignored by only decoding frames starting `02 51`.

| Offset | Field | Confidence |
|---|---|---|
| 2 | Status: `00`=idle, `03`=running, `01`=stopped, `04`/`0a`=pausing/paused transition | High — confirmed against every Start/Stop/Pause write, and now the idle state too |
| 3–4 (u16 LE) | Current speed, raw units — matches Set Speed command value directly. **Only present in frames ≥19 bytes** — the 6-byte idle ping has no speed field at all. | High |
| 5 onward | Elapsed-time-like incrementing counter, distance/energy-like fields | Medium — increments correctly but exact field boundaries not fully mapped (lower priority; our own `2acd` decode already gives a reliable elapsed-time source) |

## 4. Standard FTMS path (`2acd`, already built)

Already implemented and self-tested in [bleinspect.js](bleinspect.js) (`decodeTreadmillData()`), confirmed against our own real capture:
- Speed (offset 2–3, ×0.1 km/h — best fit, not yet cross-checked against console display)
- Incline (offset 7–8, ×0.1 %)
- Elapsed time (offset 21–22, seconds, freezes on stop)

This channel is low-frequency/unreliable for live control feedback (per §3) but is a fine, already-working source for session start/stop timestamps and speed samples for a Strava-bound activity log — it doesn't require the write/control work at all.

## 5. What's still open

Phase 0 (hardware verification) is done — Start/Stop/Pause/Set-Speed all confirmed working on our actual 5L via [control.js](control.js), and the Set Speed trailer table is solved. Nothing is blocking Phase 1. Remaining nice-to-haves, not blockers:

1. `SPEED_TRAILER_TABLE` only covers targets 10-20 and 25 — the practical treadmill speed range is likely wider (and possibly has a lower floor below 10). `control.js` auto-searches and remembers any target it hasn't seen, so this isn't a blocker, just something that fills in with use.
2. Only one data point confirms the ×0.1 km/h scale for raw speed values (raw 20 = 2.0 km/h) — worth a couple more spot checks against the console before hardcoding it into the app UI.
3. Incline command structure is documented but not implemented — pick up if/when incline support is wanted.

## 6. Build plan

### Phase 0 — Hardware verification ✅ done
Confirmed via `control.js`: Start, Stop, Pause, and Set Speed (with live trailer search fallback) all work against the real treadmill.

### Phase 1 — BLE controller module
A small class wrapping: connect, handshake, `start()`, `stop()`, `pause()`, `setSpeed(kmh)`, plus an event emitter for live telemetry (status + speed) parsed from `fff1` (fallback to `2acd` if `fff1` proves unreliable).

### Phase 2 — Session recorder
Subscribes to the controller's telemetry events; records a timestamped series of (time, speed) samples between a detected Start and Stop/end-of-session; computes duration and distance (integrate speed × time — more reliable than trusting the device's own distance field, per earlier findings).

### Phase 3 — macOS app shell
Menu bar or small window app wrapping phases 1–2: connect, a Start/Stop/speed +/− UI, and a live readout. This is the actual "mimic the official app" surface the original goal asked for.

### Phase 4 — Strava export
Separate concern, no BLE involved: convert a recorded session into a TCX/GPX-less "treadmill run" activity and upload via Strava's API (OAuth token setup required, one-time).

Nothing here has been implemented yet — this file is the reference for that build, once Phase 0 confirms the protocol on our actual hardware.
