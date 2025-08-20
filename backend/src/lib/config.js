const fs = require("fs/promises");
const path = require("path");

const CONFIG_PATH = path.resolve(__dirname, "../config/services.json");

async function loadConfig() {
  const raw = await fs.readFile(CONFIG_PATH, "utf-8");
  const cfg = JSON.parse(raw);

  // Apply defaults from architecture spec
  const poll_interval_ms = cfg.poll_interval_ms ?? 60000;
  const retention_days = cfg.retention_days ?? 90;
  const timezone = cfg.timezone ?? "UTC";
  const services = (cfg.services || []).map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    timeout_ms: s.timeout_ms ?? 5000,
    slow_threshold_ms: s.slow_threshold_ms ?? 1000,
    tags: s.tags ?? [],
    retries: s.retries ?? 0
  }));

  return { poll_interval_ms, retention_days, timezone, services };
}

module.exports = { loadConfig, CONFIG_PATH };