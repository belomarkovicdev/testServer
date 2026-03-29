"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const net = __importStar(require("net"));
const https = __importStar(require("https"));
const protocol_1 = require("./protocol");
// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "9000", 10);
const HOST = "0.0.0.0";
const API_HOST = "jbtracker.onrender.com";
const API_PATH = "/location";
function log(text) {
    console.log(`[${new Date().toISOString()}] ${text}`);
}
// ─── Forward location to API ─────────────────────────────────────────────────
function forwardLocation(deviceId, location) {
    const payload = JSON.stringify({ deviceId, ...location });
    log(`Forwarding: ${payload}`);
    const req = https.request({
        hostname: API_HOST,
        path: API_PATH,
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
        const frames = (0, protocol_1.extractFrames)(chunk);
        for (const raw of frames) {
            const frame = (0, protocol_1.unescape808)(raw);
            if (frame.length < 12)
                continue;
            const msgId = frame.readUInt16BE(0);
            const bodyLen = frame.readUInt16BE(2) & 0x03ff;
            const phone = frame.subarray(4, 10);
            const serial = frame.readUInt16BE(10);
            const body = frame.subarray(12, 12 + bodyLen);
            const deviceId = phone.toString("hex").replace(/^0+/, "");
            log(`[${deviceId}] Message 0x${msgId.toString(16).padStart(4, "0")}, serial=${serial}`);
            switch (msgId) {
                case 0x0100: {
                    // Terminal Registration
                    const resp = (0, protocol_1.buildRegisterAck)(phone, serverSerial++, serial, 0, "AUTH" + deviceId);
                    socket.write(resp);
                    log(`[${deviceId}] Registration ack sent`);
                    break;
                }
                case 0x0102: {
                    // Authentication
                    socket.write((0, protocol_1.buildAck)(phone, serverSerial++, serial, msgId, 0));
                    // Request fresh location
                    socket.write((0, protocol_1.buildResponse)(0x8201, phone, serverSerial++, Buffer.alloc(0)));
                    log(`[${deviceId}] Auth ack + location query sent`);
                    break;
                }
                case 0x0200: {
                    // Location report
                    const loc = (0, protocol_1.parseLocation)(body);
                    if (loc) {
                        log(`[${deviceId}] Location: ${loc.lat},${loc.lng} speed=${loc.speed} bat=${loc.battery}%`);
                        forwardLocation(deviceId, loc);
                    }
                    socket.write((0, protocol_1.buildAck)(phone, serverSerial++, serial, msgId, 0));
                    break;
                }
                case 0x0002: {
                    // Heartbeat
                    socket.write((0, protocol_1.buildAck)(phone, serverSerial++, serial, msgId, 0));
                    log(`[${deviceId}] Heartbeat ack`);
                    break;
                }
                default: {
                    socket.write((0, protocol_1.buildAck)(phone, serverSerial++, serial, msgId, 0));
                    log(`[${deviceId}] Unknown 0x${msgId.toString(16).padStart(4, "0")}, ack sent`);
                }
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
