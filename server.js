/**
 * HelmetAI - Dual Server
 * ======================
 * HTTP  on port 5173 -> for localhost (camera works, no HTTPS needed)
 * HTTPS on port 5443 -> for other devices on the same WiFi
 *
 * Run: node server.js
 */

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");

const HTTP_PORT  = 5173;
const HTTPS_PORT = 5443;
const DIR        = __dirname;
const PFX        = path.join(DIR, ".ssl-cert.pfx");
const PFX_PASS   = "helmetai123";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

function serveFile(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
  const filePath = path.resolve(path.join(DIR, urlPath));
  if (!filePath.startsWith(DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found: " + urlPath);
      return;
    }
    const mime = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
}

function getLocalIPs() {
  const ips = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

// --- Start HTTP server (localhost only, camera works) ---
const httpServer = http.createServer(serveFile);
httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log("");
  console.log("  HelmetAI Servers Running!");
  console.log("  ==========================");
  console.log("");
  console.log("  [HTTP]  This computer only:");
  console.log("          http://localhost:" + HTTP_PORT);
  console.log("          http://127.0.0.1:" + HTTP_PORT);
  console.log("          Camera works here (localhost is exempt from HTTPS)");
});
httpServer.on("error", err => {
  console.error("[HTTP] Error:", err.message);
});

// --- Start HTTPS server (all network interfaces, for other devices) ---
if (fs.existsSync(PFX)) {
  try {
    const pfx = fs.readFileSync(PFX);
    const httpsServer = https.createServer({ pfx, passphrase: PFX_PASS }, serveFile);
    httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
      const ips = getLocalIPs();
      console.log("");
      console.log("  [HTTPS] Other devices on the same WiFi:");
      ips.forEach(ip => {
        console.log("          https://" + ip + ":" + HTTPS_PORT);
      });
      console.log("");
      console.log("  On other devices:");
      console.log("  1. Open the https:// link above in Chrome/Safari");
      console.log("  2. Click 'Advanced' -> 'Proceed to site'");
      console.log("  3. Allow camera permission");
      console.log("");
      console.log("  Press Ctrl+C to stop.");
      console.log("");
    });
    httpsServer.on("error", err => {
      console.error("[HTTPS] Error:", err.message);
    });
  } catch (e) {
    console.log("  [HTTPS] Could not start: " + e.message);
    console.log("  Run gencert.ps1 to regenerate certificate.");
  }
} else {
  console.log("");
  console.log("  [HTTPS] No certificate found. Run gencert.ps1 to enable cross-device access.");
}
