const net = require("net");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = 9000;
const HOST = "0.0.0.0";
const LOG_FILE = path.join(__dirname, "messages.log");
// ──────────────────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function log(text) {
  const line = `[${new Date().toISOString()}] ${text}`;
  console.log(line);
  logStream.write(line + "\n");
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

/**
 * ─── CUSTOM PARSER ────────────────────────────────────────────────────────────
 * Replace this function with your own protocol logic.
 *
 * Example protocol (4-byte little-endian length prefix + payload):
 *   [0..3]  uint32LE  payload length
 *   [4..]   bytes     payload
 *
 * Returns an object if a full message is available, or null if more data needed.
 * Also returns how many bytes were consumed so the caller can advance the buffer.
 */
function parseMessage(buffer) {
  // Need at least 4 bytes for the length header
  if (buffer.length < 4) return null;

  const payloadLen = buffer.readUInt32LE(0);
  const totalLen = 4 + payloadLen;

  if (buffer.length < totalLen) return null; // incomplete — wait for more data

  const payload = buffer.slice(4, totalLen);

  return {
    consumed: totalLen,
    message: {
      payloadLength: payloadLen,
      payload,
      payloadHex: payload.toString("hex"),
    },
  };
}
// ──────────────────────────────────────────────────────────────────────────────

const server = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`Client connected: ${clientId}`);

  let accumulator = Buffer.alloc(0); // reassembly buffer

  socket.on("data", (chunk) => {
    log(`Received ${chunk.length} bytes from ${clientId}`);
    log(`Hex dump:\n${hexDump(chunk)}`);

    // Append chunk to the reassembly buffer
    accumulator = Buffer.concat([accumulator, chunk]);

    // Try to parse as many complete messages as possible
    let result;
    while ((result = parseMessage(accumulator)) !== null) {
      const { consumed, message } = result;
      log(`Parsed message from ${clientId}: ${JSON.stringify(message)}`);
      accumulator = accumulator.slice(consumed); // advance past consumed bytes
    }

    if (accumulator.length > 0) {
      log(`Buffering ${accumulator.length} incomplete bytes from ${clientId}`);
    }
  });

  socket.on("end", () => {
    log(`Client disconnected: ${clientId}`);
    if (accumulator.length > 0) {
      log(
        `WARNING: ${accumulator.length} unprocessed bytes left from ${clientId}`,
      );
    }
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
  log(`Logging messages to: ${LOG_FILE}`);
});
