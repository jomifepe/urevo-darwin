# Urevo SpaceWalk 5L (URTM054) BLE Protocol Reference

Reverse-engineered Bluetooth LE protocol for the Urevo SpaceWalk 5L walking pad (device name `URTM054`). This device shares its exact GATT layout and command structure with the Urevo E1L (`URTM041`), originally documented by the [TreadSpan project](https://github.com/blak3r/treadspan/tree/main/protocol-analysis/urevo-E1L) — same OEM firmware family. Everything below is confirmed against our own hardware unless explicitly marked otherwise.

Sources of evidence, in order of reliability:
1. Real HCI snoop captures of the official Urevo app controlling this exact treadmill (two independent sessions, days apart, one sweeping the full speed range) — the strongest evidence, used to build the complete speed/incline tables.
2. Our own hardware tests via [control.js](control.js) (writes + telemetry readback).
3. TreadSpan's E1L capture, for the parts that carried over unchanged (mainly the GATT layout and frame delimiters).

## 1. GATT layout

```
Service 0x1800 (Generic Access)
  0x2a00 (Device Name)
Service 0x180a (Device Information)
  0x2a23, 0x2a24 (Model), 0x2a25 (Serial), 0x2a26 (FW rev), 0x2a27 (HW rev), 0x2a28 (SW rev), 0x2a29 (Manufacturer)
Service 0x1826 (Fitness Machine Service — standard FTMS, low value, see §5)
  0x2acc (Feature), 0x2acd (Treadmill Data) [NOTIFY]
  0x2ad3 (Training Status) [READ, NOTIFY]
  0x2ad4 (Supported Speed Range), 0x2ad5, 0x2ad7
  0x2ad9 (Fitness Machine Status) [WRITE, INDICATE]
  0x2ada [NOTIFY]
Service 0xfff0 (proprietary — THE real control/telemetry channel)
  0xfff1 [NOTIFY] — live telemetry, see §4
  0xfff2 [WRITE, WRITE WITHOUT RESPONSE] — command channel, see §3
Service 0xfee0 (proprietary, secondary — purpose not investigated)
  0xfee1 [NOTIFY], 0xfee2 [WRITE]
Service 5833ff01-9b8b-5191-6142-22a4536ef123 (proprietary, custom 128-bit — purpose not investigated)
  5833ff02 [WRITE], 5833ff03 [NOTIFY]
```

Device Information strings report Manufacturer as the literal string `"0x01"` (not a real name) — a known quirk of this OEM firmware family, also seen on the E1L.

## 2. Connection setup

1. Connect, discover all services/characteristics.
2. Enable notifications (write CCCD `01 00`) on:
   - `fff1` (service `fff0`) — **the real live telemetry channel**, see §4
   - `2acd` (service `1826`) — standard FTMS, low value, see §5
3. Write handshake to `fff2` (service `fff0`), in order:
   - `02 51 0b 03`
   - `02 50 03 09 03`

   Required — without this handshake, `fff1` never emits anything.

## 3. Control commands (write to `fff2`)

Frame shape: `02 <CMD> <SUBCMD> [DATA...] <TRAILER> 03` (`02`/`03` are start/end markers).

| Action | Bytes to write | Notes |
|---|---|---|
| **Start / Resume** | `02 53 01 00 00 00 00 00 00 00 00 0e 03` immediately followed by `02 40 02 18 03` | Both frames sent together — the second frame's exact purpose is unconfirmed (possibly arms manual control) but is always sent by the real app right after Start, so it's replicated verbatim. Belt starts, telemetry status transitions to `running`. |
| **Stop** | `02 53 03 0c 03` | Fixed bytes. Belt stops, telemetry status transitions to `stopped`. |
| **Pause** (temporary ramp-to-0, resumable) | `02 53 0a 07 03` | Fixed bytes. Belt ramps to 0 and holds; a subsequent Start-family resume behavior was observed but not separately isolated from Start itself. |
| **Set speed** | `02 53 02 <target_lo> <target_hi=00> <trailer> 03` | `target` is the raw speed value, little-endian u16 (high byte always 0 in practice — max observed value 60 fits in one byte). Scale: raw × 0.1 = km/h (raw 20 confirmed as 2.0 km/h against the console). The `trailer` byte is **not a computable checksum** — it's a lookup table keyed by **target value alone** (not current speed, not delta — see §3.1 for the full table and how this was determined). Large jumps work fine in a single command once the target's trailer is known; there is no separate "ramp" command — the treadmill accepts a direct jump to any known target. |
| **Set incline** | `02 53 02 0a <level×10> <trailer> 03` | Same `02 53 02` prefix as speed, but byte 4 is a fixed selector `0x0a` (not part of a 2-byte target) and byte 5 is the incline level × 10 (raw levels 0, 10, 20 ... 90 for the 9 incline steps + off). Trailer is target-only here too — see §3.2. Implemented as fire-and-forget (`incline <0-9>` in `control.js`) — unlike speed, there's no telemetry field to confirm it landed (§4), so it's send-only. |
| **Toggle beep** | `02 40 03 01 00×15 1e 03` (20 bytes, mostly zero-padded) | Stateless toggle — the identical frame is sent for both turning the beep on and off; the device tracks on/off state internally, not the app. Implemented (`beep` in `control.js`). |

Multi-step UI actions (e.g. "jump incline from 9 to 0" via a single button/gesture) are implemented **client-side** by the official app as a rapid burst of individual step commands (~0.2s apart) — there is no special "jump directly" wire command. Worth replicating if building smooth multi-step transitions.

### 3.1 Set Speed trailer table (complete, full range)

Confirmed via an HCI capture that swept the treadmill's entire speed range (1.0–6.0 km/h), with zero conflicts against three earlier independent sessions. No linear, XOR/sum, CRC8 (all reasonable polynomials/inits/framings), or quadratic formula fits this table — it's almost certainly a firmware-side calibration table (e.g. real motor/PWM constants per speed), not computed math. Baked into `control.js` as `SPEED_TRAILER_TABLE`:

```
10: 0x05   21: 0x30   32: 0x2f   43: 0xda   54: 0xd1
11: 0x3a   22: 0x31   33: 0x2c   44: 0xdb   55: 0xd6
12: 0x3b   23: 0x36   34: 0x2d   45: 0xd8   56: 0xd7
13: 0x38   24: 0x37   35: 0x22   46: 0xd9   57: 0xd4
14: 0x39   25: 0x34   36: 0x23   47: 0xde   58: 0xd5
15: 0x3e   26: 0x35   37: 0x20   48: 0xdf   59: 0xca
16: 0x3f   27: 0x2a   38: 0x21   49: 0xdc   60: 0xcb
17: 0x3c   28: 0x2b   39: 0x26   50: 0xdd
18: 0x3d   29: 0x28   40: 0x27   51: 0xd2
19: 0x32   30: 0x29   41: 0x24   52: 0xd3
20: 0x33   31: 0x2e   42: 0x25   53: 0xd0
```

Any target outside 10-60 is not expected on this treadmill, but if one ever comes up, `control.js` finds it via an exhaustive 0-255 trailer search (ground-truthed against telemetry) and remembers it for the rest of the process.

### 3.2 Set Incline trailer table (complete, all 9 levels)

Same target-only behavior as speed (confirmed identical trailer regardless of direction/current incline):

```
 0: 0x05  (shares encoding with speed target=10 — coincidentally identical trailer)
10: 0x33   40: 0xdd   70: 0xff
20: 0x29   50: 0xcb   80: 0xf5
30: 0x27   60: 0xc1   90: 0xe3
```

## 4. Live telemetry (notify on `fff1`)

The official app does **not** rely on standard FTMS (`2acd`) for live data — it fires only 2-3 times after connecting then goes silent for the rest of the session. All real telemetry rides on `fff1`, prefixed `02 51 ...`.

**Frame length varies by state — never assume a fixed size.** Observed shapes:

- **6 bytes**, idle/minimal ping (status `0x00`, before Start): `02 51 <status> <pad> <checksum> 03` — no speed field at all.
- **19 or 25 bytes**, "full telemetry" (once running): `02 51 <status> <speed_lo> <speed_hi=00> <elapsed> ... <checksum> 03` — status and speed are at the same offset in both variants; the 25-byte one just has extra trailing fields.

Other prefixes (`02 40`, `02 50`, `02 53`) also appear on this same channel occasionally (acks/echoes of writes) — a different message class entirely; only decode frames starting `02 51`.

| Offset | Field | Notes |
|---|---|---|
| 2 | Status: `00`=idle, `01`=stopped, `03`=running, `04`=pausing (transition), `0a`=paused | Confirmed against every Start/Stop/Pause write and the idle state. |
| 3–4 (u16 LE) | Current speed, raw units — matches Set Speed command value directly | **Only present in frames ≥19 bytes** — the 6-byte idle ping has no speed field. |
| 5 onward | Elapsed-time-like incrementing counter, and (in the 25-byte variant) a slower-incrementing counter (likely distance) plus reserved/constant bytes | Increments correctly; exact field boundaries beyond elapsed time not fully mapped — low priority since `2acd` (§5) already gives a reliable elapsed-time source. |

## 5. Standard FTMS path (`2acd`)

Implemented and self-tested in [bleinspect.js](bleinspect.js) (`decodeTreadmillData()`):
- Speed (offset 2–3, ×0.1 km/h)
- Incline (offset 7–8, ×0.1 %)
- Elapsed time (offset 21–22, seconds, freezes on stop)

This channel only fires 2-3 times per session then goes silent (§4) — not useful for live control feedback, but a fine source for session start/stop timestamps and speed samples if `fff1` parsing is ever unavailable.

## 6. Open questions

- Only one data point confirms the ×0.1 km/h scale for raw speed values (raw 20 = 2.0 km/h) — worth a couple more spot checks against the console display to be fully sure, especially near the low end of the range.
- The exact algorithm behind the Set Speed / Set Incline trailer tables is unknown (confirmed to not be linear, XOR/sum, CRC8, or quadratic in target/current) — the tables above are complete and reliable regardless, so this is academic curiosity rather than a practical gap.
- `fee0`/`fee1`/`fee2` and the custom `5833ff01` service have never been investigated — unknown purpose.
- The elapsed-time/distance field layout in the 25-byte `fff1` telemetry frame (offset 5+) is only partially mapped.
