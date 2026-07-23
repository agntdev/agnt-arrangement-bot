import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import {
  store,
  isOwner,
  DEFAULT_TERMS,
  DEFAULT_QUESTIONS,
  type ArrangementRequest,
  type Question,
} from "../store.js";
import { getOwnerStep, setOwnerStep, isFlowActive } from "../flow.js";

// Owner controls: a single owner (the Telegram user id in BOT_OWNER_ID)
// views pending requests, configures the question set, sets the terms text,
// and marks requests as processed. The owner button is on the main menu for
// everyone (button-first reachability), but every owner action is gated on
// isOwner(ctx.from.id) — non-owners get a polite "not available".

const composer = new Composer<Ctx>();

registerMainMenuItem({ label: "🛠 Owner", data: "owner:panel", order: 90 });

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);
const backToPanel = inlineKeyboard([
  [inlineButton("⬅️ Back to panel", "owner:panel")],
]);

function requireOwner(ctx: Ctx): boolean {
  return isOwner(ctx.from!.id);
}

async function deny(ctx: Ctx): Promise<void> {
  await ctx.editMessageText("🔒 Only the bot owner can use this.", {
    reply_markup: backToMenu,
  });
}

const panelKeyboard = inlineKeyboard([
  [inlineButton("📋 Pending requests", "owner:pending")],
  [inlineButton("❓ Configure questions", "owner:config_questions")],
  [inlineButton("📝 Set terms", "owner:set_terms")],
  [inlineButton("⬅️ Back to menu", "menu:main")],
]);

// --- Owner panel ----------------------------------------------------------

composer.callbackQuery("owner:panel", async (ctx) => {
  await ctx.answerCallbackQuery();
  // Entering the panel clears any transient owner text-entry step.
  setOwnerStep(ctx, undefined);
  if (!requireOwner(ctx)) {
    await ctx.editMessageText("🔒 Only the bot owner can use this.", {
      reply_markup: backToMenu,
    });
    return;
  }
  await ctx.editMessageText("🛠 Owner panel — manage arrangement requests.", {
    reply_markup: panelKeyboard,
  });
});

// --- Pending requests -----------------------------------------------------

function pendingLine(r: ArrangementRequest, questions: Question[]): string {
  const answers = questions
    .map((q, i) => `  ${i + 1}. ${q.prompt} — ${r.answers[q.key] ?? "—"}`)
    .join("\n");
  return `• From: ${r.requesterName}\n${answers}\n  📎 Attachments: ${r.attachments.length}`;
}

composer.callbackQuery("owner:pending", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!requireOwner(ctx)) return deny(ctx);
  const pending = await store().listPendingRequests();
  if (pending.length === 0) {
    await ctx.editMessageText(
      "📭 No pending requests — they'll show up here when someone submits one.",
      { reply_markup: backToPanel },
    );
    return;
  }
  const questions = await store().getQuestions();
  const body = pending.map((r) => pendingLine(r, questions)).join("\n\n");
  await ctx.editMessageText(
    `📋 Pending requests (${pending.length}):\n\n${body}`,
    { reply_markup: backToPanel },
  );
});

// --- Configure questions --------------------------------------------------

const configQuestionsKeyboard = inlineKeyboard([
  [inlineButton("➕ Add question", "owner:add_question")],
  [inlineButton("♻️ Restore defaults", "owner:restore_questions")],
  [inlineButton("⬅️ Back to panel", "owner:panel")],
]);

async function showConfigQuestions(ctx: Ctx): Promise<void> {
  const qs = await store().getQuestions();
  const body = qs.map((q, i) => `${i + 1}. ${q.prompt}`).join("\n");
  await ctx.editMessageText(`❓ Question set\n\n${body}`, {
    reply_markup: configQuestionsKeyboard,
  });
}

composer.callbackQuery("owner:config_questions", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!requireOwner(ctx)) return deny(ctx);
  await showConfigQuestions(ctx);
});

composer.callbackQuery("owner:add_question", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!requireOwner(ctx)) return deny(ctx);
  setOwnerStep(ctx, "add_question");
  await ctx.editMessageText("➕ Send the new question text.", {
    reply_markup: backToPanel,
  });
});

composer.callbackQuery("owner:restore_questions", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!requireOwner(ctx)) return deny(ctx);
  await store().setQuestions(DEFAULT_QUESTIONS);
  await ctx.editMessageText("✅ Questions restored to default.", {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to questions", "owner:config_questions")],
      [inlineButton("⬅️ Back to panel", "owner:panel")],
    ]),
  });
});

// --- Set terms ------------------------------------------------------------

composer.callbackQuery("owner:set_terms", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!requireOwner(ctx)) return deny(ctx);
  setOwnerStep(ctx, "set_terms");
  await ctx.editMessageText("📝 Send the new terms text.", {
    reply_markup: backToPanel,
  });
});

// --- Owner text entry (set_terms / add_question) --------------------------

composer.on("message:text", async (ctx, next) => {
  const step = getOwnerStep(ctx);
  if (!step) return next();
  // Let slash commands escape owner text-entry (e.g. /start to abort).
  if (ctx.message.text.startsWith("/")) {
    setOwnerStep(ctx, undefined);
    return next();
  }
  // Never intercept an in-progress user flow.
  if (isFlowActive(ctx)) return next();

  const text = ctx.message.text.trim();
  if (step === "set_terms") {
    if (text.length === 0) {
      await ctx.reply("⚠️ Terms can't be empty. Send the new terms text.");
      return;
    }
    await store().setTerms(text);
    setOwnerStep(ctx, undefined);
    await ctx.reply("✅ Terms updated.", { reply_markup: backToPanel });
    return;
  }

  // add_question
  if (text.length === 0) {
    await ctx.reply("⚠️ The question can't be empty. Send the new question text.");
    return;
  }
  const qs = await store().getQuestions();
  const key = `custom_${qs.length + 1}`;
  await store().setQuestions([...qs, { key, prompt: text }]);
  setOwnerStep(ctx, undefined);
  await ctx.reply("✅ Question added.", {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to questions", "owner:config_questions")],
      [inlineButton("♻️ Restore defaults", "owner:restore_questions")],
    ]),
  });
});

// --- Mark a request as processed (from the owner notification buttons) ----

composer.callbackQuery("owner:mark_processed", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!requireOwner(ctx)) return deny(ctx);
  const id = await store().getOwnerLastNotified();
  if (id === undefined) {
    await ctx.editMessageText("No request to mark.", { reply_markup: backToMenu });
    return;
  }
  await store().markProcessed(id);
  await ctx.editMessageText("✅ Marked as processed.", {
    reply_markup: backToMenu,
  });
});

export default composer;
