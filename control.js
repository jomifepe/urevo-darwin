#!/usr/bin/env node
// Interactive control script for the Urevo SpaceWalk 5L treadmill.
// Sends the proprietary fff2 commands documented in PROTOCOL.md (start, stop,
// pause, set speed) — all confirmed working against this exact unit.
// Nobody should be standing on the treadmill while testing.

const readline = require('node:readline');
const noble = require('@stoprocent/noble');

function ask(rl, query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

// Prints a line above the prompt without clobbering whatever the user is
// currently typing — plain console.log() while rl.prompt() is active would
// interleave with the input line and make the terminal look broken.
function printAbovePrompt(rl, text) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(text);
  rl.prompt(true);
}

const SCAN_SECONDS = 7;
const FFF1_UUID = 'fff1'; // notify — live status/speed feed
const FFF2_UUID = 'fff2'; // write — command channel

// Fixed, known-good command frames (see PROTOCOL.md §2).
const HANDSHAKE_FRAMES = [
  Buffer.from('02510b03', 'hex'),
  Buffer.from('0250030903', 'hex'),
];
const START_FRAME = Buffer.from('02530100000000000000000e03', 'hex');
// Sent by the real app immediately after every Start, purpose unconfirmed —
// possibly what actually arms manual speed control. Replicated verbatim
// since omitting it is the leading theory for why Set Speed was a no-op.
const POST_START_FRAME = Buffer.from('0240021803', 'hex');
const STOP_FRAME = Buffer.from('0253030c03', 'hex');
const PAUSE_FRAME = Buffer.from('02530a0703', 'hex');

// The trailer is a lookup table keyed by TARGET ALONE — not current, not
// delta (see PROTOCOL.md §2). Confirmed across three independent sessions:
// target=18 always needs 0x3d, target=10 always needs 0x05, target=20
// always needs 0x33, regardless of the speed it was coming from. This is
// almost certainly a firmware-side calibration table (e.g. motor/PWM
// constants per speed), not a computable formula — no linear/CRC8/quadratic
// fit ever matched. Seeded with every confirmed real value; grows at runtime
// as "speed"/"searchspeed" discover new ones (see rememberTrailer below).
const SPEED_TRAILER_TABLE = {
  10: 0x05, 11: 0x3a, 12: 0x3b, 13: 0x38, 14: 0x39, 15: 0x3e, 16: 0x3f,
  17: 0x3c, 18: 0x3d, 19: 0x32, 20: 0x33, 22: 0x31, 23: 0x36, 24: 0x37, 25: 0x34,
};

function buildSetSpeedFrame(targetRaw, trailer) {
  const t = trailer ?? SPEED_TRAILER_TABLE[targetRaw];
  if (t === undefined) throw new Error(`No known trailer for target=${targetRaw} — use searchspeed first`);
  const data = Buffer.alloc(2);
  data.writeUInt16LE(targetRaw, 0);
  return Buffer.from([0x02, 0x53, 0x02, data[0], data[1], t, 0x03]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// "02 51 ..." frames on fff1 are variable length depending on state (see
// PROTOCOL.md §3): a minimal 6-byte idle/status ping with no speed field,
// and longer 19- or 25-byte "full telemetry" frames that both carry speed
// at the same offset (3-4). Status is always at offset 2 regardless of
// length. Frames starting with anything other than "02 51" (e.g. "02 40",
// "02 50", "02 53" echoes) are a different message class — ignored.
function decodeFff1(buf) {
  if (buf.length < 6 || buf[0] !== 0x02 || buf[1] !== 0x51) return null;
  const status = buf[2];
  const speedRaw = buf.length >= 19 ? buf.readUInt16LE(3) : undefined;
  return { status, speedRaw };
}

const STATUS_NAMES = { 0x00: 'idle', 0x01: 'stopped', 0x03: 'running', 0x04: 'pausing', 0x0a: 'paused' };

async function main() {
  console.log('Urevo SpaceWalk 5L control script — Phase 0 hardware verification.');
  console.log('Make sure nobody is on the treadmill and you can reach the physical stop.\n');

  try {
    await noble.waitForPoweredOnAsync(10_000);
  } catch {
    console.error('Bluetooth adapter is not powered on. Check System Settings > Privacy & Security > Bluetooth.');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const deviceIdArg = process.argv.slice(2).find((a) => !a.startsWith('--'));

  let chosen;
  if (deviceIdArg) {
    console.log(`Connecting directly to ${deviceIdArg}...`);
    chosen = await noble.connectAsync(deviceIdArg);
  } else {
    const found = new Map();
    noble.on('discover', (peripheral) => found.set(peripheral.id, peripheral));

    console.log(`Scanning for ${SCAN_SECONDS}s...`);
    await noble.startScanningAsync([], false);
    await new Promise((resolve) => setTimeout(resolve, SCAN_SECONDS * 1000));
    await noble.stopScanningAsync();

    const devices = [...found.values()];
    if (devices.length === 0) {
      console.error('No BLE devices found. Try again closer to the treadmill.');
      process.exit(1);
    }

    console.log('\nDiscovered devices:');
    devices.forEach((p, i) => {
      console.log(`  [${i}] ${p.advertisement.localName || 'Unknown'} — ${p.id} (rssi ${p.rssi})`);
    });

    const answer = await ask(rl, '\nSelect device # to connect: ');
    chosen = devices[Number(answer)];
    if (!chosen) {
      console.error('Invalid selection.');
      process.exit(1);
    }

    console.log(`Connecting to ${chosen.advertisement.localName || chosen.id}...`);
    await chosen.connectAsync();
  }

  console.log(`Tip: next time, run "node control.js ${chosen.id}" to skip scanning.`);

  let currentSpeedRaw = 0;
  let currentStatus = null;
  let lastPrinted = '';

  const { characteristics } = await chosen.discoverAllServicesAndCharacteristicsAsync();
  const fff1 = characteristics.find((c) => c.uuid.toLowerCase() === FFF1_UUID);
  const fff2 = characteristics.find((c) => c.uuid.toLowerCase() === FFF2_UUID);
  if (!fff1 || !fff2) {
    console.error('This device does not expose fff1/fff2 — not the expected treadmill protocol.');
    process.exit(1);
  }

  const cleanup = async () => {
    console.log('\nStopping treadmill and disconnecting...');
    try {
      await fff2.writeAsync(STOP_FRAME, false);
    } catch {
      // best-effort safety stop
    }
    try {
      await chosen.disconnectAsync();
    } catch {
      // already disconnected
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  chosen.once('disconnect', () => {
    console.log('Device disconnected.');
    process.exit(0);
  });

  fff1.on('data', (data) => {
    const decoded = decodeFff1(data);
    if (!decoded) return;
    if (decoded.speedRaw !== undefined) currentSpeedRaw = decoded.speedRaw;
    currentStatus = decoded.status;
    const statusName = STATUS_NAMES[decoded.status] || `0x${decoded.status.toString(16)}`;
    const speedPart = decoded.speedRaw !== undefined ? ` speedRaw=${decoded.speedRaw}` : '';
    const line = `  [telemetry] status=${statusName}${speedPart}`;
    if (line !== lastPrinted) {
      lastPrinted = line;
      printAbovePrompt(rl, line);
    }
  });
  await fff1.subscribeAsync();

  console.log('Sending handshake...');
  for (const frame of HANDSHAKE_FRAMES) {
    await fff2.writeAsync(frame, false);
  }

  console.log(`
Commands:
  start            send Start
  stop             send Stop
  pause            send Pause
  speed <raw>      set speed directly to a raw value (known targets are instant; unknown ones auto-search)
  searchspeed <raw> force a fresh trailer search for one target, even if already known
  quit             stop and disconnect
`);

  async function handleCommand(line) {
    const [cmd, arg] = line.split(/\s+/);

    if (cmd === 'quit' || cmd === 'exit') {
      await cleanup();
    } else if (cmd === 'start') {
      await fff2.writeAsync(START_FRAME, false);
      await fff2.writeAsync(POST_START_FRAME, false);
      console.log('Sent Start (+ post-start init).');
    } else if (cmd === 'stop') {
      await fff2.writeAsync(STOP_FRAME, false);
      console.log('Sent Stop.');
    } else if (cmd === 'pause') {
      await fff2.writeAsync(PAUSE_FRAME, false);
      console.log('Sent Pause.');
    } else if (cmd === 'speed') {
      const target = Number(arg);
      if (!Number.isInteger(target) || target < 0) {
        console.log('Usage: speed <raw non-negative integer>');
        return;
      }
      if (currentStatus === null) {
        console.log(
          'No telemetry received yet, so success can\'t be confirmed either way — refusing. ' +
            'Run "start" and wait for a "[telemetry] status=running" line first.'
        );
        return;
      }
      if (currentStatus !== 0x03) {
        console.log(
          `Warning: device status is ${STATUS_NAMES[currentStatus] || 'unknown'}, not "running" — ` +
            'this command may be ignored. Try "start" first.'
        );
      }
      await setSpeed(target);
    } else if (cmd === 'searchspeed') {
      const target = Number(arg);
      if (!Number.isInteger(target) || target < 0) {
        console.log('Usage: searchspeed <raw non-negative integer>');
        return;
      }
      const trailer = await searchSpeedTrailer(target);
      if (trailer !== null) {
        rememberTrailer(target, trailer);
        console.log(`Speed change confirmed. Working trailer: 0x${trailer.toString(16).padStart(2, '0')} (remembered)`);
      } else {
        console.log('No trailer value (0x00-0xff) reached the target.');
      }
    } else {
      console.log(`Unknown command: ${cmd}`);
    }
  }

  // Polls currentSpeedRaw for up to timeoutMs, checking every intervalMs —
  // gives the motor/telemetry time to settle instead of one fixed sleep,
  // which was producing false "stuck" reports for a formula that was
  // probably right all along (see PROTOCOL.md §2).
  async function waitForSpeed(target, timeoutMs, intervalMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (currentSpeedRaw === target) return true;
      await sleep(intervalMs);
    }
    return currentSpeedRaw === target;
  }

  // Full 0-255 trailer search, ground-truthed against telemetry. Used when
  // "target" isn't in SPEED_TRAILER_TABLE yet. Since the trailer depends
  // only on target (not current), any confirmed result is remembered in the
  // table for the rest of the process — never re-searched once found.
  async function searchSpeedTrailer(target) {
    console.log(`Searching trailer bytes for target=${target} (up to ~3 min, Ctrl+C to abort)...`);
    for (let trailer = 0; trailer <= 0xff; trailer++) {
      if (currentSpeedRaw === target) return trailer;
      if (trailer % 16 === 0) console.log(`  ...tried ${trailer} value(s)`);
      const frame = buildSetSpeedFrame(target, trailer);
      await fff2.writeAsync(frame, false);
      if (await waitForSpeed(target, 700)) return trailer;
    }
    return null;
  }

  function rememberTrailer(target, trailer) {
    if (SPEED_TRAILER_TABLE[target] !== undefined && SPEED_TRAILER_TABLE[target] !== trailer) {
      console.log(`Note: target=${target} previously had trailer 0x${SPEED_TRAILER_TABLE[target].toString(16)}, now 0x${trailer.toString(16)} — overwriting.`);
    }
    SPEED_TRAILER_TABLE[target] = trailer;
  }

  // Sets speed directly to any target in one command — no more stepping.
  // Since the trailer only depends on target (not current/delta), a known
  // target can jump straight there regardless of how far away it is.
  async function setSpeed(target) {
    if (currentSpeedRaw === target) {
      console.log('Already at target.');
      return;
    }
    const known = SPEED_TRAILER_TABLE[target];
    if (known !== undefined) {
      // ponytail: the belt physically ramps to the new speed rather than
      // jumping instantly, so the wait scales with how far it has to travel
      // — a flat 3s was too short even for a modest delta of 5 (confirmed
      // trailer 0x34 for target=25 was correct on the first try; we just
      // gave up on it too early and re-discovered it the slow way via search).
      const delta = Math.abs(target - currentSpeedRaw);
      const timeoutMs = Math.min(60_000, Math.max(5_000, delta * 6_000));
      const frame = buildSetSpeedFrame(target, known);
      console.log(`Sending Set Speed ${currentSpeedRaw} -> ${target} (known trailer 0x${known.toString(16).padStart(2, '0')}, waiting up to ${(timeoutMs / 1000).toFixed(0)}s)`);
      await fff2.writeAsync(frame, false);
      if (await waitForSpeed(target, timeoutMs)) {
        console.log('Speed change confirmed.');
        return;
      }
      console.log(`Known trailer for target=${target} didn't land within ${(timeoutMs / 1000).toFixed(0)}s — searching fresh...`);
    }

    const trailer = await searchSpeedTrailer(target);
    if (trailer !== null) {
      rememberTrailer(target, trailer);
      console.log(`Speed change confirmed. Trailer 0x${trailer.toString(16).padStart(2, '0')} remembered for target=${target}.`);
    } else {
      console.log(`No trailer value (0x00-0xff) reached target=${target}.`);
    }
  }

  let busy = false;
  rl.setPrompt('> ');
  rl.prompt();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }
    if (busy) {
      console.log('Still processing the previous command, please wait...');
      rl.prompt();
      return;
    }
    busy = true;
    handleCommand(trimmed)
      .catch((err) => console.error('Error:', err.message))
      .finally(() => { busy = false; rl.prompt(); });
  });
}

// Self-check against real captured frames (see PROTOCOL.md §2/§3).
// Run `node control.js --test` to verify without any hardware.
function selfTest() {
  const assert = require('node:assert');

  assert.strictEqual(buildSetSpeedFrame(11).toString('hex'), '0253020b003a03');
  assert.strictEqual(buildSetSpeedFrame(12).toString('hex'), '0253020c003b03');
  assert.strictEqual(buildSetSpeedFrame(19).toString('hex'), '02530213003203');
  assert.strictEqual(buildSetSpeedFrame(20).toString('hex'), '02530214003303');
  assert.strictEqual(buildSetSpeedFrame(99, 0x7f).toString('hex'), '02530263007f03');

  const decoded = decodeFff1(Buffer.from('0251030600910002002a000200000000004303', 'hex'));
  assert.strictEqual(decoded.status, 0x03);
  assert.strictEqual(decoded.speedRaw, 6);

  // Real 6-byte idle ping (no speed field) — this exact shape broke a prior,
  // overly strict "must be 19 bytes" version of decodeFff1.
  const idle = decodeFff1(Buffer.from('025100000b03', 'hex'));
  assert.strictEqual(idle.status, 0x00);
  assert.strictEqual(idle.speedRaw, undefined);

  // Real 25-byte "running" frame (longer variant, extra fields beyond speed).
  const running25 = decodeFff1(Buffer.from('0251030a000000000000000000000000002a0000000000d203', 'hex'));
  assert.strictEqual(running25.status, 0x03);
  assert.strictEqual(running25.speedRaw, 10);

  // Non-"02 51" frames (other message classes) must be rejected, not misread.
  assert.strictEqual(decodeFff1(Buffer.from('0240020000000000000000000000000000001803', 'hex')), null);

  console.log('control.js self-check passed.');
}

if (process.argv.includes('--test')) {
  selfTest();
} else {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
