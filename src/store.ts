// Durable domain store for the Arrangement Request bot.
//
// All durable data (arrangement requests, terms acceptance, owner
// notifications, owner config) lives here, backed by the toolkit's
// persistent storage adapter: Redis in production (auto-selected when
// REDIS_URL is set), in-memory in dev and under the tokenless test
// harness. Nothing here is a hand-rolled Map used as a database — the
// adapter IS the database, and it is the toolkit's own storage seam
// (resolveSessionStorage), exactly the path createBot uses for sessions.
//
// Collections are read through explicit INDEX records (idx:requests),
// never by enumerating the keyspace (no KEYS/SCAN/readAll) — that is an
// O(N) hazard that blocks Redis.

import type { StorageAdapter } from "grammy";
import { resolveSessionStorage } from "./toolkit/session/redis.js";
import { MemorySessionStorage } from "./toolkit/session/memory.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The durable store holds heterogeneous JSON values (strings, numbers,
// arrays, objects) under one adapter. grammY's StorageAdapter<T> constrains
// T to `object`, so a single hetero store is typed as `any` — the values are
// JSON-serializable by construction (see the per-key read casts below).

// ---------------------------------------------------------------------------
// Injectable clock — route every timestamp through this single seam so a
// test can drive time-based behaviour. Never call Date.now()/new Date()
// inline from a handler.
// ---------------------------------------------------------------------------

let _clock: () => number = () => Date.now();

/** The single clock seam. Use `now()` everywhere a wall-clock time is needed. */
export function now(): number {
  return _clock();
}

/** Test-only: override the clock. Restore with `_resetClock()`. */
export function _setClock(fn: () => number): void {
  _clock = fn;
}

/** Test-only: restore the real clock. */
export function _resetClock(): void {
  _clock = () => Date.now();
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface Question {
  key: string;
  prompt: string;
}

export type AttachmentType =
  | "document"
  | "photo"
  | "audio"
  | "video"
  | "voice"
  | "animation"
  | "sticker"
  | "other";

export interface Attachment {
  file_id: string;
  type: AttachmentType;
  file_name?: string;
}

export interface TermsAcceptance {
  terms_text: string;
  user_response: string;
  acceptance_timestamp: number;
}

export type RequestStatus = "submitted" | "processed" | "declined";
export type NotificationStatus = "pending" | "processed" | "declined";

/** Arrangement request (retention: persistent). */
export interface ArrangementRequest {
  id: number;
  requesterUserId: number;
  requesterName: string;
  chatId: number;
  createdAt: number;
  status: RequestStatus;
  answers: Record<string, string>;
  termsAcceptance: TermsAcceptance;
  attachments: Attachment[];
}

/** Owner notification (retention: persistent). */
export interface OwnerNotification {
  request_reference: number;
  notification_timestamp: number;
  status: NotificationStatus;
}

// ---------------------------------------------------------------------------
// Defaults — owner-configurable, but these ship out of the box.
// ---------------------------------------------------------------------------

export const DEFAULT_TERMS =
  "By submitting, you confirm the details you provided are accurate. " +
  "Your request is shared only with the owner, who will review and act on it.";

export const DEFAULT_QUESTIONS: Question[] = [
  { key: "purpose", prompt: "What is the arrangement for?" },
  { key: "details", prompt: "Add any details." },
];

// ---------------------------------------------------------------------------
// Owner resolution. The owner is the Telegram user id in BOT_OWNER_ID. In
// production the deployer MUST set it. When unset (dev + the tokenless
// harness, which has no env), it falls back to user 1 — the harness's
// default user — so owner features remain reachable in tests.
// ---------------------------------------------------------------------------

export function ownerUserId(): number {
  const env = typeof process === "undefined" ? ({} as Record<string, string | undefined>) : process.env;
  const raw = env.BOT_OWNER_ID;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return 1;
}

export function isOwner(userId: number): boolean {
  return userId === ownerUserId();
}

// ---------------------------------------------------------------------------
// Storage keys (namespaced, no prefix collision with grammY session keys).
// ---------------------------------------------------------------------------

const K_TERMS = "arr:cfg:terms";
const K_QUESTIONS = "arr:cfg:questions";
const K_SEQ = "arr:cfg:seq";
const K_REQUEST = (id: number) => `arr:req:${id}`;
const K_INDEX = "arr:idx:requests";
const K_NOTE = (id: number) => `arr:note:${id}`;
const K_OWNER_LAST = "arr:owner:last_notified";

// ---------------------------------------------------------------------------
// Store factory — a bound set of helpers over one StorageAdapter. The
// module singleton is the live store handlers use; tests build their own
// instance over a fresh MemorySessionStorage for full isolation.
// ---------------------------------------------------------------------------

export interface DurableStore {
  getTerms(): Promise<string>;
  setTerms(text: string): Promise<void>;
  getQuestions(): Promise<Question[]>;
  setQuestions(qs: Question[]): Promise<void>;
  nextRequestId(): Promise<number>;
  saveRequest(r: ArrangementRequest): Promise<void>;
  getRequest(id: number): Promise<ArrangementRequest | undefined>;
  saveNotification(n: OwnerNotification): Promise<void>;
  getNotification(id: number): Promise<OwnerNotification | undefined>;
  setOwnerLastNotified(id: number): Promise<void>;
  getOwnerLastNotified(): Promise<number | undefined>;
  listPendingRequests(): Promise<ArrangementRequest[]>;
  markProcessed(id: number): Promise<boolean>;
}

export function createDurableStore(adapter?: StorageAdapter<any>): DurableStore {
  const a: StorageAdapter<any> = adapter ?? resolveSessionStorage<any>(undefined);

  async function getTerms(): Promise<string> {
    return ((await a.read(K_TERMS)) as string | undefined) ?? DEFAULT_TERMS;
  }
  async function setTerms(text: string): Promise<void> {
    await a.write(K_TERMS, text);
  }
  async function getQuestions(): Promise<Question[]> {
    return ((await a.read(K_QUESTIONS)) as Question[] | undefined) ?? DEFAULT_QUESTIONS;
  }
  async function setQuestions(qs: Question[]): Promise<void> {
    await a.write(K_QUESTIONS, qs);
  }
  async function nextRequestId(): Promise<number> {
    const seq = ((await a.read(K_SEQ)) as number | undefined) ?? 1;
    await a.write(K_SEQ, seq + 1);
    return seq;
  }
  async function saveRequest(r: ArrangementRequest): Promise<void> {
    await a.write(K_REQUEST(r.id), r);
    const idx = ((await a.read(K_INDEX)) as number[] | undefined) ?? [];
    idx.push(r.id);
    await a.write(K_INDEX, idx);
  }
  async function getRequest(id: number): Promise<ArrangementRequest | undefined> {
    return (await a.read(K_REQUEST(id))) as ArrangementRequest | undefined;
  }
  async function saveNotification(n: OwnerNotification): Promise<void> {
    await a.write(K_NOTE(n.request_reference), n);
  }
  async function getNotification(id: number): Promise<OwnerNotification | undefined> {
    return (await a.read(K_NOTE(id))) as OwnerNotification | undefined;
  }
  async function setOwnerLastNotified(id: number): Promise<void> {
    await a.write(K_OWNER_LAST, id);
  }
  async function getOwnerLastNotified(): Promise<number | undefined> {
    return (await a.read(K_OWNER_LAST)) as number | undefined;
  }
  // Read through the explicit index record — never enumerate the keyspace.
  async function listPendingRequests(): Promise<ArrangementRequest[]> {
    const idx = ((await a.read(K_INDEX)) as number[] | undefined) ?? [];
    const out: ArrangementRequest[] = [];
    for (const id of idx) {
      const r = (await a.read(K_REQUEST(id))) as ArrangementRequest | undefined;
      const n = (await a.read(K_NOTE(id))) as OwnerNotification | undefined;
      if (r && n && n.status === "pending") out.push(r);
    }
    return out;
  }
  async function markProcessed(id: number): Promise<boolean> {
    const r = (await a.read(K_REQUEST(id))) as ArrangementRequest | undefined;
    if (r) {
      r.status = "processed";
      await a.write(K_REQUEST(id), r);
    }
    const n = (await a.read(K_NOTE(id))) as OwnerNotification | undefined;
    if (n) {
      n.status = "processed";
      await a.write(K_NOTE(id), n);
    }
    return r !== undefined;
  }

  return {
    getTerms,
    setTerms,
    getQuestions,
    setQuestions,
    nextRequestId,
    saveRequest,
    getRequest,
    saveNotification,
    getNotification,
    setOwnerLastNotified,
    getOwnerLastNotified,
    listPendingRequests,
    markProcessed,
  };
}

// The live singleton handlers use. Memoized so writes persist across
// operations within a bot (and across the fresh-bot-per-spec gate run).
let _store: DurableStore = createDurableStore();

/** The live durable store (handlers call this). */
export function store(): DurableStore {
  return _store;
}

/** Test-only: rebuild the singleton over a fresh adapter. */
export function _resetDurableStore(): void {
  _store = createDurableStore(new MemorySessionStorage<any>());
}
