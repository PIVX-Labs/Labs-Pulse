// Poller that performs periodic HTTP(S) checks, measuring latency and success/failure.
const https = require('https');
const http = require('http');
const { hourBucketUtcMs } = require('./time');

function createHttpAgent() {
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  return { httpAgent, httpsAgent };
}

const { httpAgent, httpsAgent } = createHttpAgent();

function startPoller(config, accumulator) {
  let intervalId;
  
  function performPoll() {
    const nowMs = Date.now();
    
    // Process each service
    for (const service of config.services) {
      let attempt = 0;
      
      // Retry logic
      const runAttempt = () => {
        attempt++;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), service.timeout_ms);
        
        const startTime = Date.now();
        
        const protocol = service.url.startsWith('https') ? https : http;
        const agent = service.url.startsWith('https') ? httpsAgent : httpAgent;
        
        const options = {
          method: 'GET',
          timeout: service.timeout_ms,
          agent: agent,
          signal: controller.signal
        };
        
        const req = protocol.request(service.url, options, (res) => {
          clearTimeout(timeoutId);
          
          // Collect response data to ensure we get the 'end' event
          res.on('data', () => {}); // Consume data
          
          res.on('end', () => {
            const latency = Date.now() - startTime;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              // Success
              accumulator.recordSample(service.id, nowMs, true, latency);
            } else {
              // Non-success status code
              accumulator.recordSample(service.id, nowMs, false, null);
            }
          });
        });
        
        req.on('error', (err) => {
          clearTimeout(timeoutId);
          accumulator.recordSample(service.id, nowMs, false, null);
          if (attempt <= service.retries && attempt <= 3) { // Limit retries to prevent infinite loops
            setTimeout(runAttempt, 100);
          }
        });
        
        req.on('timeout', () => {
          req.destroy();
          clearTimeout(timeoutId);
          accumulator.recordSample(service.id, nowMs, false, null);
          if (attempt <= service.retries && attempt <= 3) { // Limit retries to prevent infinite loops
            setTimeout(runAttempt, 100);
          }
        });
        
        req.end();
      };
      
      // Start first attempt
      runAttempt();
    }
  }
  
  // Run immediately and then at intervals
  performPoll();
  intervalId = setInterval(performPoll, config.poll_interval_ms);
  
  // Return stop function
  return function stop() {
    clearInterval(intervalId);
  };
}

module.exports = {
  startPoller
};