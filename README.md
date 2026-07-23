# Agnt Arrangement Bot

Telegram bot that collects private 'Arrangement' requests, records exact Terms acceptance, stores attachments as Telegram file IDs, and forwards completed requests to a single owner.

Spec: [`docs/blueprint.md`](docs/blueprint.md).

Built on [agnt-gm.ai](https://agnt-gm.ai). The whole bot is built and refined here as pull requests across successive build passes.

## Configuration

Set in the environment (see `.env.example`):

- `BOT_TOKEN` — the BotFather token (required).
- `BOT_OWNER_ID` — Telegram user id of the single owner who receives
  requests and uses the Owner panel. **Required in production.** When unset,
  owner features fall back to user id 1 (dev/test only).
- `REDIS_URL` — optional. When set, durable data (requests, terms/questions
  config, owner notifications) persists in Redis; otherwise the toolkit's
  in-memory adapter is used (dev/test).

For group triggers (the `/arrange` command and messages containing
"Arrangement") to be detected, the bot must read group messages — disable
**Group Privacy** for the bot via BotFather (`/setprivacy` → Disable). The
bot only ever posts a private-chat invitation in the group, so no sensitive
details are exposed there.

## How it works

1. In a group, `/arrange` or a message mentioning "arrangement" prompts the
   user to continue in a private 1:1 chat.
2. In private, the bot confirms identity, asks the configured questions,
   accepts attachments (stored as Telegram file IDs), and shows the terms.
3. The user types exactly `I accept`; the completed request is recorded and
   forwarded to the owner with a "Mark processed" action button.
4. The owner reviews pending requests and marks them processed from the
   Owner panel on `/start`.
