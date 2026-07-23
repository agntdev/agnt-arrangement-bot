import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import {
  store,
  now,
  type ArrangementRequest,
  type Attachment,
  type Question,
  ownerUserId,
} from "../store.js";
import {
  getFlow,
  setFlow,
  clearFlow,
  isFlowActive,
  getOwnerStep,
  type FlowState,
} from "../flow.js";

// Private chat onboarding: identity confirmation → sequential question
// collection → attachment handling → terms acceptance → submission +
// owner notification. All sensitive collection happens here in a 1:1 chat,
// never in the group. In-progress state lives in the (ephemeral) per-chat
// session; only the completed request is persisted to the durable store.

const composer = new Composer<Ctx>();

// Reaches the flow from the /start menu as a tap (button-first), not a command.
registerMainMenuItem({ label: "🔒 New request", data: "private:start", order: 10 });

const cancelKeyboard = inlineKeyboard([[inlineButton("✖️ Cancel", "flow:cancel")]]);

function displayName(from: { first_name?: string; last_name?: string; username?: string }): string {
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return full || from.username || "User";
}

function questionPrompt(questions: Question[], index: number): string {
  return `${index + 1}. ${questions[index]!.prompt}`;
}

async function askCurrent(ctx: Ctx, questions: Question[], flow: FlowState, intro = false): Promise<void> {
  const prompt = questionPrompt(questions, flow.questionIndex);
  const text = intro
    ? `Got it, ${displayName(ctx.from!)}. Let's set up your request.\n\n${prompt}`
    : prompt;
  await ctx.reply(text, { reply_markup: cancelKeyboard });
}

async function showTerms(ctx: Ctx, terms: string): Promise<void> {
  const text =
    "📋 Please review the terms:\n\n" +
    terms +
    "\n\nType 'I accept' to confirm and submit your request.";
  await ctx.reply(text, { reply_markup: cancelKeyboard });
}

function ownerNotificationText(req: ArrangementRequest, questions: Question[]): string {
  const lines = questions.map(
    (q, i) => `${i + 1}. ${q.prompt}\n   ${req.answers[q.key] ?? "—"}`,
  );
  return (
    "📋 New arrangement request\n\nFrom: " +
    req.requesterName +
    "\n\n" +
    lines.join("\n") +
    "\n\n📎 Attachments: " +
    req.attachments.length +
    "\n✅ Terms accepted"
  );
}

const ownerActionsKeyboard = inlineKeyboard([
  [inlineButton("✅ Mark processed", "owner:mark_processed")],
  [inlineButton("⬅️ Back to menu", "menu:main")],
]);

// --- Entry point: "Continue in private" / "New request" ---------------------

composer.callbackQuery("private:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (isFlowActive(ctx)) {
    await ctx.reply(
      "You already have a request in progress. Tap ✖️ Cancel on the last question to start over.",
    );
    return;
  }
  const questions = await store().getQuestions();
  const flow: FlowState = {
    step: "questions",
    questionIndex: 0,
    answers: {},
    attachments: [],
    startedAt: now(),
  };
  setFlow(ctx, flow);
  await askCurrent(ctx, questions, flow, true);
});

// --- Cancel from any step -------------------------------------------------

composer.callbackQuery("flow:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearFlow(ctx);
  await ctx.editMessageText("❌ Cancelled. Your request was not submitted.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
});

// --- Text answers (questions + terms acceptance) ---------------------------

composer.on("message:text", async (ctx, next) => {
  const flow = getFlow(ctx);
  if (!flow) return next();

  // Let /start (and any slash command not already handled) escape the flow
  // — abandoning it cleanly to re-show the menu.
  if (ctx.message.text.startsWith("/")) {
    clearFlow(ctx);
    return next();
  }
  // Owner text-entry steps are owned by owner.ts (which runs earlier); if
  // one is somehow still set, defer to it.
  if (getOwnerStep(ctx)) return next();

  const text = ctx.message.text.trim();
  const questions = await store().getQuestions();

  if (flow.step === "questions") {
    const q = questions[flow.questionIndex];
    if (!q) {
      // Misconfigured question set (fewer questions than the index). Reset.
      clearFlow(ctx);
      await ctx.reply("Something went wrong with the question set. Tap /start to begin again.");
      return;
    }
    if (text.length === 0) {
      await ctx.reply(
        "⚠️ Please enter a response.\n\n" + questionPrompt(questions, flow.questionIndex),
        { reply_markup: cancelKeyboard },
      );
      return;
    }
    flow.answers[q.key] = text;
    flow.questionIndex += 1;
    if (flow.questionIndex < questions.length) {
      setFlow(ctx, flow);
      await askCurrent(ctx, questions, flow, false);
      return;
    }
    // All questions answered → terms.
    flow.step = "awaiting_acceptance";
    setFlow(ctx, flow);
    const terms = await store().getTerms();
    await showTerms(ctx, terms);
    return;
  }

  // step === "awaiting_acceptance"
  if (text !== "I accept") {
    await ctx.reply("Please type exactly 'I accept' to confirm and submit.", {
      reply_markup: cancelKeyboard,
    });
    return;
  }

  await submit(ctx, flow, questions);
});

// --- Attachments (any media) during the question phase --------------------

function attachmentFromMessage(msg: NonNullable<Ctx["message"]>): Attachment | undefined {
  if (msg.document) return { file_id: msg.document.file_id, type: "document", file_name: msg.document.file_name };
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]!;
    return { file_id: photo.file_id, type: "photo" };
  }
  if (msg.audio) return { file_id: msg.audio.file_id, type: "audio", file_name: msg.audio.file_name };
  if (msg.video) return { file_id: msg.video.file_id, type: "video", file_name: msg.video.file_name };
  if (msg.voice) return { file_id: msg.voice.file_id, type: "voice" };
  if (msg.animation) return { file_id: msg.animation.file_id, type: "animation", file_name: msg.animation.file_name };
  if (msg.sticker) return { file_id: msg.sticker.file_id, type: "sticker" };
  return undefined;
}

async function handleAttachment(ctx: Ctx, next: () => Promise<void>): Promise<void> {
  const flow = getFlow(ctx);
  if (!flow || flow.step !== "questions") return next();
  if (!ctx.message) return next();
  const att = attachmentFromMessage(ctx.message);
  if (!att) return next();
  flow.attachments.push(att);
  setFlow(ctx, flow);
  const questions = await store().getQuestions();
  await ctx.reply(
    "📎 Attachment saved (" + flow.attachments.length + " so far).\n\n" +
      questionPrompt(questions, flow.questionIndex),
    { reply_markup: cancelKeyboard },
  );
}

for (const t of ["document", "photo", "audio", "video", "voice", "animation", "sticker"] as const) {
  composer.on(`message:${t}`, async (ctx, next) => handleAttachment(ctx, next));
}

// --- Submit: persist + notify --------------------------------------------

async function submit(ctx: Ctx, flow: FlowState, questions: Question[]): Promise<void> {
  const terms = await store().getTerms();
  const termsAcceptance = {
    terms_text: terms,
    user_response: "I accept",
    acceptance_timestamp: now(),
  };
  const id = await store().nextRequestId();
  const request: ArrangementRequest = {
    id,
    requesterUserId: ctx.from!.id,
    requesterName: displayName(ctx.from!),
    chatId: ctx.chat!.id,
    createdAt: now(),
    status: "submitted",
    answers: flow.answers,
    termsAcceptance,
    attachments: flow.attachments,
  };
  await store().saveRequest(request);
  await store().saveNotification({
    request_reference: id,
    notification_timestamp: now(),
    status: "pending",
  });
  await store().setOwnerLastNotified(id);
  clearFlow(ctx);

  // Notify the owner. A cold DM can 403 if the owner never started the bot or
  // has blocked it — tolerate that without aborting the user's confirmation.
  try {
    await ctx.api.sendMessage(ownerUserId(), ownerNotificationText(request, questions), {
      reply_markup: ownerActionsKeyboard,
    });
  } catch {
    // best-effort: the user still gets their confirmation below.
  }

  await ctx.reply("✅ Your request was submitted. The owner will review it.", {
    reply_markup: inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]),
  });
}

export default composer;
