/* Seed recent snapshots for quick visual checks.
   Bucket size follows runtime:
   - PULSE_DEBUG_MINUTE_BUCKETS=1 => 60s buckets
   - else => 1h buckets
*/
const path = require("path");
const { loadConfig } = require("../src/lib/config");
const { hourBucketUtcMs } = require("../src/lib/time");
const persistence = require("../src/lib/persistence");

function bucketMs() {
  return process.env.PULSE_DEBUG_MINUTE_BUCKETS === "1" ? 60000 : 3600000;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  const cfg = await loadConfig();
  const BUCKET = bucketMs();
  const WINDOW_LEN = BUCKET === 60000 ? 180 : 48; // 3h for minute mode; 2 days for hourly
  const now = Date.now();
  const currentBucketStart = Math.floor(now / BUCKET) * BUCKET;
  const endBucketStart = currentBucketStart - BUCKET; // last completed
  const startBucketStart = endBucketStart - (WINDOW_LEN - 1) * BUCKET;

  let totalWrites = 0;

  for (const svc of cfg.services) {
    let writes = 0;
    for (let t = startBucketStart; t <= endBucketStart; t += BUCKET) {
      // 15% chance fully down
      let ping = 0;
      const downRoll = Math.random();
      if (downRoll >= 0.15) {
        // Up: 10% chance slow (yellow), else healthy (green-ish)
        const slowRoll = Math.random();
        if (slowRoll < 0.10) {
          ping = randInt(Math.max(svc.slow_threshold_ms || 1000, 1000), (svc.slow_threshold_ms || 1000) + 1000);
        } else {
          // Healthy 150–900ms
          ping = randInt(150, Math.max((svc.slow_threshold_ms || 1000) - 50, 200));
        }
      }

      await persistence.writeHourlySnapshot(svc.id, t, ping);
      writes++;
      totalWrites++;
    }
    console.log(`Seeded ${writes} snapshots for service ${svc.id}`);
  }

  console.log(`Seed complete. Total snapshots upserted: ${totalWrites}`);
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});