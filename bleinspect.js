#!/usr/bin/env node
// Passive BLE GATT inspector/logger. Connects to a chosen peripheral, dumps its
// GATT tree, subscribes to every notify/indicate characteristic, and logs every
// byte that comes through. Sends nothing to the device — read-only.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const noble = require('@stoprocent/noble');

const SCAN_SECONDS = 7;

// Small subset of Bluetooth SIG 16-bit UUIDs worth naming on sight.
// Not exhaustive — anything unrecognized just prints as raw hex.
const KNOWN_UUIDS = {
  '1800': 'Generic Access',
  '1801': 'Generic Attribute',
  '180a': 'Device Information',
  '180d': 'Heart Rate',
  '180f': 'Battery Service',
  '1826': 'Fitness Machine Service',
  '1816': 'Cycling Speed and Cadence',
  '1818': 'Cycling Power',
  '2a00': 'Device Name',
  '2a19': 'Battery Level',
  '2a24': 'Model Number String',
  '2a25': 'Serial Number String',
  '2a26': 'Firmware Revision String',
  '2a27': 'Hardware Revision String',
  '2a28': 'Software Revision String',
  '2a29': 'Manufacturer Name String',
  '2a37': 'Heart Rate Measurement',
  '2a38': 'Body Sensor Location',
  '2acc': 'Fitness Machine Feature',
  '2acd': 'Treadmill Data',
  '2ad2': 'Indoor Bike Data',
  '2ad3': 'Training Status',
  '2ad4': 'Supported Speed Range',
  '2ad6': 'Supported Resistance Level Range',
  '2ad8': 'Fitness Machine Control Point',
  '2ad9': 'Fitness Machine Status',
};

const BASE_UUID_RE = /^0000([0-9a-f]{4})00001000800000805f9b34fb$/;

function labelFor(uuid) {
  const norm = uuid.toLowerCase();
  const short = norm.length === 32 ? (norm.match(BASE_UUID_RE) || [])[1] : norm;
  const name = short && KNOWN_UUIDS[short];
  return name ? `${uuid} (${name})` : uuid;
}

function hex(buf) {
  return buf.toString('hex').match(/.{1,2}/g)?.join(' ') ?? '';
}

// Bluetooth SIG "Treadmill Data" (0x2ACD) decoder, flag-driven per spec.
// ponytail: speed/incline scale used here is 0.1 (spec default is 0.01) —
// best fit against observed start/speed-up/speed-down/stop behavior, but NOT
// yet cross-checked against the treadmill's own console readout. Verify and
// adjust SPEED_SCALE/INCLINE_SCALE below if the console shows different numbers.
const SPEED_SCALE = 0.1; // km/h per unit — verify against console, spec default is 0.01
const INCLINE_SCALE = 0.1; // % per unit — verify against console

function decodeTreadmillData(buf) {
  const flags = buf.readUInt16LE(0);
  let offset = 2;
  const out = {};

  if (!(flags & 0x0001)) { out.speedKmh = buf.readUInt16LE(offset) * SPEED_SCALE; offset += 2; }
  if (flags & 0x0002) { out.avgSpeedKmh = buf.readUInt16LE(offset) * SPEED_SCALE; offset += 2; }
  if (flags & 0x0004) { out.distanceM = buf.readUIntLE(offset, 3); offset += 3; }
  if (flags & 0x0008) {
    out.inclinePct = buf.readInt16LE(offset) * INCLINE_SCALE; offset += 2;
    out.rampAngleDeg = buf.readInt16LE(offset) * 0.1; offset += 2;
  }
  if (flags & 0x0010) {
    out.elevGainPosM = buf.readUInt16LE(offset) * 0.1; offset += 2;
    out.elevGainNegM = buf.readUInt16LE(offset) * 0.1; offset += 2;
  }
  if (flags & 0x0020) { out.instPaceMinPerKm = buf.readUInt8(offset) * 0.1; offset += 1; }
  if (flags & 0x0040) { out.avgPaceMinPerKm = buf.readUInt8(offset) * 0.1; offset += 1; }
  if (flags & 0x0080) {
    out.energyTotalKcal = buf.readUInt16LE(offset); offset += 2;
    out.energyPerHourKcal = buf.readUInt16LE(offset); offset += 2;
    out.energyPerMinKcal = buf.readUInt8(offset); offset += 1;
  }
  if (flags & 0x0100) { out.heartRateBpm = buf.readUInt8(offset); offset += 1; }
  if (flags & 0x0200) { out.metabolicEquivalent = buf.readUInt8(offset) * 0.1; offset += 1; }
  if (flags & 0x0400) { out.elapsedTimeS = buf.readUInt16LE(offset); offset += 2; }
  if (flags & 0x0800) { out.remainingTimeS = buf.readUInt16LE(offset); offset += 2; }
  if (flags & 0x1000) {
    out.forceN = buf.readInt16LE(offset); offset += 2;
    out.powerW = buf.readInt16LE(offset); offset += 2;
  }
  if (offset < buf.length) out.extraHex = hex(buf.subarray(offset));

  return out;
}

// --- log file ---------------------------------------------------------

const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `log-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function logEvent(event) {
  const record = { time: new Date().toISOString(), ...event };
  logStream.write(JSON.stringify(record) + '\n');
  return record;
}

// --- main ---------------------------------------------------------------

async function main() {
  console.log(`Logging to ${logPath}`);

  try {
    await noble.waitForPoweredOnAsync(10_000);
  } catch (err) {
    console.error(
      'Bluetooth adapter is not powered on. Enable Bluetooth and grant permission in ' +
        'System Settings > Privacy & Security > Bluetooth, then try again.'
    );
    process.exit(1);
  }

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
    const name = p.advertisement.localName || 'Unknown';
    console.log(`  [${i}] ${name} — ${p.id} (rssi ${p.rssi})`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nSelect device # to connect: ');
  rl.close();

  const chosen = devices[Number(answer)];
  if (!chosen) {
    console.error('Invalid selection.');
    process.exit(1);
  }

  const cleanup = async () => {
    console.log('\nDisconnecting...');
    try {
      await chosen.disconnectAsync();
    } catch {
      // already disconnected
    }
    logStream.end();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  chosen.once('disconnect', () => {
    console.log('Device disconnected.');
    logStream.end();
    process.exit(0);
  });

  console.log(`Connecting to ${chosen.advertisement.localName || chosen.id}...`);
  await chosen.connectAsync();
  logEvent({ type: 'connect', device: chosen.id, name: chosen.advertisement.localName });

  const { services } = await chosen.discoverAllServicesAndCharacteristicsAsync();

  console.log('\nGATT tree:');
  let subscribed = 0;
  for (const service of services) {
    console.log(`  Service ${labelFor(service.uuid)}`);
    for (const characteristic of service.characteristics) {
      console.log(`    Characteristic ${labelFor(characteristic.uuid)} [${characteristic.properties.join(', ')}]`);

      if (characteristic.properties.includes('notify') || characteristic.properties.includes('indicate')) {
        const isTreadmillData = characteristic.uuid.toLowerCase() === '2acd';
        characteristic.on('data', (data, isNotification) => {
          const decoded = isTreadmillData ? decodeTreadmillData(data) : undefined;
          const record = logEvent({
            type: isNotification ? 'notify' : 'read',
            service: labelFor(service.uuid),
            characteristic: labelFor(characteristic.uuid),
            hex: hex(data),
            ...(decoded && { decoded }),
          });
          const suffix = decoded ? ` ${JSON.stringify(decoded)}` : '';
          console.log(`[${record.time}] ${record.characteristic}: ${record.hex}${suffix}`);
        });
        await characteristic.subscribeAsync();
        subscribed++;
      }
    }
  }

  console.log(`\nSubscribed to ${subscribed} characteristic(s). Watching for notifications... (Ctrl+C to stop)`);
}

// Self-check against a real captured packet (URTM054, incline raised to 1.0%).
// Run `node bleinspect.js --test` to verify the decoder without any hardware.
function selfTest() {
  const assert = require('node:assert');
  const packet = Buffer.from('9c2564000a00000a000000000000000100000000003000250000', 'hex');
  const decoded = decodeTreadmillData(packet);
  assert.strictEqual(decoded.speedKmh, 10.0);
  assert.strictEqual(decoded.inclinePct, 1.0);
  assert.strictEqual(decoded.elapsedTimeS, 0x30);
  console.log('decodeTreadmillData self-check passed:', decoded);
}

if (process.argv.includes('--test')) {
  selfTest();
} else {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
