const { startServer } = require("./api/server");
const { loadConfig } = require("./lib/config");
const { startPoller } = require("./lib/poller");
const { startScheduler } = require("./lib/scheduler");
const { recordSample, getAndResetForHour, clearHour } = require("./lib/accumulator");
const { writeHourlySnapshot, pruneRetention } = require("./lib/persistence");
const { hourBucketUtcMs } = require("./lib/time");

async function main() {
  const config = await loadConfig();
  const port = process.env.PORT || 8080;
  
  // Start the HTTP server
  await startServer({ port, config });

  // Log bucket mode at startup for debugging
  const bucketSizeMs = process.env.PULSE_DEBUG_MINUTE_BUCKETS === '1' ? 60000 : 3600000;
  console.log(`[Startup] Bucket mode: ${bucketSizeMs === 60000 ? 'minute (60s)' : 'hourly (3600s)'}`);
  
  // Start the poller
  const stopPoller = startPoller(config, {
    recordSample
  });
  
  // Start the scheduler
  const stopScheduler = startScheduler(async (completedHourUtcMs) => {
    console.log(`Hour rollover: ${new Date(completedHourUtcMs).toISOString()}`);
    
    // Get and reset accumulator data for the completed hour
    const accumulatorData = getAndResetForHour(completedHourUtcMs);
    
    let writeCount = 0;
    
    // Process each configured service
    for (const service of config.services) {
      let pingMs = 0;
      
      // Check if we have accumulator data for this service
      if (accumulatorData[service.id]) {
        const data = accumulatorData[service.id];
        // If we have successful samples, calculate median
        if (data.samples_ok > 0) {
          const latencies = data.success_latencies.sort((a, b) => a - b);
          const len = latencies.length;
          if (len % 2 === 0) {
            // Even number of elements - average of two middle values
            pingMs = Math.round((latencies[len / 2 - 1] + latencies[len / 2]) / 2);
          } else {
            // Odd number of elements - middle element
            pingMs = latencies[Math.floor(len / 2)];
          }
        }
        // If no successful samples, pingMs remains 0
      }
      // If no accumulator data for service, pingMs remains 0
      
      // Write snapshot for this service
      await writeHourlySnapshot(service.id, completedHourUtcMs, pingMs);
      writeCount++;
    }
    
    console.log(`Wrote ${writeCount} snapshots for hour ${new Date(completedHourUtcMs).toISOString()}`);
    
    // Prune old data based on retention policy
    await pruneRetention(config.retention_days, Date.now());
  });
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    stopPoller();
    stopScheduler();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    stopPoller();
    stopScheduler();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error starting Labs Pulse:", err);
  process.exit(1);
});