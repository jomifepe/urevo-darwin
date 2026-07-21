# Urevo SpaceWalk 5L (URTM054) BLE Protocol — Findings & Build Plan

Status: **research phase complete for start/stop/pause/speed + telemetry. Incline is explicitly out of scope for now.** The one remaining gap before writing code is hardware verification — none of the control commands below have been fired at our actual treadmill yet; they're confirmed from a sibling device's real capture (same OEM firmware family). This device (URTM054) shares its exact GATT layout with the Urevo E1L (URTM041), documented and captured by the [TreadSpan project](https://github.com/blak3r/treadspan/tree/main/protocol-analysis/urevo-E1L). Everything below marked "confirmed" comes from diffing that project's real `urevo-with-urevo-mobile-app.pcapng` capture against our own passive capture of the 5L.

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
| **Start / Resume** | `02 53 01 00 00 00 00 00 00 00 00 0e 03` | High — fixed, reproducible bytes, confirmed transitions telemetry status to "running" |
| **Stop** | `02 53 03 0c 03` | High — fixed bytes, used twice in capture, both times confirmed transitioning status to "stopped" |
| **Pause** (temporary ramp-to-0, resumable) | `02 53 0a 07 03` | High — fixed bytes, used twice, confirmed status→pause-transition→speed ramps to 0 |
| **Set speed** | `02 53 02 <speed_lo> <speed_hi> <trailer> 03` | Medium — speed field confirmed (raw value, little-endian, directly matches the value later reported in telemetry); trailer byte is **not a simple checksum** (ruled out CRC8/XOR/sum computationally) — best-fit hypothesis from 3 data points is `trailer = 1 + 3 × (target − current)`. **Needs live verification** — may also be a value the firmware doesn't strictly validate. |
| Set incline | *unknown* | **Out of scope for now** — the reference session never changed incline, and we're not pursuing it at this time. |
| Unknown one-time setup write | `02 40 02 18 03` (sent once, right after Start) | Low — purpose unconfirmed, likely safe to replay verbatim since it's exactly what the real app sends at the same point in the sequence. |

## 3. Live telemetry (notify on `fff1`)

The app does **not** rely on standard FTMS (`2acd`) for live data — it fires only 2-3 times then goes silent. All real telemetry rides on `fff1`, in 19-byte frames: `02 51 <status> <speed_lo> <speed_hi=00> <elapsed?> ... `

| Offset | Field | Confidence |
|---|---|---|
| 2 | Status: `03`=running, `01`=stopped, `04`/`0a`=pausing/paused transition | High — confirmed against every Start/Stop/Pause write in the capture |
| 3–4 (u16 LE) | Current speed, raw units — matches Set Speed command value directly | High |
| 5 onward | Elapsed-time-like incrementing counter, distance/energy-like fields | Medium — increments correctly but exact field boundaries not fully mapped (lower priority; our own `2acd` decode already gives a reliable elapsed-time source) |

## 4. Standard FTMS path (`2acd`, already built)

Already implemented and self-tested in [bleinspect.js](bleinspect.js) (`decodeTreadmillData()`), confirmed against our own real capture:
- Speed (offset 2–3, ×0.1 km/h — best fit, not yet cross-checked against console display)
- Incline (offset 7–8, ×0.1 %)
- Elapsed time (offset 21–22, seconds, freezes on stop)

This channel is low-frequency/unreliable for live control feedback (per §3) but is a fine, already-working source for session start/stop timestamps and speed samples for a Strava-bound activity log — it doesn't require the write/control work at all.

## 5. What's still open (incline excluded)

1. **Hardware verification** — Start/Stop/Pause/Set-Speed are confirmed on a sibling device (E1L), not yet fired at our own 5L. Same GATT layout strongly suggests the same firmware family, but this needs a live check before the app can depend on it.
2. **Set Speed trailer formula** — confirm `1 + 3×delta` (or discover the real rule / discover the firmware doesn't validate it at all) by sending a few test writes and watching `fff1` + the physical console.

Nothing else is blocking. Telemetry (speed, duration, start/stop detection) is already confirmed on our own real hardware independent of any of this.

## 6. Build plan

### Phase 0 — Hardware verification (do this first, small and low-risk)
Extend `bleinspect.js` into a control-test script:
1. Run the connection setup + `fff2` handshake (§1).
2. Send **Stop** (`02 53 03 0c 03`) first, even at rest — confirms the write path works and is safe (should be a no-op if already stopped).
3. Send **Start** (§2), confirm console + `fff1`/`2acd` telemetry both show "running".
4. Send **Set Speed** to one nearby value, confirm the console and telemetry agree; try a second value to test the trailer formula.
5. Send **Pause**, then **Stop**, confirming clean transitions both times.
Treadmill safety basics apply throughout: nobody standing on it during the first tests, low speeds only, physical stop/console within reach.

### Phase 1 — BLE controller module
A small class wrapping: connect, handshake, `start()`, `stop()`, `pause()`, `setSpeed(kmh)`, plus an event emitter for live telemetry (status + speed) parsed from `fff1` (fallback to `2acd` if `fff1` proves unreliable).

### Phase 2 — Session recorder
Subscribes to the controller's telemetry events; records a timestamped series of (time, speed) samples between a detected Start and Stop/end-of-session; computes duration and distance (integrate speed × time — more reliable than trusting the device's own distance field, per earlier findings).

### Phase 3 — macOS app shell
Menu bar or small window app wrapping phases 1–2: connect, a Start/Stop/speed +/− UI, and a live readout. This is the actual "mimic the official app" surface the original goal asked for.

### Phase 4 — Strava export
Separate concern, no BLE involved: convert a recorded session into a TCX/GPX-less "treadmill run" activity and upload via Strava's API (OAuth token setup required, one-time).

Nothing here has been implemented yet — this file is the reference for that build, once Phase 0 confirms the protocol on our actual hardware.
