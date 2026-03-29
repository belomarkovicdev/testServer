const net = require("net");
const https = require("https");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 9000;
const HOST = "0.0.0.0";
const API_HOST = "jbtracker.onrender.com";
const API_PATH = "/location";
// ──────────────────────────────────────────────────────────────────────────────

function log(text) {
  console.log(`[${new Date().toISOString()}] ${text}`);
}

// ─── JT/T 808 Protocol Helpers ───────────────────────────────────────────────

// Unescape: 7D 02 -> 7E, 7D 01 -> 7D
function unescape808(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d && i + 1 < buf.length) {
      if (buf[i + 1] === 0x02) { out.push(0x7e); i++; }
      else if (buf[i + 1] === 0x01) { out.push(0x7d); i++; }
      else out.push(buf[i]);
    } else {
      out.push(buf[i]);
    }
  }
  return Buffer.from(out);
}

// Escape: 7E -> 7D 02, 7D -> 7D 01
function escape808(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7e) { out.push(0x7d, 0x02); }
    else if (buf[i] === 0x7d) { out.push(0x7d, 0x01); }
    else out.push(buf[i]);
  }
  return Buffer.from(out);
}

function calcChecksum(buf) {
  let cs = 0;
  for (let i = 0; i < buf.length; i++) cs ^= buf[i];
  return cs;
}

// Build a JT/T 808 response frame
function buildResponse(msgId, phoneBytes, serialNum, bodyBuf) {
  // Header: msgId(2) + bodyLen(2) + phone(6) + serial(2)
  const header = Buffer.alloc(12);
  header.writeUInt16BE(msgId, 0);
  header.writeUInt16BE(bodyBuf.length, 2);
  phoneBytes.copy(header, 4);
  header.writeUInt16BE(serialNum, 10);
  const payload = Buffer.concat([header, bodyBuf]);
  const cs = calcChecksum(payload);
  const escaped = escape808(Buffer.concat([payload, Buffer.from([cs])]));
  return Buffer.concat([Buffer.from([0x7e]), escaped, Buffer.from([0x7e])]);
}

// Universal acknowledgment (0x8001)
function buildAck(phoneBytes, serialNum, ackSerial, ackMsgId, result) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(ackSerial, 0);
  body.writeUInt16BE(ackMsgId, 2);
  body.writeUInt8(result, 4); // 0 = success
  return buildResponse(0x8001, phoneBytes, serialNum, body);
}

// Registration acknowledgment (0x8100)
function buildRegisterAck(phoneBytes, serialNum, ackSerial, result, authCode) {
  const authBuf = Buffer.from(authCode, "ascii");
  const body = Buffer.alloc(3 + authBuf.length);
  body.writeUInt16BE(ackSerial, 0);
  body.writeUInt8(result, 2); // 0 = success
  authBuf.copy(body, 3);
  return buildResponse(0x8100, phoneBytes, serialNum, body);
}

// Parse extra information items (TLV) from location body
function parseExtras(body) {
  const extras = {};
  let offset = 28; // extras start after the 28-byte base location
  while (offset < body.length) {
    const id = body.readUInt8(offset);
    offset++;
    if (offset >= body.length) break;
    const len = body.readUInt8(offset);
    offset++;
    if (offset + len > body.length) break;
    const val = body.slice(offset, offset + len);
    extras[id] = val;
    offset += len;
  }
  return extras;
}

// Parse LBS (cell tower) info from extra item 0xE1
function parseLBS(buf) {
  if (buf.length < 4) return null;
  log(`LBS full hex (${buf.length} bytes): ${buf.toString("hex")}`);
  
  const mcc = buf.readUInt16BE(0);
  const mnc = buf.readUInt8(2);
  // byte 3 might be count or part of first tower
  const possibleCount = buf.readUInt8(3);
  const towers = [];
  
  // The data after MCC(2)+MNC(1) is 33 bytes
  // Try: count(1) + towers with LAC(2)+CellID(2)+signal(1)+extra(1) = 6 bytes each
  // 33-1 = 32, 32/8 = 4 towers with 8 bytes each
  // Or 32/4 = 8 towers... 
  // Let's just dump each byte position to figure out the pattern
  log(`LBS after header: ${buf.slice(3).toString("hex")}`);
  
  // Try format: after MCC(2) MNC(1), no count, just raw tower data
  // Each tower: LAC(2) CellID(2) signal(1) = 5 bytes? 33/5 = 6.6 no
  // Each tower: LAC(2) CellID(4) signal(1) = 7 bytes? 33/7 = 4.7 no
  
  // Let me try: byte3=count, then LAC(4) CellID(2) signal(1) rssi(1) = 8 bytes
  // count=0? no. What if MNC is 2 bytes?
  // MCC(2) MNC(2) = 00DC 0003, remaining = 32 bytes
  // 32/8 = 4 towers exactly!
  
  const mcc2 = buf.readUInt16BE(0);
  const mnc2 = buf.readUInt16BE(2);
  let offset = 4;
  const remaining = buf.length - 4;
  
  // Try 8 bytes per tower: LAC(2) CellID(3) signal(1) + 2 unknown
  // 32/8 = 4 towers
  log(`Trying MCC=${mcc2} MNC=${mnc2}, remaining=${remaining} bytes`);
  
  while (offset + 8 <= buf.length) {
    const b = buf.slice(offset, offset + 8);
    log(`Tower block: ${b.toString("hex")}`);
    offset += 8;
  }
  if (offset < buf.length) {
    log(`Leftover: ${buf.slice(offset).toString("hex")}`);
  }
  
  return towers;
}

// Lookup cell tower location using unwiredlabs or similar free API
function lookupCellLocation(towers, callback) {
  // Use Google-compatible cell tower format for opencellid/unwiredlabs
  // For now, log the tower info — you can plug in an API key later
  if (!towers || towers.length === 0) return callback(null);
  const main = towers[0];
  log(`Main tower: MCC=${main.mcc} MNC=${main.mnc} LAC=${main.lac} CellID=${main.cellId}`);
  callback(null); // placeholder — needs geolocation API
}

// Parse location message (0x0200)
function parseLocation(body) {
  if (body.length < 28) return null;
  const alarm = body.readUInt32BE(0);
  const status = body.readUInt32BE(4);
  const rawLat = body.readUInt32BE(8);
  const rawLng = body.readUInt32BE(12);
  const lat = rawLat / 1e6;
  const lng = rawLng / 1e6;
  log(`Raw lat=${rawLat} (0x${rawLat.toString(16)}), raw lng=${rawLng} (0x${rawLng.toString(16)})`);
  const altitude = body.readUInt16BE(16);
  const speed = body.readUInt16BE(18) / 10;
  const direction = body.readUInt16BE(20);
  // BCD timestamp: YY MM DD HH MM SS
  const ts = body.slice(22, 28);
  const time = `20${ts[0].toString(16).padStart(2,"0")}-${ts[1].toString(16).padStart(2,"0")}-${ts[2].toString(16).padStart(2,"0")} ${ts[3].toString(16).padStart(2,"0")}:${ts[4].toString(16).padStart(2,"0")}:${ts[5].toString(16).padStart(2,"0")}`;

  // Parse extra TLV items
  const extras = parseExtras(body);
  log(`Extra IDs: ${Object.keys(extras).map(k => '0x' + Number(k).toString(16)).join(', ')}`);

  // Parse LBS cell tower data if present
  let towers = null;
  if (extras[0xe1]) {
    towers = parseLBS(extras[0xe1]);
  }

  return { lat, lng, altitude, speed, direction, time, alarm, status, towers };
}

// Extract frames from raw data (split by 7E markers)
function extractFrames(data) {
  const frames = [];
  let start = -1;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x7e) {
      if (start >= 0 && i > start + 1) {
        frames.push(data.slice(start + 1, i));
      }
      start = i;
    }
  }
  return frames;
}

// ─── Forward location to API ─────────────────────────────────────────────────
function forwardLocation(deviceId, location) {
  const payload = JSON.stringify({ deviceId, ...location });
  log(`Forwarding location: ${payload}`);

  const req = https.request({
    hostname: API_HOST,
    path: API_PATH,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  }, (res) => {
    log(`API responded: ${res.statusCode}`);
  });
  req.on("error", (err) => log(`API error: ${err.message}`));
  req.write(payload);
  req.end();
}

// ─── TCP Server ──────────────────────────────────────────────────────────────
let serverSerial = 0;

const server = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`Client connected: ${clientId}`);

  socket.on("data", (chunk) => {
    // Respond to HTTP health checks from Railway
    if (chunk.toString("ascii", 0, 4) === "GET ") {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
      socket.end();
      return;
    }

    log(`Received ${chunk.length} bytes from ${clientId}`);
    log(`Raw hex: ${chunk.toString("hex")}`);

    const frames = extractFrames(chunk);
    for (const raw of frames) {
      const frame = unescape808(raw);
      if (frame.length < 12) continue;

      const msgId = frame.readUInt16BE(0);
      const bodyLen = frame.readUInt16BE(2) & 0x03ff;
      const phone = frame.slice(4, 10);
      const serial = frame.readUInt16BE(10);
      const body = frame.slice(12, 12 + bodyLen);
      const deviceId = phone.toString("hex").replace(/^0+/, "");

      log(`Message 0x${msgId.toString(16).padStart(4,"0")} from ${deviceId}, serial=${serial}, bodyLen=${bodyLen}`);
      log(`Unescaped frame hex: ${frame.toString("hex")}`);

      if (msgId === 0x0100) {
        // Terminal Registration -> send registration ack
        log(`Registration from ${deviceId}`);
        const resp = buildRegisterAck(phone, serverSerial++, serial, 0, "AUTH" + deviceId);
        socket.write(resp);
        log(`Sent registration ack`);
      } else if (msgId === 0x0102) {
        // Authentication -> send ack, then request fresh location
        log(`Authentication from ${deviceId}`);
        const resp = buildAck(phone, serverSerial++, serial, msgId, 0);
        socket.write(resp);
        log(`Sent auth ack`);
        // Send location query command (0x8201) to request fresh position
        const locQuery = buildResponse(0x8201, phone, serverSerial++, Buffer.alloc(0));
        socket.write(locQuery);
        log(`Sent location query command to ${deviceId}`);
      } else if (msgId === 0x0200) {
        // Location report -> parse and forward
        log(`Location body hex: ${body.toString("hex")}`);
        const loc = parseLocation(body);
        if (loc) {
          log(`Location: lat=${loc.lat}, lng=${loc.lng}, speed=${loc.speed}, time=${loc.time}`);
          forwardLocation(deviceId, loc);
        }
        const resp = buildAck(phone, serverSerial++, serial, msgId, 0);
        socket.write(resp);
      } else if (msgId === 0x0002) {
        // Heartbeat -> send ack
        const resp = buildAck(phone, serverSerial++, serial, msgId, 0);
        socket.write(resp);
        log(`Heartbeat ack sent`);
      } else {
        // Unknown message -> send generic ack
        log(`Unknown message 0x${msgId.toString(16).padStart(4,"0")}`);
        const resp = buildAck(phone, serverSerial++, serial, msgId, 0);
        socket.write(resp);
      }
    }
  });

  socket.on("end", () => log(`Client disconnected: ${clientId}`));
  socket.on("error", (err) => log(`Socket error from ${clientId}: ${err.message}`));
});

server.on("error", (err) => log(`Server error: ${err.message}`));

server.listen(PORT, HOST, () => {
  log(`TCP server listening on ${HOST}:${PORT}`);
});
