// In-memory hourly accumulator keyed by service_id and hour bucket.
// Aggregates poll samples within the current hour before snapshotting to disk.
const { hourBucketUtcMs } = require('./time');

// In-memory data structure:
// {
//   [serviceId]: {
//     [hourBucket]: {
//       samples_total: number,
//       samples_ok: number,
//       success_latencies: number[]
//     }
//   }
// }
const data = {};

function recordSample(serviceId, timestampMs, ok, latencyMs) {
  const bucket = hourBucketUtcMs(timestampMs);
  
  // Initialize service data if not exists
  if (!data[serviceId]) {
    data[serviceId] = {};
  }
  
  // Initialize bucket data if not exists
  if (!data[serviceId][bucket]) {
    data[serviceId][bucket] = {
      samples_total: 0,
      samples_ok: 0,
      success_latencies: [],
      recent_results: [], // Track last N results (true/false for ok/fail)
      last_check_ms: null // Timestamp of most recent check
    };
  }
  
  // Update counters
  data[serviceId][bucket].samples_total++;
  if (ok) {
    data[serviceId][bucket].samples_ok++;
    data[serviceId][bucket].success_latencies.push(latencyMs);
  }
  
  // Track recent results (keep last 10 for analysis)
  data[serviceId][bucket].recent_results.push(ok);
  if (data[serviceId][bucket].recent_results.length > 10) {
    data[serviceId][bucket].recent_results.shift();
  }
  
  // Update last check timestamp
  data[serviceId][bucket].last_check_ms = timestampMs;
  
}

function getAndResetForHour(hourUtcMs) {
  const result = {};
  
  // For each service, check if it has data for the specified hour
  for (const serviceId in data) {
    if (data[serviceId][hourUtcMs]) {
      result[serviceId] = {
        samples_total: data[serviceId][hourUtcMs].samples_total,
        samples_ok: data[serviceId][hourUtcMs].samples_ok,
        success_latencies: data[serviceId][hourUtcMs].success_latencies
      };
      
      // Clear the data for this hour
      delete data[serviceId][hourUtcMs];
    }
  }
  
  return result;
}

function clearHour(hourUtcMs) {
  // For each service, clear data for the specified hour if it exists
  for (const serviceId in data) {
    if (data[serviceId][hourUtcMs]) {
      delete data[serviceId][hourUtcMs];
    }
  }
}

function getCurrentHourData(serviceId, hourUtcMs) {
  // Get current hour's data without resetting it
  if (data[serviceId] && data[serviceId][hourUtcMs]) {
    return {
      samples_total: data[serviceId][hourUtcMs].samples_total,
      samples_ok: data[serviceId][hourUtcMs].samples_ok,
      success_latencies: [...data[serviceId][hourUtcMs].success_latencies],
      recent_results: [...data[serviceId][hourUtcMs].recent_results],
      last_check_ms: data[serviceId][hourUtcMs].last_check_ms
    };
  }
  return null;
}

module.exports = {
  recordSample,
  getAndResetForHour,
  clearHour,
  getCurrentHourData
};