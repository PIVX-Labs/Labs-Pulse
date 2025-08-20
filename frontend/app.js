async function fetchJson(url) {
  // Force fresh network fetch to avoid 304 Not Modified confusing the UI
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// Derive bucket size by inspecting deltas in hour_utc_ms.
// Fallback to hourly. If we detect minute buckets (<= 70s), switch to minute.
function inferBucketSizeFromSnapshots(snapshots) {
  if (!snapshots || snapshots.length < 3) return 3600000;
  const deltas = [];
  for (let i = 1; i < snapshots.length; i++) {
    deltas.push(snapshots[i].hour_utc_ms - snapshots[i - 1].hour_utc_ms);
  }
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const medianDelta =
    deltas.length % 2 === 1
      ? deltas[mid]
      : Math.round((deltas[mid - 1] + deltas[mid]) / 2);
  return medianDelta <= 70000 ? 60000 : 3600000;
}

function computeWindow(nowMs, bucketMs, len) {
  const currentBucketStart = Math.floor(nowMs / bucketMs) * bucketMs;
  const endBucketStart = currentBucketStart - bucketMs; // last completed
  const startBucketStart = endBucketStart - (len - 1) * bucketMs;
  return { from: startBucketStart, to: endBucketStart };
}

// Calculate how many cells can fit in the timeline container
function calculateFittingCells() {
  // Get the timeline container width
  const container = document.querySelector('.timeline');
  if (!container) {
    // If no container exists yet, use a default reasonable value
    return 50; // fallback value - more conservative
  }
  
  // Get computed styles
  const computedStyle = getComputedStyle(container);
  const containerWidth = container.clientWidth - 
    parseFloat(computedStyle.paddingLeft) - 
    parseFloat(computedStyle.paddingRight);
  
  // Estimate cell width (including gap)
  // We'll use a reasonable estimate since we can't measure exact cell size before rendering
  const estimatedCellWidth = 8; // minimum cell width with gap
  const maxCells = Math.floor(containerWidth / estimatedCellWidth);
  
  // Set reasonable bounds - respect backend limit of 168 hours
  return Math.max(12, Math.min(maxCells, 168)); // between 12 and 168 cells
}

// Format date for tooltip display
function formatTooltipDate(ms) {
  const date = new Date(ms);
  return date.toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Prefer backend-provided bucket size to avoid initial window mismatches.
// Returns number (ms) or null on failure.
async function fetchBucketSize() {
  try {
    const res = await fetch('/api/ping', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.bucket_size_ms === 'number' && data.bucket_size_ms > 0) {
      return data.bucket_size_ms;
    }
    return null;
  } catch {
    return null;
  }
}

function buildCells(services, snapshotsByService, bucketMs, len, thresholdsByService, isLoading = false) {
  const now = Date.now();
  const { from, to } = computeWindow(now, bucketMs, len);

  // Pre-build the sequence of bucket timestamps oldest -> newest
  const buckets = new Array(len);
  let t = from;
  for (let i = 0; i < len; i++, t += bucketMs) buckets[i] = t;

  return services.map((s) => {
    const threshold = thresholdsByService.get(s.id) ?? 1000;
    const snaps = snapshotsByService.get(s.id) || [];
    const byHour = new Map(snaps.map((sn) => [sn.hour_utc_ms, sn.ping_ms]));

    const cells = buckets.map((h) => {
      const ping = byHour.has(h) ? byHour.get(h) : 0; // treat missing as down
      let cls = "loading"; // default to loading state
      let title = `${new Date(h).toISOString()} • No data`;
      
      // Only apply color logic if not in loading state
      if (!isLoading) {
        if (ping > 0 && ping <= threshold) {
          cls = "green";
        } else if (ping > threshold) {
          cls = "yellow";
        } else {
          cls = "red";
        }
        title = `${new Date(h).toISOString()} • ${ping} ms`;
      }
      
      return { hour: h, ping_ms: ping, cls, title };
    });

    return { service: s, cells };
  });
}

// Show custom tooltip
function showTooltip(event, cellData) {
  let tooltip = document.getElementById('custom-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'custom-tooltip';
    tooltip.className = 'custom-tooltip';
    document.body.appendChild(tooltip);
  }
  
  // Format the date nicely
  const dateStr = formatTooltipDate(cellData.hour);
  const pingStr = cellData.ping_ms > 0 ? `${cellData.ping_ms} ms` : 'No data (down)';
  
  tooltip.innerHTML = `
    <div class="tooltip-date">${dateStr}</div>
    <div class="tooltip-ping">${pingStr}</div>
  `;
  
  // Position tooltip near cursor
  tooltip.style.left = (event.pageX + 10) + 'px';
  tooltip.style.top = (event.pageY + 10) + 'px';
  tooltip.style.display = 'block';
}

// Hide tooltip
function hideTooltip() {
  const tooltip = document.getElementById('custom-tooltip');
  if (tooltip) {
    tooltip.style.display = 'none';
  }
}

function render(services, rows) {
  const container = document.getElementById("services");
  container.innerHTML = "";

  // Friendly titles for known tags
  const TAG_TITLES = { web: "Web", infra: "Infrastructure" };
  const getPrimaryTag = (s) =>
    s && s.tags && s.tags.length ? s.tags[0] : "Other";
  const tagLabel = (t) =>
    TAG_TITLES[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Other");

  // Group rows by primary tag, preserving original order of first appearance
  const groupMap = new Map();
  const order = [];
  rows.forEach((row) => {
    const tag = getPrimaryTag(row.service);
    if (!groupMap.has(tag)) {
      groupMap.set(tag, []);
      order.push(tag);
    }
    groupMap.get(tag).push(row);
  });

  // Render each tag group with a header
  order.forEach((tag) => {
    const section = document.createElement("section");
    section.className = "tag-group";

    const header = document.createElement("h2");
    header.className = "tag-header";
    header.textContent = tagLabel(tag);
    section.appendChild(header);

    groupMap.get(tag).forEach((row) => {
      const wrap = document.createElement("div");
      wrap.className = "service-row";

      const name = document.createElement("div");
      name.className = "service-name";
      name.textContent = row.service.name;

      const timeline = document.createElement("div");
      timeline.className = "timeline";

      row.cells.forEach((c) => {
        const cell = document.createElement("div");
        cell.className = `hour-cell ${c.cls}`;

        // Custom tooltip
        cell.addEventListener("mouseover", (e) => showTooltip(e, c));
        cell.addEventListener("mousemove", (e) => {
          const tooltip = document.getElementById("custom-tooltip");
          if (tooltip) {
            tooltip.style.left = e.pageX + 10 + "px";
            tooltip.style.top = e.pageY + 10 + "px";
          }
        });
        cell.addEventListener("mouseout", hideTooltip);

        timeline.appendChild(cell);
      });

      wrap.appendChild(name);
      wrap.appendChild(timeline);
      section.appendChild(wrap);
    });

    container.appendChild(section);
  });
}

async function loadSnapshotsForServices(services, bucketMs, len) {
  const now = Date.now();
  const { from, to } = computeWindow(now, bucketMs, len);

  // Build query per service
  const ids = services.map((s) => s.id).join(",");
  const limit = Math.min(len, 168); // extra guard
  const url = `/api/snapshots?service_id=${encodeURIComponent(ids)}&from_utc_ms=${from}&to_utc_ms=${to}&limit=${limit}`;

  try {
    const result = await fetchJson(url);
    
    // The API returns either {service_id, snapshots} or {results:[...]} depending on multiplicity.
    const map = new Map();
    if (result.results && Array.isArray(result.results)) {
      result.results.forEach((r) => {
        const snapshots = r.snapshots || [];
        map.set(r.service_id, snapshots);
      });
    } else if (result.service_id) {
      const snapshots = result.snapshots || [];
      map.set(result.service_id, snapshots);
    }

    // If no service returned any snapshots, signal "no update yet"
    const hasAnyData = Array.from(map.values()).some(arr => Array.isArray(arr) && arr.length > 0);
    return hasAnyData ? map : null;
  } catch (error) {
    console.error("Failed to load snapshots:", error);
    // Signal no update on error so we keep the current UI (loading or last good)
    return null;
  }
}

async function detectBucketMs(services) {
  // Try with one service to infer bucket spacing
  if (!services.length) return 3600000;
  const probeId = services[0].id;
  const now = Date.now();

  // Probe around "now" using a small minute-scale window to catch minute mode,
  // while still compatible with hourly data. This avoids using an older hourly
  // boundary as "to", which would exclude fresh minute snapshots.
  const MINUTE = 60000;
  const to = Math.floor(now / MINUTE) * MINUTE - MINUTE; // last completed minute
  const from = to - (200 - 1) * MINUTE; // 200 buckets inclusive
  const url = `/api/snapshots?service_id=${encodeURIComponent(probeId)}&from_utc_ms=${from}&to_utc_ms=${to}&limit=200`;

  try {
    const data = await fetchJson(url);
    const snaps = data.snapshots || [];
    return inferBucketSizeFromSnapshots(snaps);
  } catch (error) {
    console.error("Failed to detect bucket size:", error);
    return 3600000;
  }
}

async function main() {
  try {
    const servicesResp = await fetchJson("/api/services");
    const services = servicesResp.services || [];

    // Map thresholds for color logic
    const thresholdsByService = new Map();
    services.forEach((s) =>
      thresholdsByService.set(s.id, s.slow_threshold_ms || 1000)
    );

    // Detect bucket size: prefer backend hint, fall back to inference
    let bucketMs = await fetchBucketSize();
    if (!bucketMs) {
      bucketMs = await detectBucketMs(services);
    }
    
    // Calculate how many cells can fit on screen
    // We need to render at least once to get the container dimensions
    const initialFittingCells = calculateFittingCells();
    const initialHalf = Math.max(12, Math.floor(initialFittingCells / 2));
    const WINDOW_LEN = bucketMs === 60000 ? Math.min(180, initialHalf) : Math.min(168, initialHalf);

    // Initial render as skeleton with loading state
    const skeletonRows = buildCells(
      services,
      new Map(),
      bucketMs,
      WINDOW_LEN,
      thresholdsByService,
      true // indicate loading state
    );
    render(services, skeletonRows);

    let refreshing = false;

    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        // Recalculate fitting cells each time to adapt to window resizes
        const fittingCells = calculateFittingCells();
        const fittingHalf = Math.max(12, Math.floor(fittingCells / 2));
        const actualWindowLen = bucketMs === 60000 ? Math.min(180, fittingHalf) : Math.min(168, fittingHalf);
        
        const snapshotsByService = await loadSnapshotsForServices(
          services,
          bucketMs,
          actualWindowLen
        );

        // If we didn't get any data (error or empty), keep the current UI (loading or last good)
        if (!snapshotsByService) return;

        // Re-check if bucket mode changed based on returned data (rare)
        const firstId = services[0] ? services[0].id : null;
        if (firstId) {
          // Get snaps for the first service to check bucket size
          const snaps = snapshotsByService.get(firstId) || [];
          const inferred = inferBucketSizeFromSnapshots(snaps);
          if (inferred !== bucketMs) {
            bucketMs = inferred;
          }
        }

        const rows = buildCells(
          services,
          snapshotsByService,
          bucketMs,
          actualWindowLen,
          thresholdsByService,
          false // not loading
        );
        render(services, rows);
      } catch (e) {
        console.error("Refresh failed:", e);
        // Keep previous render; next tick may recover
      } finally {
        refreshing = false;
      }
    }

    // First refresh after a short delay to allow initial render
    setTimeout(() => {
      refresh().catch(console.error);
    }, 100);

    const interval = bucketMs === 60000 ? 60000 : 300000; // 1m or 5m
    setInterval(refresh, interval);
    
    // Also refresh on window resize
    window.addEventListener('resize', () => {
      // Debounce resize events
      clearTimeout(window.resizeTimer);
      window.resizeTimer = setTimeout(refresh, 250);
    });
  } catch (e) {
    console.error("Failed to initialize UI", e);
    const container = document.getElementById("services");
    if (container) container.textContent = "Failed to initialize UI.";
  }
}

main().catch((e) => {
  console.error("Failed to start application", e);
});