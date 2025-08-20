// Persistence layer that shards JSON files per service per month,
// writing snapshots atomically (temp file + rename), and reading ranged data.
const fs = require('fs/promises');
const path = require('path');
const { monthKeyFromUtcMs, hourBucketUtcMs } = require('./time');

const DATA_DIR = path.join(__dirname, '../../data');

function makeTempPath(filePath) {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
}

async function writeHourlySnapshot(serviceId, hourUtcMs, pingMs) {
  const monthKey = monthKeyFromUtcMs(hourUtcMs);
  const filePath = path.join(DATA_DIR, `${serviceId}-${monthKey}.json`);
  const tempPath = makeTempPath(filePath);
  
  // Ensure data directory exists
  await fs.mkdir(DATA_DIR, { recursive: true });
  
  let existingData = [];
  try {
    // Try to read existing file
    const existingFile = await fs.readFile(filePath, 'utf-8');
    if (existingFile.trim()) {
      existingData = JSON.parse(existingFile);
    }
  } catch (err) {
    // File doesn't exist or is invalid, which is fine
  }
  
  // Create new snapshot object
  const newSnapshot = {
    hour_utc_ms: hourUtcMs,
    ping_ms: pingMs
  };
  
  // Check if this hour already exists and update it
  const existingIndex = existingData.findIndex(item => item.hour_utc_ms === hourUtcMs);
  if (existingIndex >= 0) {
    existingData[existingIndex] = newSnapshot;
  } else {
    existingData.push(newSnapshot);
  }
  
  // Sort by hour_utc_ms ascending
  existingData.sort((a, b) => a.hour_utc_ms - b.hour_utc_ms);
  
  // Write to temp file first
  await fs.writeFile(tempPath, JSON.stringify(existingData));
  
  // Atomically rename to final file
  await fs.rename(tempPath, filePath);
}

function listMonthFiles(serviceId) {
  // This is a simplified implementation - in reality this would walk the directory
  // But for now we'll return a function that creates a placeholder
  return async () => {
    try {
      const files = await fs.readdir(DATA_DIR);
      return files.filter(file => file.startsWith(`${serviceId}-`) && file.endsWith('.json'));
    } catch (err) {
      return [];
    }
  };
}

async function pruneRetention(retentionDays, nowUtcMs) {
  const cutoffMs = nowUtcMs - (retentionDays * 24 * 60 * 60 * 1000);
  
  try {
    const files = await fs.readdir(DATA_DIR);
    
    for (const file of files) {
      // Check if it's a service data file
      if (file.match(/^[a-zA-Z0-9_-]+-\d{4}-\d{2}\.json$/)) {
        const match = file.match(/(\d{4})-(\d{2})/);
        if (match) {
          const year = parseInt(match[1]);
          const month = parseInt(match[2]);
          
          // Create a date at the end of the month
          const endOfMonth = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
          endOfMonth.setUTCMonth(endOfMonth.getUTCMonth() + 1);
          endOfMonth.setUTCDate(0); // Last day of month
          endOfMonth.setUTCHours(23, 59, 59, 999);
          
          // If end of month is before cutoff, delete the file
          if (endOfMonth.getTime() < cutoffMs) {
            const filePath = path.join(DATA_DIR, file);
            await fs.unlink(filePath);
          } else {
            // File intersects with cutoff, so we need to rewrite it
            // Read the file
            const filePath = path.join(DATA_DIR, file);
            const content = await fs.readFile(filePath, 'utf-8');
            let data = [];
            if (content.trim()) {
              try {
                data = JSON.parse(content);
              } catch (err) {
                // Invalid JSON, skip
                continue;
              }
            }
            
            // Filter entries that are beyond cutoff
            const filteredData = data.filter(entry => entry.hour_utc_ms >= cutoffMs);
            
            // If no data, delete the file; if data was filtered and original was not empty, rewrite
            if (filteredData.length === 0) {
              await fs.unlink(filePath);
            } else if (filteredData.length !== data.length) {
              // Rewrite with filtered data
              const tempPath = makeTempPath(filePath);
              await fs.writeFile(tempPath, JSON.stringify(filteredData));
              await fs.rename(tempPath, filePath);
            }
          }
        }
      }
    }
  } catch (err) {
    // Silently fail if we can't clean up retention
    console.error('Error pruning retention:', err);
  }
}

// Read snapshots for specified services within a time range
async function readSnapshots(serviceIds, fromUtcMs, toUtcMs, limit) {
  const result = {};
  const { getMonthKeysBetween } = require('./time');
  const monthKeys = getMonthKeysBetween(fromUtcMs, toUtcMs);
  
  // Read snapshots for each service
  for (const serviceId of serviceIds) {
    result[serviceId] = [];
    
    // Read from each relevant month file
    for (const monthKey of monthKeys) {
      const filePath = path.join(DATA_DIR, `${serviceId}-${monthKey}.json`);
      
      try {
        // Try to read the file
        const fileContent = await fs.readFile(filePath, 'utf-8');
        if (fileContent.trim()) {
          const monthData = JSON.parse(fileContent);
          
          // Filter data within the requested time range
          const filteredData = monthData.filter(entry =>
            entry.hour_utc_ms >= fromUtcMs && entry.hour_utc_ms <= toUtcMs
          );
          
          // Add to result
          result[serviceId] = result[serviceId].concat(filteredData);
        }
      } catch (err) {
        // File doesn't exist or is invalid, which is fine - just continue
        continue;
      }
    }
    
    // Sort by hour_utc_ms ascending
    result[serviceId].sort((a, b) => a.hour_utc_ms - b.hour_utc_ms);
    
    // Apply limit if specified
    if (limit && result[serviceId].length > limit) {
      result[serviceId] = result[serviceId].slice(0, limit);
    }
  }
  
  return result;
}

// Get the latest finalized snapshot for a single service
async function getLatestSnapshot(serviceId, beforeUtcMs = Date.now()) {
  const { getMonthKeysBetween } = require('./time');
  
  // Get the current and previous month keys
  const now = new Date(beforeUtcMs);
  const currentMonthKey = monthKeyFromUtcMs(beforeUtcMs);
  
  // Try to get previous month key
  const prevMonth = new Date(now);
  prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);
  const prevMonthKey = monthKeyFromUtcMs(prevMonth.getTime());
  
  // Try current month first
  const monthKeys = [currentMonthKey];
  if (prevMonthKey !== currentMonthKey) {
    monthKeys.push(prevMonthKey);
  }
  
  // Check each month file in reverse order (most recent first)
  for (const monthKey of monthKeys) {
    const filePath = path.join(DATA_DIR, `${serviceId}-${monthKey}.json`);
    
    try {
      const fileContent = await fs.readFile(filePath, 'utf-8');
      if (fileContent.trim()) {
        const monthData = JSON.parse(fileContent);
        
        // Filter data that is at or before the specified time
        const filteredData = monthData.filter(entry => entry.hour_utc_ms <= beforeUtcMs);
        
        // Sort descending to get the latest entry first
        filteredData.sort((a, b) => b.hour_utc_ms - a.hour_utc_ms);
        
        // Return the latest entry if found
        if (filteredData.length > 0) {
          return filteredData[0];
        }
      }
    } catch (err) {
      // File doesn't exist or is invalid, which is fine - just continue
      continue;
    }
  }
  
  // No snapshots found
  return null;
}

module.exports = {
  writeHourlySnapshot,
  pruneRetention,
  listMonthFiles,
  readSnapshots,
  getLatestSnapshot
};