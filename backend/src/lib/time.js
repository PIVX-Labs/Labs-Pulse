// Basic time utilities shared across components.
const MINUTE = 60000;
const HOUR = 3600000;

// Use minute buckets for debugging if PULSE_DEBUG_MINUTE_BUCKETS is set to 1
const USE_MINUTE_BUCKETS = process.env.PULSE_DEBUG_MINUTE_BUCKETS === '1';

function hourBucketUtcMs(tsMs) {
  const bucketSize = USE_MINUTE_BUCKETS ? MINUTE : HOUR;
  return Math.floor(tsMs / bucketSize) * bucketSize;
}

function monthKeyFromUtcMs(tsMs) {
  const date = new Date(tsMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function startOfNextUtcHourMs(nowMs) {
  const bucketSize = USE_MINUTE_BUCKETS ? MINUTE : HOUR;
  return Math.ceil(nowMs / bucketSize) * bucketSize;
}

function getMonthKeysBetween(fromUtcMs, toUtcMs) {
  const monthKeys = new Set();
  const currentDate = new Date(fromUtcMs);
  const toDate = new Date(toUtcMs);
  
  // Set to first day of month at 00:00:00 UTC
  currentDate.setUTCDate(1);
  currentDate.setUTCHours(0, 0, 0, 0);
  
  while (currentDate <= toDate) {
    const year = currentDate.getUTCFullYear();
    const month = String(currentDate.getUTCMonth() + 1).padStart(2, '0');
    monthKeys.add(`${year}-${month}`);
    
    // Move to next month
    currentDate.setUTCMonth(currentDate.getUTCMonth() + 1);
  }
  
  return Array.from(monthKeys);
}

module.exports = { hourBucketUtcMs, monthKeyFromUtcMs, startOfNextUtcHourMs, getMonthKeysBetween };