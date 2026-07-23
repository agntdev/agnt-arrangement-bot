# Arrangement Request Manager — Bot specification

**Archetype:** workflow

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot that handles sensitive arrangement requests in groups by migrating conversations to private chats, collecting structured data with terms acceptance, and forwarding completed requests to a single owner account for action. Maintains privacy by keeping all detailed collection in 1:1 chats.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Telegram group members
- Bot owner

## Success criteria

- All arrangement requests are fully captured in private chats with terms acceptance
- Owner receives structured notifications with all required data
- Group interactions remain clean with no sensitive info exposure

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu or re-initiate flow
- **/arrange** (command, actor: user, command: /arrange) — Trigger arrangement flow in group chat
  - inputs: Arrangement keyword in message text
  - outputs: Private chat invitation
- **Continue in private** (button, actor: user, callback: private:start) — Initiate private arrangement flow from group prompt
  - inputs: User identity confirmation
  - outputs: Arrangement question set

## Flows

### Group trigger handling
_Trigger:_ Message contains 'Arrangement' or /arrange command

1. Detect trigger in group message
2. Send inline button to private chat
3. Track request initiation

_Data touched:_ Arrangement request

### Private chat onboarding
_Trigger:_ User clicks 'Continue in private'

1. Identity confirmation
2. Sequential question collection
3. Attachment handling

_Data touched:_ Arrangement request, Terms acceptance

### Terms acceptance
_Trigger:_ After question collection

1. Display terms text
2. Wait for 'I accept' message
3. Record exact response and timestamp

_Data touched:_ Terms acceptance

### Owner notification
_Trigger:_ User confirms final arrangement

1. Format complete request
2. Send to owner with action buttons
3. Mark as pending

_Data touched:_ Owner notifications

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Arrangement request** _(retention: persistent)_ — Complete user request with all collected data
  - fields: requester, timestamp, status, question_answers, acceptance_record, attachments
- **Terms acceptance** _(retention: persistent)_ — Record of terms display and user acceptance
  - fields: terms_text, user_response, acceptance_timestamp
- **Owner notification** _(retention: persistent)_ — Status tracking for owner actions
  - fields: request_reference, notification_timestamp, status

## Integrations

- **Telegram** (required) — Group monitoring and private chat interaction
- **Telegram** (required) — Owner notifications and action buttons
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure question set
- Set terms text
- View and mark requests as processed

## Notifications

- Owner receives new arrangement notifications with action buttons
- Users receive confirmation of successful submission

## Permissions & privacy

- All sensitive data collected in private 1:1 chats only
- Attachments stored as Telegram file references only
- No third-party data storage

## Edge cases

- User abandons flow mid-process
- Invalid responses to required fields
- Multiple arrangement triggers from same user

## Required tests

- End-to-end flow from group trigger to owner processing
- Terms acceptance exact text validation
- Attachment handling in private chat

## Assumptions

- Single owner account is sufficient for current needs
- Default question set covers basic requirements
- Users will engage in private chat when prompted
