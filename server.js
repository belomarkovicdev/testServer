const net = require("net");
const http = require("http");
const https = require("https");

// ─── Config ───────────────────────────────────────────────────────────────────
const TCP_PORT = parseInt(process.env.TCP_PORT || "9000", 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || "9001", 10);
const HOST = "0.0.0.0";
const API_HOST = process.env.API_HOST ||
  "https://pet-tracker-gfe7aygtbbhhb3b3.westeurope-01.azurewebsites.net";
const API_PATH = "/api/location/raw";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
// ──────────────────────────────────────────────────────────────────────────────

function log(text) {
  console.log(`[${new Date().toISOString()}] ${text}`);
}

// ─── Device socket registry ───────────────────────────────────────────────────
// deviceId (IMEI string) → { socket, phone (Buffer 6 bytes) }
const deviceRegistry = new Map();

// ─── JT/T 808 Protocol helpers ───────────────────────────────────────────────
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

function buildResponse(msgId, phoneBytes, serialNum, bodyBuf) {
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

function buildAck(phoneBytes, serialNum, ackSerial, ackMsgId, result) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(ackSerial, 0);
  body.writeUInt16BE(ackMsgId, 2);
  body.writeUInt8(result, 4);
  return buildResponse(0x8001, phoneBytes, serialNum, body);
}

function buildRegisterAck(phoneBytes, serialNum, ackSerial, result, authCode) {
  const authBuf = Buffer.from(authCode, "ascii");
  const body = Buffer.alloc(3 + authBuf.length);
  body.writeUInt16BE(ackSerial, 0);
  body.writeUInt8(result, 2);
  authBuf.copy(body, 3);
  return buildResponse(0x8100, phoneBytes, serialNum, body);
}

function extractFrames(data) {
  const frames = [];
  let start = -1;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x7e) {
      if (start >= 0 && i > start + 1) {
        frames.push(data.subarray(start + 1, i));
      }
      start = i;
    }
  }
  return frames;
}

// ─── ICAR ASCII command framing ───────────────────────────────────────────────
// The IK122T accepts ASCII commands wrapped in 0x7E delimiters
function buildAsciiCommand(cmd) {
  const body = Buffer.from(cmd, "ascii");
  return Buffer.concat([Buffer.from([0x7e]), body, Buffer.from([0x7e])]);
}

// ─── Command dispatch ─────────────────────────────────────────────────────────
// commandType: one of the keys below
// params: optional string for parameterised commands
// level: 1-9 for app-level commands
function sendCommand(deviceId, commandType, params, level) {
  const entry = deviceRegistry.get(deviceId);
  if (!entry) return { ok: false, reason: "device_not_connected" };
  if (!entry.socket || entry.socket.destroyed) {
    deviceRegistry.delete(deviceId);
    return { ok: false, reason: "device_not_connected" };
  }

  const { socket, phone } = entry;

  // ── ASCII commands (ICAR SL protocol) ──────────────────────────────────────
  const asciiCommands = {
    RESTART:    () => buildAsciiCommand("SL RT"),
    FACTORY_RESET: () => buildAsciiCommand("SL FT"),
    CHECK_CONFIG:  () => buildAsciiCommand("SL CX"),
    BUZZER:     () => buildAsciiCommand("SL XG"),
    SET_INTERVAL: () => {
      // params expected as "<mode>,<seconds>" e.g. "0,10"
      if (!params) return null;
      return buildAsciiCommand(`SL SC${params}`);
    },
    SET_APN: () => {
      // params expected as "apn,user,pass"
      if (!params) return null;
      return buildAsciiCommand(`SL APN${params}`);
    },
    SET_SERVER: () => {
      // params expected as "domain#port"
      if (!params) return null;
      return buildAsciiCommand(`SL DP${params}`);
    },
    SET_ADMIN: () => {
      // params expected as phone number
      if (!params) return null;
      return buildAsciiCommand(`SL CP${params}#`);
    },
  };

  // ── JT808 binary app-level commands ────────────────────────────────────────
  // These are sent as 0x8300 (text message) or vendor-specific 0x8F00 range.
  // IK122T responds to 0x8300 (terminal text message) for sound/vibration/LED.
  // Format used by ICAR app: ASCII payload inside 0x8300 body.
  const appCommands = {
    SOUND: () => {
      const lvl = Math.min(9, Math.max(1, level || 5));
      return buildAsciiCommand(`SL SND${lvl}`);
    },
    VIBRATION: () => {
      const lvl = Math.min(9, Math.max(1, level || 5));
      return buildAsciiCommand(`SL VIB${lvl}`);
    },
    SHOCK: () => {
      const lvl = Math.min(9, Math.max(1, level || 5));
      return buildAsciiCommand(`SL SHK${lvl}`);
    },
    LED_STROBE: () => buildAsciiCommand("SL LED"),
    VOICE_MONITOR: () => buildAsciiCommand("SL VM"),
  };

  const allCommands = { ...asciiCommands, ...appCommands };
  const builder = allCommands[commandType];
  if (!builder) return { ok: false, reason: "unknown_command" };

  const frame = builder();
  if (!frame) return { ok: false, reason: "missing_params" };

  socket.write(frame);
  log(`[${deviceId}] Command sent: ${commandType}${params ? " params=" + params : ""}${level ? " level=" + level : ""}`);
  return { ok: true };
}

// ─── Forward raw frame to Spring backend ─────────────────────────────────────
function forwardRawFrame(deviceId, rawHex, msgId) {
  const payload = JSON.stringify({ deviceId, msgId, rawHex });
  log(`Forwarding raw frame: msgId=0x${msgId.toString(16).padStart(4, "0")} (${rawHex.length / 2} bytes)`);
  const url = new URL(API_PATH, API_HOST);
  const req = https.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  }, (res) => log(`API responded: ${res.statusCode}`));
  req.on("error", (err) => log(`API error: ${err.message}`));
  req.write(payload);
  req.end();
}

// ─── TCP Server ───────────────────────────────────────────────────────────────
let serverSerial = 0;
const tcpServer = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`Client connected: ${clientId}`);
  let currentDeviceId = null;

  socket.on("data", (chunk) => {
    if (chunk.toString("ascii", 0, 4) === "GET ") {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
      socket.end();
      return;
    }

    log(`Received ${chunk.length} bytes from ${clientId}`);
    const frames = extractFrames(chunk);

    for (const raw of frames) {
      const frame = unescape808(raw);
      if (frame.length < 12) continue;

      const msgId = frame.readUInt16BE(0);
      const phone = frame.subarray(4, 10);
      const serial = frame.readUInt16BE(10);
      const deviceId = phone.toString("hex").replace(/^0+/, "");
      const rawHex = chunk.toString("hex");

      log(`[${deviceId}] Message 0x${msgId.toString(16).padStart(4, "0")}, serial=${serial}`);

      // Register device on first message
      if (!deviceRegistry.has(deviceId) || deviceRegistry.get(deviceId).socket !== socket) {
        deviceRegistry.set(deviceId, { socket, phone });
        currentDeviceId = deviceId;
        log(`[${deviceId}] Registered in device registry`);
      }

      // Forward every frame to the backend
      forwardRawFrame(deviceId, rawHex, msgId);

      switch (msgId) {
        case 0x0100:
          socket.write(buildRegisterAck(phone, serverSerial++, serial, 0, "AUTH" + deviceId));
          log(`[${deviceId}] Registration ack sent`);
          break;

        case 0x0102:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          log(`[${deviceId}] Auth ack sent`);
          {
            const params = [];
            const makeParam = (id, val) => {
              const p = Buffer.alloc(9);
              p.writeUInt32BE(id, 0); p.writeUInt8(4, 4); p.writeUInt32BE(val, 5);
              return p;
            };
            params.push(makeParam(0x0020, 0));  // reporting strategy: timed
            params.push(makeParam(0x0021, 0));  // reporting scheme: ACC
            params.push(makeParam(0x0027, 10)); // sleep interval: 10s
            params.push(makeParam(0x0028, 5));  // emergency interval: 5s
            params.push(makeParam(0x0029, 10)); // default interval: 10s
            params.push(makeParam(0x0001, 30)); // heartbeat: 30s
            const paramCount = Buffer.alloc(1);
            paramCount.writeUInt8(params.length, 0);
            socket.write(buildResponse(0x8103, phone, serverSerial++, Buffer.concat([paramCount, ...params])));
            log(`[${deviceId}] Set GPS params`);
          }
          socket.write(buildResponse(0x8201, phone, serverSerial++, Buffer.alloc(0)));
          log(`[${deviceId}] Location query sent`);
          {
            const trackBody = Buffer.alloc(4);
            trackBody.writeUInt16BE(5, 0);      // interval: 5s
            trackBody.writeUInt16BE(0xffff, 2); // duration: indefinite
            socket.write(buildResponse(0x8202, phone, serverSerial++, trackBody));
            log(`[${deviceId}] Temporary tracking: every 5s indefinitely`);
          }
          break;

        case 0x0200:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          break;

        case 0x0002:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          log(`[${deviceId}] Heartbeat ack`);
          break;

        case 0x0107:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          socket.write(buildResponse(0x8104, phone, serverSerial++, Buffer.alloc(0)));
          log(`[${deviceId}] Terminal attribute report, queried all params`);
          break;

        case 0x0001: {
          const bodyLen = frame.readUInt16BE(2) & 0x03ff;
          const respBody = frame.subarray(12, 12 + bodyLen);
          if (respBody.length >= 5) {
            const ackId = respBody.readUInt16BE(2);
            const result = respBody.readUInt8(4);
            log(`[${deviceId}] Device ack: cmd=0x${ackId.toString(16).padStart(4, "0")} result=${result === 0 ? "OK" : "FAIL(" + result + ")"}`);
          }
          break;
        }

        case 0x0104: {
          const bodyLen = frame.readUInt16BE(2) & 0x03ff;
          const respBody = frame.subarray(12, 12 + bodyLen);
          log(`[${deviceId}] Terminal params (${respBody.length} bytes): ${respBody.subarray(0, Math.min(64, respBody.length)).toString("hex")}...`);
          break;
        }

        default:
          socket.write(buildAck(phone, serverSerial++, serial, msgId, 0));
          log(`[${deviceId}] Unknown 0x${msgId.toString(16).padStart(4, "0")}, ack sent`);
      }
    }
  });

  socket.on("end", () => {
    log(`Client disconnected: ${clientId}`);
    if (currentDeviceId) {
      deviceRegistry.delete(currentDeviceId);
      log(`[${currentDeviceId}] Removed from device registry`);
    }
  });

  socket.on("error", (err) => {
    log(`Socket error from ${clientId}: ${err.message}`);
    if (currentDeviceId) {
      deviceRegistry.delete(currentDeviceId);
    }
  });
});

tcpServer.on("error", (err) => log(`TCP server error: ${err.message}`));
tcpServer.listen(TCP_PORT, HOST, () => log(`TCP server listening on ${HOST}:${TCP_PORT}`));

// ─── HTTP Command Server ──────────────────────────────────────────────────────
// Spring backend calls POST /command to push a command to a device
// Body: { "deviceId": "...", "commandType": "...", "params": "...", "level": 5 }
// Optional header: X-Bridge-Secret for basic auth
const httpServer = http.createServer((req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", connectedDevices: deviceRegistry.size }));
    return;
  }

  // Connected devices list
  if (req.method === "GET" && req.url === "/devices") {
    if (BRIDGE_SECRET && req.headers["x-bridge-secret"] !== BRIDGE_SECRET) {
      res.writeHead(401); res.end("Unauthorized"); return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ devices: [...deviceRegistry.keys()] }));
    return;
  }

  // Command endpoint
  if (req.method === "POST" && req.url === "/command") {
    if (BRIDGE_SECRET && req.headers["x-bridge-secret"] !== BRIDGE_SECRET) {
      res.writeHead(401); res.end("Unauthorized"); return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "invalid_json" }));
        return;
      }

      const { deviceId, commandType, params, level } = parsed;
      if (!deviceId || !commandType) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "missing_deviceId_or_commandType" }));
        return;
      }

      const result = sendCommand(deviceId, commandType, params, level);
      const status = result.ok ? 200 : result.reason === "device_not_connected" ? 404 : 400;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

httpServer.on("error", (err) => log(`HTTP server error: ${err.message}`));
httpServer.listen(HTTP_PORT, HOST, () => log(`HTTP command server listening on ${HOST}:${HTTP_PORT}`));
