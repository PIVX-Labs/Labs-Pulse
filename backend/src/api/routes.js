const express = require("express");
const { getLatestSnapshot } = require("../lib/persistence");
const { hourBucketUtcMs, startOfNextUtcHourMs } = require("../lib/time");

const router = express.Router();

// Liveness of the backend itself
router.get("/ping", (req, res) => {
  const bucket_size_ms =
    process.env.PULSE_DEBUG_MINUTE_BUCKETS === '1' ? 60000 : 3600000;
  res.json({ ok: true, now_utc_ms: Date.now(), bucket_size_ms });
});

// List configured services (from config)
router.get("/services", (req, res) => {
  const config = req.app.locals.config;
  const services = (config.services || []).map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    tags: s.tags || [],
    slow_threshold_ms: s.slow_threshold_ms,
    timeout_ms: s.timeout_ms
  }));
  res.json({ services });
});

// Current health derived from real-time accumulator data
router.get("/health", async (req, res) => {
  try {
    const config = req.app.locals.config;
    const accumulator = req.app.locals.accumulator;
    const services = config.services || [];
    
    // Get current hour bucket for real-time data
    const now = Date.now();
    const currentBucket = hourBucketUtcMs(now);
    
    // Helper function to calculate ping_ms from accumulator data
    // Returns 0 if the last 2 pings failed
    const calculatePingMs = (data) => {
      if (!data || data.samples_ok === 0) {
        return 0;
      }
      
      // Check if last 2 results were failures
      if (data.recent_results && data.recent_results.length >= 2) {
        const lastTwo = data.recent_results.slice(-2);
        if (lastTwo[0] === false && lastTwo[1] === false) {
          return 0; // Last 2 pings failed, show as down
        }
      }
      
      // Otherwise calculate median of successful pings
      const latencies = data.success_latencies.sort((a, b) => a - b);
      const len = latencies.length;
      if (len % 2 === 0) {
        return Math.round((latencies[len / 2 - 1] + latencies[len / 2]) / 2);
      } else {
        return latencies[Math.floor(len / 2)];
      }
    };
    
    // For each configured service, get real-time data
    const serviceHealth = [];
    
    for (const service of services) {
      // Get current hour's real-time data from accumulator
      const currentHourData = accumulator.getCurrentHourData(service.id, currentBucket);
      const lastPingMs = calculatePingMs(currentHourData);
      
      // Derive status and color
      const status = lastPingMs > 0 ? 'up' : 'down';
      let color = 'red'; // red when ping_ms = 0
      if (lastPingMs > 0 && lastPingMs <= service.slow_threshold_ms) {
        color = 'green'; // green when 0 < ping_ms ≤ slow_threshold_ms
      } else if (lastPingMs > service.slow_threshold_ms) {
        color = 'yellow'; // yellow when ping_ms > slow_threshold_ms
      }
      
      serviceHealth.push({
        id: service.id,
        status,
        last_hour_utc_ms: currentBucket,
        last_ping_ms: lastPingMs,
        color
      });
    }
    
    res.json({
      updated_at_utc_ms: now,
      services: serviceHealth
    });
  } catch (err) {
    console.error('Error fetching health data:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Historical snapshots
router.get("/snapshots", async (req, res) => {
  try {
    const { service_id, from_utc_ms, to_utc_ms, limit } = req.query;
    
    // Validate required parameters
    if (!service_id) {
      return res.status(400).json({ error: "service_id is required" });
    }
    
    if (!from_utc_ms || !to_utc_ms) {
      return res.status(400).json({ error: "from_utc_ms and to_utc_ms are required" });
    }
    
    // Parse and validate parameters
    const fromUtcMs = parseInt(from_utc_ms, 10);
    const toUtcMs = parseInt(to_utc_ms, 10);
    
    if (isNaN(fromUtcMs) || isNaN(toUtcMs)) {
      return res.status(400).json({ error: "from_utc_ms and to_utc_ms must be valid integers" });
    }
    
    if (fromUtcMs > toUtcMs) {
      return res.status(400).json({ error: "from_utc_ms must be less than or equal to to_utc_ms" });
    }
    
    // Parse limit if provided
    let limitValue = null;
    if (limit) {
      limitValue = parseInt(limit, 10);
      if (isNaN(limitValue) || limitValue <= 0) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
    }
    
    // Split service_id into array
    const ids = String(service_id).split(",").map((s) => s.trim()).filter(Boolean);
    
    // Validate service IDs against config
    const config = req.app.locals.config;
    const validServices = new Set((config.services || []).map(s => s.id));
    const invalidIds = ids.filter(id => !validServices.has(id));
    
    if (invalidIds.length > 0) {
      return res.status(400).json({
        error: `Invalid service_id(s): ${invalidIds.join(', ')}`
      });
    }
    
    // Import readSnapshots function
    const { readSnapshots } = require("../lib/persistence");
    
    // Enforce maximum of 168 hours worth of data per service,
    // converted to bucket count depending on bucket size (minute/hour).
    const maxHours = 168;
    const bucketSize = process.env.PULSE_DEBUG_MINUTE_BUCKETS === '1' ? 60000 : 3600000;
    const maxBuckets = maxHours * (bucketSize === 60000 ? 60 : 1);
    // Inclusive buckets: if from==to that's 1 bucket
    const requestedBuckets = Math.floor((toUtcMs - fromUtcMs) / bucketSize) + 1;
    const effectiveLimit = limitValue ? Math.min(limitValue, maxBuckets) : maxBuckets;
    
    if (requestedBuckets > maxBuckets) {
      return res.status(400).json({
        error: `Requested time window exceeds maximum of ${maxHours} hours per service`
      });
    }
    
    // Read snapshots
    const snapshotsData = await readSnapshots(ids, fromUtcMs, toUtcMs, effectiveLimit);
    
    // Get current hour bucket and add real-time data as last datapoint
    const now = Date.now();
    const currentBucket = hourBucketUtcMs(now);
    const accumulator = req.app.locals.accumulator;
    
    
    // Helper function to calculate ping_ms from accumulator data
    // Returns 0 if the last 2 pings failed
    const calculatePingMs = (data) => {
      if (!data || data.samples_ok === 0) {
        return 0;
      }
      
      // Check if last 2 results were failures
      if (data.recent_results && data.recent_results.length >= 2) {
        const lastTwo = data.recent_results.slice(-2);
        if (lastTwo[0] === false && lastTwo[1] === false) {
          return 0; // Last 2 pings failed, show as down
        }
      }
      
      // Otherwise calculate median of successful pings
      const latencies = data.success_latencies.sort((a, b) => a - b);
      const len = latencies.length;
      if (len % 2 === 0) {
        return Math.round((latencies[len / 2 - 1] + latencies[len / 2]) / 2);
      } else {
        return latencies[Math.floor(len / 2)];
      }
    };
    
    // Add real-time data for each service
    for (const id of ids) {
      const currentHourData = accumulator.getCurrentHourData(id, currentBucket);
      const pingMs = calculatePingMs(currentHourData);
      const timestampToUse = currentBucket;
      
      // Only add if timestamp is within the requested range
      if (timestampToUse >= fromUtcMs && timestampToUse <= toUtcMs) {
        if (!snapshotsData[id]) {
          snapshotsData[id] = [];
        }
        
        // Check if we already have this timestamp in historical data
        const hasCurrentBucket = snapshotsData[id].some(s => s.hour_utc_ms === timestampToUse);
        
        // Only add if not already present (avoid duplicates)
        if (!hasCurrentBucket) {
          const datapoint = {
            hour_utc_ms: timestampToUse,
            ping_ms: pingMs
          };
          
          // Add last_check_ms for real-time datapoints so frontend can show actual check time
          if (currentHourData && currentHourData.last_check_ms) {
            datapoint.last_check_ms = currentHourData.last_check_ms;
          }
          
          snapshotsData[id].push(datapoint);
        }
      }
    }
    
    // Format response
    if (ids.length === 1) {
      // For one service_id, respond with service_id and snapshots array
      const snapshots = (snapshotsData[ids[0]] || [])
        .sort((a, b) => a.hour_utc_ms - b.hour_utc_ms)
        .map(snapshot => {
          const result = {
            hour_utc_ms: snapshot.hour_utc_ms,
            ping_ms: snapshot.ping_ms
          };
          // Include last_check_ms if present (for real-time datapoints)
          if (snapshot.last_check_ms) {
            result.last_check_ms = snapshot.last_check_ms;
          }
          return result;
        });
      
      return res.json({
        service_id: ids[0],
        snapshots
      });
    } else {
      // For multiple, respond with results array
      const results = ids.map(id => {
        const snapshots = (snapshotsData[id] || [])
          .sort((a, b) => a.hour_utc_ms - b.hour_utc_ms)
          .map(snapshot => {
            const result = {
              hour_utc_ms: snapshot.hour_utc_ms,
              ping_ms: snapshot.ping_ms
            };
            // Include last_check_ms if present (for real-time datapoints)
            if (snapshot.last_check_ms) {
              result.last_check_ms = snapshot.last_check_ms;
            }
            return result;
          });
        
        return {
          service_id: id,
          snapshots
        };
      });
      
      return res.json({ results });
    }
  } catch (err) {
    console.error('Error fetching snapshots:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;