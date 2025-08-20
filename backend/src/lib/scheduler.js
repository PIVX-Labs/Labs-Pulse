// Scheduler that aligns to UTC hour boundaries and triggers snapshotting.
const { startOfNextUtcHourMs, hourBucketUtcMs } = require('./time');

const USE_MINUTE_BUCKETS = process.env.PULSE_DEBUG_MINUTE_BUCKETS === '1';
const BUCKET_SIZE_MS = USE_MINUTE_BUCKETS ? 60000 : 3600000;

function startScheduler(onHour) {
  let timeoutId;
  let lastEmitted = null;
  let runningBoundary = null;

  function scheduleNext() {
    const now = Date.now();
    const nextBoundary = startOfNextUtcHourMs(now);
    const delay = Math.max(0, nextBoundary - now);

    // Clear any existing timeout
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      // The completed period is the boundary minus the bucket size (hour or minute)
      const completedHour = nextBoundary - BUCKET_SIZE_MS;

      // Guard against double-firing for the same boundary
      if (completedHour === lastEmitted || completedHour === runningBoundary) {
        scheduleNext();
        return;
      }

      runningBoundary = completedHour;

      Promise.resolve(onHour(completedHour))
        .catch((err) => {
          console.error('Error in onHour callback:', err);
        })
        .finally(() => {
          lastEmitted = completedHour;
          runningBoundary = null;
          scheduleNext();
        });
    }, delay);
  }

  // Start the scheduler
  scheduleNext();

  // Return stop function
  return function stop() {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  };
}

module.exports = {
  startScheduler
};