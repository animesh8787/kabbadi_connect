import type { Category, Confirm, CreateRequest } from "@kc/shared";
import { apiUrl, token } from "./auth";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: { authorization: await token(), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "request failed");
  return data as T;
}

export interface Req {
  id: string;
  status: "OPEN" | "ASSIGNED" | "EN_ROUTE" | "PICKED" | "MISSED" | "CANCELLED";
  items: { cat: Category; bucket: string; estKg: number }[];
  address: string;
  date: string;
  slot: string;
  estKg: number;
  actual?: { cat: Category; kg: number }[];
  payout?: number;
  co2Kg?: number;
  householdAck?: boolean;
  segregation?: "good" | "mixed" | null;
}
export interface Stop {
  id: string;
  status: Req["status"];
  address: string;
  lat: number;
  lng: number;
  items: Req["items"];
  estKg: number;
  phone?: string;
  actual?: Req["actual"];
  payout?: number;
}
export interface Batch {
  id: string;
  window: string;
  status: "ASSIGNED" | "ACTIVE";
  km: number;
  naiveKm: number;
  routeSource: string;
  naiveOrder?: string[];
  estKg: number;
  stops: Stop[];
}
export interface Impact {
  pickups: number;
  kg: number;
  co2Kg: number;
  payout: number;
  kmSavedPct: number;
  routeKm: number;
  naiveKm: number;
  byCategory: Record<Category, number>;
  daily: { date: string; kg: number; pickups: number }[];
  ackKg: number;
  ackPickups: number;
  segTotal: number;
  segGood: number;
}

export interface Collector {
  id: string;
  name: string;
  phone: string;
  areas: string[];
  lat: number;
  lng: number;
  active: boolean;
  cardActive: boolean;
}
export interface Card {
  id: string;
  username: string;
  code: string;
  validUntil: number;
}
export interface Ledger {
  month: string;
  collector: { name: string; phone: string };
  pickups: number;
  verifiedPickups: number;
  kg: number;
  byCategory: Record<string, number>;
  payout: number;
  co2Kg: number;
  segregationGoodPct: number | null;
  rows: { date: string; kg: number; payout: number; verified: boolean }[];
}
export type Action =
  | { type: "focus"; stopId: string }
  | { type: "start"; batchId: string }
  | { type: "confirm"; stopId: string; items: { cat: Category; actualKg: number }[]; segregation?: "good" | "mixed" }
  | { type: "missed"; stopId: string }
  | { type: "call"; phone: string }
  | { type: "navigate"; lat: number; lng: number };
export interface Turn {
  heard: string;
  say?: string;
  action?: Action;
  needsConfirm?: boolean;
  audio?: string;
  audioMime?: string;
}

export const api = {
  create: (b: CreateRequest) => call<Req>("POST", "/requests", b),
  mine: () => call<{ requests: Req[] }>("GET", "/requests"),
  cancel: (id: string) => call("POST", `/requests/${id}/cancel`),
  ack: (id: string) => call("POST", `/requests/${id}/ack`),
  batches: () => call<{ batches: Batch[] }>("GET", "/collector/batches/today"),
  accept: (id: string) => call("POST", `/batches/${id}/accept`),
  missed: (id: string) => call("POST", `/requests/${id}/missed`),
  confirm: (id: string, b: Confirm) => call("POST", `/requests/${id}/confirm`, b),
  impact: () => call<Impact>("GET", "/impact?days=30"),
  ledger: (month: string) => call<Ledger>("GET", `/collector/ledger?month=${month}`),
  adminLedger: (id: string, month: string) => call<Ledger>("GET", `/admin/collectors/${id}/ledger?month=${month}`),
  collectors: () => call<{ collectors: Collector[] }>("GET", "/admin/collectors"),
  createCollector: (b: { name: string; phone: string; areas: string[]; lat: number; lng: number }) => call<Card>("POST", "/admin/collectors", b),
  newCard: (id: string) => call<Card>("POST", `/admin/collectors/${id}/enroll`),
  revoke: (id: string) => call("POST", `/admin/collectors/${id}/revoke`),
  assistant: (b: { audio?: string; text?: string; focusStopId?: string; transcribeOnly?: boolean }) => call<Turn>("POST", "/assistant", b),
  speak: (text: string) => call<{ audio: string; audioMime: string }>("POST", "/speak", { text }),
  photo: (image: string) => call<{ items: { cat: Category; bucket: string }[]; note: string }>("POST", "/photo-estimate", { image }),
};
