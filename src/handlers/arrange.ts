import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { isFlowActive, getOwnerStep } from "../flow.js";

// Group trigger handling: a message that contains "Arrangement" (or the
// /arrange command) prompts the user to continue in a private 1:1 chat.
// All detailed collection happens privately; the group only ever sees this
// invitation, so no sensitive info is exposed in the group.

const composer = new Composer<Ctx>();

const PROMPT = "Let's take this to a private chat to keep your details private. Tap below to continue.";
const continueButton = inlineKeyboard([[inlineButton("🔒 Continue in private", "private:start")]]);

async function invitePrivate(ctx: Ctx) {
  await ctx.reply(PROMPT, { reply_markup: continueButton });
}

// /arrange — the explicit trigger (works in groups and private chats).
composer.command("arrange", async (ctx) => {
  await invitePrivate(ctx);
});

// A plain message containing "arrangement" (case-insensitive) also triggers
// the invitation — but never while the user is already mid-flow, so a typed
// answer that happens to mention the word isn't hijacked.
composer.on("message:text", async (ctx, next) => {
  if (isFlowActive(ctx) || getOwnerStep(ctx)) return next();
  if (/arrangement/i.test(ctx.message.text)) {
    await invitePrivate(ctx);
    return;
  }
  return next();
});

export default composer;
