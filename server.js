const net = require("net");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = 9000;
const HOST = "0.0.0.0";
// ──────────────────────────────────────────────────────────────────────────────

function log(text) {
  console.log(`[${new Date().toISOString()}] ${text}`);
}

/**
 * Format a Buffer as a hex dump:
 *   00000000  48 65 6c 6c 6f  Hello
 */
function hexDump(buffer) {
  const COLS = 16;
  let out = "";
  for (let offset = 0; offset < buffer.length; offset += COLS) {
    const slice = buffer.slice(offset, offset + COLS);

    const offsetStr = offset.toString(16).padStart(8, "0");
    const hexPart = [...slice]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(COLS * 3 - 1, " ");
    const asciiPart = [...slice]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");

    out += `  ${offsetStr}  ${hexPart}  ${asciiPart}\n`;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────

const server = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`Client connected: ${clientId}`);

  socket.on("data", (chunk) => {
    log(`Received ${chunk.length} bytes from ${clientId}`);
    log(`Raw data: ${chunk.toString()}`);
    log(`Hex dump:\n${hexDump(chunk)}`);
  });

  socket.on("end", () => {
    log(`Client disconnected: ${clientId}`);
  });

  socket.on("error", (err) => {
    log(`Socket error from ${clientId}: ${err.message}`);
  });
});

server.on("error", (err) => {
  log(`Server error: ${err.message}`);
});

server.listen(PORT, HOST, () => {
  log(`TCP server listening on ${HOST}:${PORT}`);
});
