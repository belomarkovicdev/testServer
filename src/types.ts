// ─── JT/T 808 Protocol Interfaces ────────────────────────────────────────────

export interface CellTower {
  mcc: number;
  mnc: number;
  lac: number;
  cellId: number;
  signal: number;
  rssi: number;
}

export interface LocationData {
  lat: number;
  lng: number;
  altitude: number;
  speed: number;
  direction: number;
  time: string;
  alarm: number;
  status: number;
  towers: CellTower[] | null;
  odometer: number | null;
  signalStrength: number | null;
  satellites: number | null;
  battery: number | null;
  charging: number | null;
  acc: number | null;
  deviceMode: string | null;
  posMode: number | null;
}

export interface LocationPayload extends LocationData {
  deviceId: string;
}

export interface JT808Header {
  msgId: number;
  bodyLen: number;
  phone: Buffer;
  serial: number;
  deviceId: string;
}

export interface ParsedMessage {
  consumed: number;
  message: JT808Header & { body: Buffer };
}

export interface ExtraItems {
  [id: number]: Buffer;
}
