const express = require("express");
const path = require("path");
const routes = require("./routes");

async function startServer({ port, config }) {
  const app = express();
  app.use(express.json());

  // Expose config to routes via app.locals
  app.locals.config = config;

  // API routes
  app.use("/api", routes);

  // Serve static frontend
  const frontendPath = path.resolve(__dirname, "../../../frontend");
  app.use(express.static(frontendPath));

  return new Promise((resolve) => {
    app.listen(port, () => {
      console.log(`Labs Pulse server listening on http://localhost:${port}`);
      resolve();
    });
  });
}

module.exports = { startServer };