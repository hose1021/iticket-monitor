# iTicket monitor — Sabah FK vs FC Barcelona (25.11.2026)

Checks the iTicket JSON API every 5 minutes. A local name filter decides whether the list is
worth an AI call; when it is, an **OpenCode Go model** reads the event list and decides whether
a Sabah FK vs FC Barcelona event exists. On a match the monitor sends one Telegram message per
event ID. A monthly keepalive commit stops GitHub from disabling the schedule.

No browser, no scraping, no npm dependencies — Node 22 built-ins only.

## Files

- `check-iticket.mjs` — fetch, filter, AI verdict, Telegram.
- `.github/workflows/check-iticket.yml` — the monitor, cron `*/5 * * * *` + `workflow_dispatch`.
- `.github/workflows/keepalive.yml` — monthly commit, cron `0 3 1 * *` + `workflow_dispatch`.

## Setup

1. Push this folder as the root of a GitHub repository (**public**, see Cost).
2. Sign in at <https://dev.opencode.ai/auth>, subscribe to **OpenCode Go**, copy the API key.
3. Add three repository secrets (Settings → Secrets and variables → Actions):
   - `OPENCODE_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. Run the workflow once from the Actions tab (**Run workflow**) to verify.

### Get TELEGRAM_CHAT_ID

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. Send `/start` to your bot (Telegram bots cannot open a chat first).
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[0].message.chat.id`
   (groups give a negative id, e.g. `-1001234567890`).

The token appears in that URL — do not share it.

## How it works

1. `fetchAllEvents()` reads
   `https://api.iticket.az/ru/v6/events?client=web&start_date=25.11.2026&end_date=25.11.2026&page=1`
   and follows `response.events.next_page_url` until `null` (max 50 pages, repeated-URL guard).
2. `scanCandidates()` collects every string value of every event, normalizes it (lowercase,
   non-letter runs to `-`) and looks for whole-token names:
   - Sabah: `sabah fk`, `sabah fc`, `сабах`
   - Barcelona: `barcelona`, `барселона`

   Hyphen sentinels keep the match exact, so `sabah-fkx` and `Barcelonax` do not count. Events
   are examined one by one and never combined.
3. The AI is called only when some event names Sabah **and** some event names Barcelona —
   otherwise a match is impossible and the run ends in about a second with no AI cost.
4. `askModel()` posts a compact digest (`id, name, slug, category, starts_at, min_price,
   max_price, venue` per event) to the OpenCode Go gateway:

   | Item | Value |
   |---|---|
   | Endpoint | `https://opencode.ai/zen/go/v1/responses` |
   | Model | `muse-spark-1.3-contributor` (override with `AI_MODEL`) |
   | Auth | `Authorization: Bearer $OPENCODE_API_KEY` |
   | Identity | `User-Agent: iTicket-Monitor/1.0`, `x-opencode-session` (both required by the Go docs) |

   The answer arrives in `output[].content[].text`, after the reasoning items. The model must
   answer JSON only:

   ```json
   {"match": true, "events": [{"id": 123, "message": "…Telegram text…"}], "reason": "one sentence"}
   ```

   The prompt orders the model to write the Telegram message for every match: event name first,
   the line `Tickets/event appeared on iTicket.`, then the known facts (date and time in Baku,
   venue, price in AZN, event ID), then a blank line and the event page link
   `https://iticket.az/ru/events/<category>/<slug>` built from that record.
5. `parseVerdict()` validates the answer. `match` must be a boolean and every named `id` must
   exist in the fetched list; anything else — HTTP error, prose instead of JSON, a match naming
   no listed event — stops the run with exit code 1. The monitor never reports "no match" when
   the model answer is unusable.
6. `aiMessage()` accepts the model message only when it is non-empty, free of
   `undefined`/`null`/`NaN`, and carries an `iticket.az` link containing **that event's slug**.
   Otherwise the run logs a warning and sends the built-in template.
7. **Safety net:** if the model answers `match: false` while an event names both clubs, the
   answer is not trusted — the built-in template is sent, with a warning in the log.
8. A match is notified once per event ID.

### Swapping the model

`AI_MODEL` accepts any OpenCode Go model served by the Responses API — verified live with
`muse-spark-1.3-contributor` (free on Go), which also fits `gpt-5.6-luna`, `grok-4.6`, and
`deepseek-v4-flash`. Models served only by the chat-completions surface (`glm-5.3-flash`,
`kimi-k2.7-code`, `minimax-m3`, `qwen3.8-max`, …) need `AI_ENDPOINT` pointed at
`/chat/completions` plus a `choices[0].message.content` reader.

## State

`.iticket-state.json`, carried between runs by a rolling Actions cache:

```json
{
  "notifiedEventIds": ["999999"],
  "lastError": { "signature": "ai http internal server error", "sentAt": "2026-09-11T10:31:00.000Z" }
}
```

- `notifiedEventIds` — one Telegram message per event ID, ever. An ID is written only **after**
  Telegram returns `ok: true`; a failed send stays unnotified and is retried on the next run.
- `lastError` — the last reported failure, used to send one failure alert per distinct error per
  6 hours instead of one per run.

Caches are immutable per key, so the workflow restores the newest entry through the
`iticket-notified-` prefix and saves each run under `iticket-notified-${{ github.run_id }}`.
`concurrency` with `cancel-in-progress` stops two runs from notifying at once.

## Alerting

- **Match** — the model message, or the built-in template when the model message is unusable.
- **Failure** — any error exits 1 and sends `iTicket monitor failed` with the error text to
  Telegram, at most once per distinct error per 6 hours.

## Manual runs

- Actions → *iTicket Sabah - Barcelona monitor* → **Run workflow**.
- Offline checks: `node check-iticket.mjs --self-test` (filter, digest, verdict parsing, message,
  failure cooldown).
- Live AI check on fixtures: `OPENCODE_API_KEY=... node check-iticket.mjs --test-ai`
- Own events through the AI:
  `TEST_EVENT_JSON='[{"id":1,"name":"Sabah FK - FC Barcelona"}]' OPENCODE_API_KEY=... node check-iticket.mjs`
- Verify Telegram secrets: `TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node check-iticket.mjs --test-telegram`

Exit codes: `0` for no match, a notified match, and an already-notified match; `1` for iTicket
API errors, AI errors, and Telegram errors.

## Keepalive

GitHub disables `schedule` workflows in a public repository after 60 days without repository
activity, and a workflow's own runs do not count. `keepalive.yml` commits a timestamp on the
first of every month, which keeps the repository active through 25.11.2026. Without it the
monitor would stop around 10.11.2026.

## Cost

- Public repository: Actions minutes are free. On a **private** repository the 5-minute schedule
  bills roughly 288 job-minutes per day (~8,900/month) because each job rounds up to a whole
  minute — that exceeds the Free plan's 2,000 and costs about $47/month on Pro. On a private
  repository use `*/25` (Free) or `*/15` (Pro).
- AI: the filter keeps most runs free of AI calls, so the monthly call count depends on how often
  a Sabah name and a Barcelona name coexist in the list. `muse-spark-1.3-contributor` is free on
  Go and reports `Cost: 0`.

## Caveats

- **The model decides and writes.** The filter and the safety net protect against a missed match
  and a message without a link, but the final verdict is the model's.
- GitHub delays scheduled runs under load; `*/5` is a request, not a guarantee.
