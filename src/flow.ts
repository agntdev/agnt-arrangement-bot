// Shared flow state + session accessors for the Arrangement Request bot.
//
// Lives OUTSIDE src/handlers/ so buildBot's handler loader (which scans
// src/handlers/ and requires a default-exported Composer) never tries to
// load it as a handler. Handlers import it via "../flow.js".
//
// The per-chat session holds ONLY ephemeral conversation state (the in-
// progress flow + the owner's transient text-entry step). Durable domain
// data lives in src/store.ts. We augment the toolkit's Session interface
// via declaration merging so ctx.session.flow / ctx.session.ownerStep are
// typed without editing bot.ts.

import type { Ctx } from "./bot.js";
import type { Attachment } from "./store.js";

export type FlowStep = "questions" | "awaiting_acceptance";

export interface FlowState {
  step: FlowStep;
  /** 0-based index into the configured question set. */
  questionIndex: number;
  answers: Record<string, string>;
  attachments: Attachment[];
  startedAt: number;
}

export type OwnerStep = "set_terms" | "add_question";

declare module "./bot.js" {
  interface Session {
    flow?: FlowState;
    ownerStep?: OwnerStep;
  }
}

export function getFlow(ctx: Ctx): FlowState | undefined {
  return ctx.session.flow;
}

export function setFlow(ctx: Ctx, flow: FlowState): void {
  ctx.session.flow = flow;
}

export function clearFlow(ctx: Ctx): void {
  ctx.session.flow = undefined;
}

export function isFlowActive(ctx: Ctx): boolean {
  return ctx.session.flow !== undefined;
}

export function getOwnerStep(ctx: Ctx): OwnerStep | undefined {
  return ctx.session.ownerStep;
}

export function setOwnerStep(ctx: Ctx, step: OwnerStep | undefined): void {
  ctx.session.ownerStep = step;
}
