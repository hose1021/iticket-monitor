# iTicket monitor — Sabah FK vs FC Barcelona (25.11.2026)

Checks the iTicket JSON API every 5 minutes, gives the event list to an **OpenCode Go
model**, and sends one Telegram message when that model finds a Sabah FK vs FC Barcelona
event. No browser, no scraping, no npm dependencies — Node 22 built-ins only.

## Files

- `check-iticket.mjs` — fetch + AI verdict + Telegram.
- `.github/workflows/check-iticket.yml` — cron `*/5 * * * *` + `workflow_dispatch`.

## Setup

1. Push this folder as the root of a GitHub repository (**public** recommended, see Cost).
2. Sign in at <https://dev.opencode.ai/auth>, subscribe to **OpenCode Go**, copy the API key.
3. Add three repository secrets (Settings → Secrets and variables → Actions):
   - `OPENCODE_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. Run the workflow once from the Actions tab (**Run workflow**) to verify.

### Get TELEGRAM_CHAT_ID

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, copy the token.
2. Send any message to your bot (or add the bot to a group and send a message there).
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `result[0].message.chat.id`
   (groups give a negative id, e.g. `-1001234567890`).

The token appears in that URL — do not share it.

## How it works

1. `fetchAllEvents()` reads `https://api.iticket.az/ru/v6/events?client=web&start_date=25.11.2026&end_date=25.11.2026&page=1`
   and follows `response.events.next_page_url` until `null` (max 50 pages, repeated-URL loop guard).
2. `buildDigest()` reduces every event to `id, name, slug, category, starts_at, min_price,
   max_price, venue`. One flat record per event keeps the "both clubs in the same event"
   boundary visible to the model.
3. `askModel()` posts the digest to the OpenCode Go gateway:

   | Item | Value |
   |---|---|
   | Endpoint | `https://opencode.ai/zen/go/v1/responses` |
   | Model | `muse-spark-1.3-contributor` (override with `AI_MODEL`) |
   | Auth | `Authorization: Bearer $OPENCODE_API_KEY` |
   | Identity | `User-Agent: iTicket-Monitor/1.0`, `x-opencode-session` (both required by the Go docs) |

   The answer arrives in `output[].content[].text`, after the reasoning items; the gateway
   reports its own cost per call, which the run logs.

   The model must answer JSON only:

   ```json
   {"match": true, "events": [{"id": 123, "message": "…Telegram text…"}], "reason": "one sentence"}
   ```

   The prompt orders the model to write the Telegram message for every match: event name
   first, the line `Tickets/event appeared on iTicket.`, then the known facts (date and time
   in Baku, venue, price in AZN, event ID), then a blank line and the official event page
   link `https://iticket.az/ru/events/<category>/<slug>` built from that event record.
4. `parseVerdict()` validates the answer. `match` must be a boolean and every named `id`
   must exist in the fetched list; anything else — HTTP error, prose instead of JSON, a match
   naming no listed event — stops the run with exit code 1. The monitor never reports
   "no match" when the model answer is unusable.
5. `aiMessage()` accepts the model message only when it is non-empty, free of
   `undefined`/`null`/`NaN`, and carries an `iticket.az` link that contains **that event's
   slug** — so a model message can neither arrive without an event page link nor point at a
   different event. When the message fails that check, the run logs a warning and sends the
   built-in template (API facts plus the derived event link) instead of failing the alert.
6. A match is notified once per event ID.

### Swapping the model

`AI_MODEL` accepts any OpenCode Go model served by the Responses API — verified live with
`muse-spark-1.3-contributor` (free on Go), which also fits `gpt-5.6-luna`, `grok-4.6`, and
`deepseek-v4-flash`. Models served only by the chat-completions surface (`glm-5.3-flash`,
`kimi-k2.7-code`, `minimax-m3`, `qwen3.8-max`, …) need `AI_ENDPOINT` pointed at
`/chat/completions` plus a `choices[0].message.content` reader.

## Duplicate notifications

One Telegram message per event ID, ever. State lives in `.iticket-state.json`:

```json
{ "notifiedEventIds": ["999999"] }
```

GitHub Actions caches are immutable per key, so the workflow restores the newest entry via
the `iticket-notified-` prefix and saves each run under the unique key
`iticket-notified-${{ github.run_id }}`. An ID is written only **after** Telegram returns
`ok: true`; a failed send stays unnotified and is retried on the next run. `concurrency`
with `cancel-in-progress` prevents two runs from notifying in parallel.

## Manual runs

- Actions → *iTicket Sabah - Barcelona monitor* → **Run workflow** (real API, real AI, real secrets).
- Offline checks: `node check-iticket.mjs --self-test` (digest, verdict parsing, message text).
- Live AI check on fixtures: `OPENCODE_API_KEY=... node check-iticket.mjs --test-ai`
- Own events through the AI: `TEST_EVENT_JSON='[{"id":1,"name":"Sabah FK - FC Barcelona"}]' OPENCODE_API_KEY=... node check-iticket.mjs`
- Verify Telegram secrets: `TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node check-iticket.mjs --test-telegram`

Exit codes: `0` for no match, for a notified match, and for an already-notified match;
`1` for iTicket API errors, AI errors, and Telegram errors.

## Cost

- Public repository: GitHub Actions minutes are free. On a **private** repository the
  5-minute schedule bills roughly 288 job-minutes per day (~8600/month), far above the 2000
  free minutes.
- Go is a $10/month subscription with monthly usage limits per model. One call per run plus
  a short answer is a small fraction of the `glm-5.3-flash` limit, but the schedule adds up
  to about 8,600 calls per month.
- The Go docs state that traffic is monitored for abuse and that clients should send typical
  coding-agent traffic. A 5-minute JSON classification loop is not coding-agent traffic —
  reduce the interval or add a cheap pre-filter if the key is rate-limited.

## Caveats

- **The model decides and writes.** A wrong "no match" answer means a missed drop, and the
  alert text is model-authored. The prompt restricts it to facts in the record, and a message
  without a link to that exact event page is replaced by the built-in template, but recall
  and wording are the model's, not a string check's.
- GitHub delays scheduled runs under load; `*/5` is a request, not a guarantee.
- Scheduled workflows are disabled after 60 days without repository activity — a repo with no
  commits may stop monitoring before 25.11.2026.
