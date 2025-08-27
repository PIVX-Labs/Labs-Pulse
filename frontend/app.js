async function fetchJson(url) {
  // Force fresh network fetch to avoid 304 Not Modified confusing the UI
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
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

    // Determine the latest status for the service card
    const latestCell = cells[cells.length - 1];
    let cardStatus = 'loading';
    if (!isLoading && latestCell) {
      cardStatus = latestCell.cls;
    }

    return { service: s, cells, cardStatus };
  });
}

// Show custom tooltip for timeline cells
function showTooltip(event, cellData) {
  // On mobile, hide any existing service tooltip first
  const isMobile = window.innerWidth <= 640;
  if (isMobile) {
    hideServiceTooltip();
  }

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
  
  if (isMobile) {
    // Center tooltip on mobile using viewport positioning
    tooltip.style.left = '50vw';
    tooltip.style.top = (event.pageY + 15) + 'px';
    tooltip.style.transform = 'translateX(-50%)';
    tooltip.style.position = 'fixed';
    tooltip.style.zIndex = '2000';
  } else {
    // Normal desktop positioning
    tooltip.style.left = (event.pageX + 10) + 'px';
    tooltip.style.top = (event.pageY + 10) + 'px';
    tooltip.style.transform = 'none';
    tooltip.style.position = 'absolute';
    tooltip.style.zIndex = '1000';
  }
  
  tooltip.style.display = 'block';
}

// Hide tooltip for timeline cells
function hideTooltip() {
  const tooltip = document.getElementById('custom-tooltip');
  if (tooltip) {
    tooltip.style.display = 'none';
  }
}

// Show service card tooltip
function showServiceTooltip(event, service, latestPing, status) {
  const tooltip = document.getElementById('serviceTooltip');
  if (!tooltip) return;

  // On mobile, hide any existing timeline tooltip first
  const isMobile = window.innerWidth <= 640;
  if (isMobile) {
    hideTooltip();
  }

  let statusText = status === 'green' ? 'Healthy' : status === 'yellow' ? 'Slow' : status === 'red' ? 'Down' : 'Loading...';
  let responseText = '';
  
  if (status === 'red' || latestPing === 0) {
    responseText = 'Service unreachable';
  } else if (latestPing > 0) {
    responseText = `${latestPing}ms response time`;
  } else {
    responseText = 'Checking...';
  }

  const lastChecked = new Date().toLocaleTimeString();
  
  tooltip.innerHTML = `
    <div class="tooltip-service-name">${service.name}</div>
    <div class="tooltip-status">Status: ${statusText}</div>
    <div class="tooltip-response-time">${responseText}</div>
    <div class="tooltip-last-check">Last checked: ${lastChecked}</div>
  `;
  
  if (isMobile) {
    // Center tooltip on mobile using viewport positioning
    tooltip.style.left = '50vw';
    tooltip.style.top = (event.pageY + 15) + 'px';
    tooltip.style.transform = 'translateX(-50%)';
    tooltip.style.position = 'fixed';
    tooltip.style.zIndex = '1500';
  } else {
    // Normal desktop positioning
    tooltip.style.left = (event.pageX + 10) + 'px';
    tooltip.style.top = (event.pageY + 10) + 'px';
    tooltip.style.transform = 'none';
    tooltip.style.position = 'absolute';
    tooltip.style.zIndex = '1001';
  }
  
  tooltip.style.display = 'block';
}

// Hide service card tooltip
function hideServiceTooltip() {
  const tooltip = document.getElementById('serviceTooltip');
  if (tooltip) {
    tooltip.style.display = 'none';
  }
}

// Update stats in header
function updateStats(services, rows) {
  // Update last checked
  const now = new Date();
  const timeString = now.toLocaleTimeString();
  const lastCheckedElement = document.getElementById('lastChecked');
  if (lastCheckedElement) {
    lastCheckedElement.textContent = timeString;
  }

  // Count incidents (down services)
  let incidents = 0;
  rows.forEach(row => {
    if (row.cardStatus === 'red') {
      incidents++;
    }
  });
  
  const incidentsElement = document.getElementById('incidents');
  if (incidentsElement) {
    incidentsElement.textContent = incidents;
  }
}

function render(services, rows) {
  const container = document.getElementById("services");
  container.innerHTML = "";

  // Update stats
  updateStats(services, rows);

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

    const servicesContainer = document.createElement("div");
    servicesContainer.className = "tag-services";

    groupMap.get(tag).forEach((row) => {
      const serviceItem = document.createElement("div");
      serviceItem.className = "service-item";

      // Service card with status indicator
      const serviceCard = document.createElement("div");
      serviceCard.className = `service-card ${row.cardStatus}`;

      const name = document.createElement("div");
      name.className = "service-name";
      name.textContent = row.service.name;

      // Timeline inside the service card
      const timeline = document.createElement("div");
      timeline.className = "timeline";

      row.cells.forEach((c) => {
        const cell = document.createElement("div");
        cell.className = `hour-cell ${c.cls}`;

        // Custom tooltip for timeline cells
        cell.addEventListener("mouseover", (e) => {
          e.stopPropagation(); // Prevent service card tooltip from showing
          hideServiceTooltip(); // Hide service tooltip if it's showing
          showTooltip(e, c);
        });
        cell.addEventListener("click", (e) => {
          e.stopPropagation(); // Prevent service card tooltip from showing
          hideServiceTooltip(); // Hide service tooltip if it's showing
          showTooltip(e, c);
        });
        cell.addEventListener("touchstart", (e) => {
          e.stopPropagation(); // Prevent service card tooltip from showing
          hideServiceTooltip(); // Hide service tooltip if it's showing
          showTooltip(e, c);
        });
        cell.addEventListener("mousemove", (e) => {
          e.stopPropagation(); // Prevent service card tooltip positioning
          const tooltip = document.getElementById("custom-tooltip");
          if (tooltip && tooltip.style.display === 'block') {
            const isMobile = window.innerWidth <= 640;
            if (!isMobile) {
              // Only update position on desktop
              tooltip.style.left = e.pageX + 10 + "px";
              tooltip.style.top = e.pageY + 10 + "px";
            }
          }
        });
        cell.addEventListener("mouseout", (e) => {
          hideTooltip();
        });

        timeline.appendChild(cell);
      });

      serviceCard.appendChild(name);
      serviceCard.appendChild(timeline);

      // Add service card tooltip
      serviceCard.addEventListener("mouseenter", (e) => {
        const latestCell = row.cells[row.cells.length - 1];
        const latestPing = latestCell ? latestCell.ping_ms : 0;
        showServiceTooltip(e, row.service, latestPing, row.cardStatus);
      });
      
      serviceCard.addEventListener("click", (e) => {
        // Only show tooltip if clicking on service card but not on timeline cells
        if (!e.target.classList.contains('hour-cell')) {
          const latestCell = row.cells[row.cells.length - 1];
          const latestPing = latestCell ? latestCell.ping_ms : 0;
          hideTooltip(); // Hide timeline tooltip if showing
          showServiceTooltip(e, row.service, latestPing, row.cardStatus);
        }
      });
      
      serviceCard.addEventListener("touchstart", (e) => {
        // Only show tooltip if touching service card but not timeline cells
        if (!e.target.classList.contains('hour-cell')) {
          const latestCell = row.cells[row.cells.length - 1];
          const latestPing = latestCell ? latestCell.ping_ms : 0;
          hideTooltip(); // Hide timeline tooltip if showing
          showServiceTooltip(e, row.service, latestPing, row.cardStatus);
        }
      });
      
      serviceCard.addEventListener("mousemove", (e) => {
        const tooltip = document.getElementById('serviceTooltip');
        if (tooltip && tooltip.style.display === 'block') {
          const isMobile = window.innerWidth <= 640;
          if (!isMobile) {
            // Only update position on desktop
            tooltip.style.left = (e.pageX + 10) + 'px';
            tooltip.style.top = (e.pageY + 10) + 'px';
          }
        }
      });
      
      serviceCard.addEventListener("mouseleave", hideServiceTooltip);

      serviceItem.appendChild(serviceCard);
      servicesContainer.appendChild(serviceItem);
    });

    section.appendChild(servicesContainer);
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

async function main() {
  try {
    const servicesResp = await fetchJson("/api/services");
    const services = servicesResp.services || [];

    // Map thresholds for color logic
    const thresholdsByService = new Map();
    services.forEach((s) =>
      thresholdsByService.set(s.id, s.slow_threshold_ms || 1000)
    );

    // Detect bucket size from backend; fallback to hourly (3600000) if unavailable
    let bucketMs = await fetchBucketSize();
    if (!bucketMs) {
      bucketMs = 3600000;
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

    // Update last checked time every 30 seconds
    setInterval(() => {
      const lastCheckedElement = document.getElementById('lastChecked');
      if (lastCheckedElement) {
        const now = new Date();
        const timeString = now.toLocaleTimeString();
        lastCheckedElement.textContent = timeString;
      }
    }, 30000);

    // Add global click handler to hide tooltips on mobile
    document.addEventListener('click', (e) => {
      const isMobile = window.innerWidth <= 640;
      if (isMobile) {
        // Check if click is outside service cards and timeline cells
        const isServiceCard = e.target.closest('.service-card');
        const isTimelineCell = e.target.classList.contains('hour-cell');
        
        if (!isServiceCard && !isTimelineCell) {
          hideTooltip();
          hideServiceTooltip();
        }
      }
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