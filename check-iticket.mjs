#!/usr/bin/env node
/**
 * iTicket.az monitor: fetches the iTicket JSON API for 25.11.2026 and asks an
 * OpenCode Go model to decide whether a Sabah FK vs FC Barcelona event exists.
 * The model is the only decider; its answer is validated against the fetched
 * events before any Telegram message is sent.
 *
 * Modes:
 *   node check-iticket.mjs                     scheduled run (iTicket API + AI + Telegram)
 *   node check-iticket.mjs --self-test         offline checks of digest, verdict parsing, message
 *   node check-iticket.mjs --test-ai           one live AI call on a fixture list
 *   node check-iticket.mjs --test-telegram     verify Telegram secrets end to end
 *   TEST_EVENT_JSON='[...]' node check-iticket.mjs   offline check of provided event(s)
 */

import { readFileSync, writeFileSync } from "node:fs";

const LANG = "ru";
const TARGET_DATE = "25.11.2026";
const API_START_URL = `https://api.iticket.az/${LANG}/v6/events?client=web&start_date=${TARGET_DATE}&end_date=${TARGET_DATE}&page=1`;
const EVENTS_PAGE_URL = `https://iticket.az/${LANG}/events?start_date=${TARGET_DATE}&end_date=${TARGET_DATE}`;
const STATE_FILE = ".iticket-state.json";
const USER_AGENT = "iTicket-Monitor/1.0";
const REQUEST_TIMEOUT_MS = 25_000;
const AI_TIMEOUT_MS = 45_000;
const MAX_PAGES = 50;
const TIME_ZONE = "Asia/Baku";

// OpenCode Go gateway, Responses API surface (docs: dev.opencode.ai/docs/go).
// muse-spark-1.3-contributor is served only by /responses; /chat/completions returns HTTP 500.
const AI_ENDPOINT = "https://opencode.ai/zen/go/v1/responses";
const AI_MODEL = process.env.AI_MODEL || "muse-spark-1.3-contributor";
const AI_SESSION = "iticket-monitor-sabah-barcelona-25-11-2026";

const SYSTEM_PROMPT = [
  "You read an event list from iTicket.az, a ticket shop in Azerbaijan.",
  `Decide if the list holds a football match between Sabah and FC Barcelona on ${TARGET_DATE}.`,
  "",
  "A match is ONE event that contains BOTH clubs:",
  "- Sabah: \"Sabah FK\", \"Sabah FC\", \"Сабах\"",
  "- Barcelona: \"Barcelona\", \"FC Barcelona\", \"Барселона\"",
  "",
  "Rules:",
  "- Both clubs must occur in the same event. Check name, slug, and every other field.",
  "- Never combine two events. One event with only Sabah, plus another with only Barcelona, is not a match.",
  "- Ignore every unrelated event, even when a field holds the word Barcelona.",
  "",
  "Write the Telegram message for every match:",
  "- First line: the event name.",
  "- Then a blank line, then the line \"Tickets/event appeared on iTicket.\"",
  "- Then one line per known fact: \"Date: DD.MM.YYYY\", \"Time: HH:MM (Baku)\", \"Venue: ...\",",
  "  \"Price: <min>–<max> AZN\", \"Event ID: ...\". Show the date and time in Baku time (Asia/Baku).",
  "- Then a blank line, then the official event page link:",
  `  https://iticket.az/ru/events/<category>/<slug>, built from that event record.`,
  "- Take every fact from the event record. Omit an unknown fact. Never print undefined, null, or NaN.",
  "- Never invent a fact and never invent a link.",
  "",
  "Answer with JSON only. No prose, no code fences.",
  '{"match": true, "events": [{"id": 123, "message": "first line\\nsecond line"}], "reason": "one short sentence"}',
  'Use {"match": false, "events": [], "reason": "..."} when no such event exists.',
].join("\n");

const log = (message) => console.log(message);
const warn = (message) => console.error(message);

const redact = (value) => {
  let text = String(value?.message ?? value);
  for (const secret of [process.env.TELEGRAM_BOT_TOKEN, process.env.OPENCODE_API_KEY]) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text;
};

/* ---------- iTicket ---------- */

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }
}

async function fetchAllEvents() {
  const events = [];
  const visited = new Set();
  let url = API_START_URL;
  let page = 0;

  while (url) {
    page += 1;
    if (page > MAX_PAGES) throw new Error(`Pagination exceeded ${MAX_PAGES} pages`);
    if (visited.has(url)) throw new Error(`Pagination loop detected at page ${page}`);
    visited.add(url);

    log(`[CHECK] Fetching page ${page}`);
    const payload = await fetchJson(url);
    const paginator = payload?.response?.events;
    if (!paginator || !Array.isArray(paginator.data)) {
      throw new Error("Invalid API response: response.events.data is missing");
    }
    log(`[CHECK] Page ${page}: ${paginator.data.length} events`);
    events.push(...paginator.data);

    url = typeof paginator.next_page_url === "string" && paginator.next_page_url.trim()
      ? paginator.next_page_url.trim()
      : null;
  }

  log(`[CHECK] Total: ${events.length} events`);
  // A shifted date filter returns an empty list, which otherwise looks like "no match".
  if (events.length === 0) warn(`[WARN] API returned 0 events for ${TARGET_DATE}; verify the date filter still works`);
  return events;
}

/* ---------- AI decider ---------- */

// Flat digest: one short record per event keeps the prompt small and keeps the
// "both clubs in the same event" boundary visible to the model.
function buildDigest(events) {
  return events.map((event) => {
    const entry = { id: event?.id ?? null, name: event?.name ?? null, slug: event?.slug ?? null };
    if (event?.category_slug) entry.category = event.category_slug;
    if (event?.event_starts_at) entry.starts_at = event.event_starts_at;
    if (event?.min_price !== undefined && event?.min_price !== null) entry.min_price = event.min_price;
    if (event?.max_price !== undefined && event?.max_price !== null) entry.max_price = event.max_price;
    const venue = event?.venues?.[0]?.name;
    if (typeof venue === "string" && venue.trim()) entry.venue = venue.trim();
    return entry;
  });
}

// Accepts the model message only when it links this exact event page: a message
// without a usable link must not reach Telegram.
function aiMessage(message, event) {
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (!text || /undefined|\bnull\b|NaN/.test(text)) return null;
  const link = text.match(/https:\/\/(?:www\.)?iticket\.az\/\S+/)?.[0] ?? "";
  const slug = typeof event.slug === "string" ? event.slug : "";
  if (!slug || !link.includes("/events/") || !link.includes(slug)) return null;
  return text;
}

function parseVerdict(answer, events) {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("AI answer holds no JSON object");

  let verdict;
  try {
    verdict = JSON.parse(answer.slice(start, end + 1));
  } catch (error) {
    throw new Error(`AI answer is not valid JSON: ${error.message}`);
  }
  if (typeof verdict?.match !== "boolean") throw new Error('AI answer holds no boolean "match" field');
  if (verdict.match === false) return { match: false, matched: [] };

  const byId = new Map(events.map((event) => [String(event?.id), event]));
  const matched = [];
  for (const entry of Array.isArray(verdict.events) ? verdict.events : []) {
    const event = byId.get(String(entry?.id));
    if (!event) throw new Error(`AI named event ${entry?.id} which is not in the list`);
    matched.push({ event, message: aiMessage(entry?.message, event) });
  }
  if (matched.length === 0) throw new Error("AI reported a match but named no event from the list");

  return { match: true, matched, reason: typeof verdict.reason === "string" ? verdict.reason : "" };
}

// The Responses API puts the answer in output[].content[].text, after the reasoning items.
function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== "message") continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === "output_text" && typeof part.text === "string" && part.text.trim()) return part.text;
    }
  }
  return null;
}

async function askModel(events) {
  const apiKey = process.env.OPENCODE_API_KEY;
  if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");

  log(`[AI] Asking ${AI_MODEL} about ${events.length} events`);
  const response = await fetch(AI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "x-opencode-session": AI_SESSION,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      instructions: SYSTEM_PROMPT,
      input: `Events for ${TARGET_DATE} (JSON):\n${JSON.stringify(buildDigest(events))}`,
      // Go models are reasoning models: the answer needs headroom after the reasoning tokens.
      max_output_tokens: 2000,
    }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI HTTP ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`AI returned non-JSON response (HTTP ${response.status})`);
  }

  if (payload?.status === "incomplete") {
    throw new Error(`AI response is incomplete: ${JSON.stringify(payload.incomplete_details ?? {})}`);
  }

  const answer = extractOutputText(payload);
  if (!answer) throw new Error(`AI response holds no message text (status ${payload?.status ?? "unknown"})`);

  // The gateway reports cost as a numeric string, "0" for free models.
  const cost = Number(payload.cost);
  if (Number.isFinite(cost)) log(`[AI] Cost: ${cost}`);
  log(`[AI] Answer: ${answer.replace(/\s+/g, " ").trim()}`);
  return parseVerdict(answer, events);
}

/* ---------- telegram ---------- */

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Telegram API returned non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`Telegram API failed (HTTP ${response.status}): ${payload?.description ?? "unknown error"}`);
  }
}

/* ---------- alert text ---------- */

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function formatWhen(isoValue) {
  if (typeof isoValue !== "string") return {};
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return {};
  const parts = Object.fromEntries(dateTimeFormat.formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${parts.day}.${parts.month}.${parts.year}`, time: `${parts.hour}:${parts.minute}` };
}

function formatPrice(event) {
  const min = Number(event.min_price);
  const max = Number(event.max_price);
  const hasMin = event.min_price !== null && event.min_price !== undefined && event.min_price !== "" && Number.isFinite(min);
  const hasMax = event.max_price !== null && event.max_price !== undefined && event.max_price !== "" && Number.isFinite(max);
  if (!hasMin && !hasMax) return null;
  if (hasMin && hasMax) return min === max ? `${min} AZN` : `${min}–${max} AZN`;
  return `${hasMin ? min : max} AZN`;
}

function eventUrl(event) {
  if (typeof event.external_url === "string" && event.external_url.trim()) return event.external_url.trim();
  const slug = typeof event.slug === "string" ? event.slug.trim() : "";
  const category = typeof event.category_slug === "string" ? event.category_slug.trim() : "";
  if (slug && category) return `https://iticket.az/${LANG}/events/${category}/${encodeURIComponent(slug)}`;
  return EVENTS_PAGE_URL;
}

function buildMessage(event) {
  const lines = [String(event.name ?? "Sabah FK / FC Barcelona"), "", "Tickets/event appeared on iTicket."];
  const when = formatWhen(event.event_starts_at);
  const details = [];
  details.push(`Date: ${when.date ?? TARGET_DATE}`);
  if (when.time) details.push(`Time: ${when.time} (Baku)`);

  const venue = event.venues?.[0]?.name;
  if (typeof venue === "string" && venue.trim()) details.push(`Venue: ${venue.trim()}`);

  const price = formatPrice(event);
  if (price) details.push(`Price: ${price}`);

  const id = getEventId(event);
  if (id) details.push(`Event ID: ${id}`);

  lines.push("", ...details, "", eventUrl(event), EVENTS_PAGE_URL);
  return lines.join("\n");
}

function getEventId(event) {
  const id = event.id ?? event.slug;
  return id === null || id === undefined || id === "" ? null : String(id);
}

/* ---------- state ---------- */

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    const ids = Array.isArray(parsed?.notifiedEventIds) ? parsed.notifiedEventIds.map(String) : [];
    return { notifiedEventIds: [...new Set(ids)] };
  } catch (error) {
    // A reset loses dedupe history at worst, so a corrupt file must not stop the monitor.
    if (error.code !== "ENOENT") warn(`[WARN] Cannot read ${STATE_FILE} (${error.message}); starting empty`);
    return { notifiedEventIds: [] };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/* ---------- run ---------- */

async function notifyNewMatches(matched, state) {
  const notified = new Set(state.notifiedEventIds);
  for (const { event, message } of matched) {
    const id = getEventId(event);
    log(`[MATCH] ${event.name ?? id}`);
    if (!id) throw new Error("Matching event has no id or slug, cannot deduplicate");

    if (notified.has(id)) {
      log(`[CHECK] Event ${id} already notified, skipping`);
      continue;
    }

    if (!message) warn(`[WARN] AI message for event ${id} is missing or holds no iTicket event link; using the built-in template`);
    log(`[MATCH] ID: ${id} Date: ${event.event_starts_at ?? "unknown"}`);
    log("[ALERT] Sending Telegram notification");
    await sendTelegram(message ?? buildMessage(event));
    log("[ALERT] Telegram notification sent");

    notified.add(id);
    state.notifiedEventIds = [...notified];
  }
}

async function main() {
  const state = loadState();
  try {
    const events = await fetchAllEvents();
    const verdict = await askModel(events);
    if (!verdict.match) {
      log("[CHECK] No matching event");
      return;
    }
    if (verdict.reason) log(`[AI] Reason: ${verdict.reason}`);
    await notifyNewMatches(verdict.matched, state);
  } finally {
    saveState(state);
  }
}

/* ---------- self tests ---------- */

const MATCH_FIXTURE = {
  id: 999999,
  name: "Sabah FK - FC Barcelona",
  slug: "sabah-fk-fc-barcelona",
  category_slug: "sport",
  event_starts_at: "2026-11-25T17:00:00.000000Z",
  min_price: 20,
  max_price: 150,
  venues: [{ name: "Bakcell Arena" }],
};

const DECOYS = [
  { id: 1, name: "Sabah FK - Qarabağ FK", slug: "sabah-fk-qarabag-fk", category_slug: "sport" },
  { id: 2, name: "FC Barcelona - Real Madrid", slug: "fc-barcelona-real-madrid", category_slug: "sport" },
  { id: 3, name: "Ромео и Джульетта - Барселонский балет фламенко", slug: "romeo-and-juliet-barcelona-flamenco-ballet-rn26", category_slug: "concerts" },
];

function runSelfTest() {
  let failures = 0;
  const check = (title, actual, expected) => {
    const got = JSON.stringify(actual);
    const want = JSON.stringify(expected);
    if (got === want) {
      log(`[TEST] OK   ${title}`);
    } else {
      failures += 1;
      warn(`[TEST] FAIL ${title}: expected ${want}, got ${got}`);
    }
  };
  const throws = (title, fn) => {
    try {
      fn();
      failures += 1;
      warn(`[TEST] FAIL ${title}: expected an error`);
    } catch {
      log(`[TEST] OK   ${title} (rejected)`);
    }
  };

  const digest = buildDigest([MATCH_FIXTURE, { id: 4, name: null, slug: null }]);
  check("digest keeps id/name/slug/venue", digest[0], {
    id: 999999, name: "Sabah FK - FC Barcelona", slug: "sabah-fk-fc-barcelona",
    category: "sport", starts_at: "2026-11-25T17:00:00.000000Z",
    min_price: 20, max_price: 150, venue: "Bakcell Arena",
  });
  check("digest omits empty fields", digest[1], { id: 4, name: null, slug: null });

  check("output_text passthrough", extractOutputText({ output_text: "hi" }), "hi");
  check("responses message part", extractOutputText({
    output: [{ type: "reasoning", encrypted_content: "…" }, { type: "message", content: [{ type: "output_text", text: '{"match":false}' }] }],
  }), '{"match":false}');
  check("reasoning only yields no text", extractOutputText({ output: [{ type: "reasoning" }] }), null);
  check("empty payload yields no text", extractOutputText({}), null);

  const all = [MATCH_FIXTURE, ...DECOYS];
  const link = "https://iticket.az/ru/events/sport/sabah-fk-fc-barcelona";
  const goodMessage = `Sabah FK - FC Barcelona\n\nTickets/event appeared on iTicket.\n\nDate: 25.11.2026\n\n${link}`;
  const verdict = (message) => parseVerdict(JSON.stringify({ match: true, events: [{ id: 999999, message }] }), all);

  check("verdict carries the model message", verdict(goodMessage).matched[0].message, goodMessage);
  check("verdict accepted from fences", parseVerdict(`\`\`\`json\n${JSON.stringify({ match: true, events: [{ id: 999999, message: goodMessage }] })}\n\`\`\``, all).matched.length, 1);
  check("no-match verdict", parseVerdict('{"match": false, "events": []}', all).match, false);
  check("prose around verdict", parseVerdict('Sure! {"match": false, "events": []} done', all).match, false);
  check("message without a link is dropped", verdict("Sabah FK - FC Barcelona").matched[0].message, null);
  check("message linking another event is dropped", verdict(`x\nhttps://iticket.az/ru/events/sport/fc-barcelona-real-madrid`).matched[0].message, null);
  check("message with a non-iTicket link is dropped", verdict("x\nhttps://example.com/sabah-fk-fc-barcelona").matched[0].message, null);
  check("message with null text is dropped", verdict("Date: null\nhttps://iticket.az/ru/events/sport/sabah-fk-fc-barcelona").matched[0].message, null);
  check("non-string message is dropped", verdict(42).matched[0].message, null);
  throws("match naming an unknown event", () => parseVerdict('{"match": true, "events": [{"id": 42}]}', all));
  throws("match with no events", () => parseVerdict('{"match": true, "events": []}', all));
  throws("missing match field", () => parseVerdict('{"events": []}', all));
  throws("non-JSON answer", () => parseVerdict("I could not read the list", all));

  const message = buildMessage(MATCH_FIXTURE);
  const clean = !/undefined|null|NaN/.test(message);
  check("message is clean", clean, true);
  log(`[TEST] Sample message:\n${message}`);

  log(failures === 0 ? "[TEST] All checks passed" : `[TEST] ${failures} check(s) failed`);
  return failures === 0;
}

async function runOfflineCheck(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`TEST_EVENT_JSON is not valid JSON: ${error.message}`);
  }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  log(`[CHECK] Offline check of ${events.length} provided event(s)`);
  const verdict = await askModel(events);
  if (!verdict.match) {
    log("[CHECK] No matching event");
    return;
  }
  for (const { event, message } of verdict.matched) {
    log(`[MATCH] ${event.name ?? getEventId(event)}`);
    log(`[TEST] Would send:\n${message ?? buildMessage(event)}`);
  }
}

async function runAiTest() {
  log("[TEST] Live AI check on fixtures: 1 match and 3 decoys");
  const verdict = await askModel([MATCH_FIXTURE, ...DECOYS]);
  const first = verdict.matched?.[0];
  if (!verdict.match || verdict.matched.length !== 1 || first.event.id !== MATCH_FIXTURE.id) {
    throw new Error(`AI test failed: ${JSON.stringify(verdict)}`);
  }
  if (!first.message) throw new Error("AI test failed: the returned message holds no usable iTicket event link");
  log(`[TEST] AI message:\n${first.message}`);
  log("[TEST] AI found the fixture match, wrote the message, and linked the event page");
}

/* ---------- entry point ---------- */

try {
  const mode = process.argv[2];
  if (mode === "--self-test") {
    if (!runSelfTest()) process.exitCode = 1;
  } else if (mode === "--test-ai") {
    await runAiTest();
  } else if (mode === "--test-telegram") {
    log("[ALERT] Sending Telegram test notification");
    await sendTelegram(`iTicket monitor test message (${new Date().toISOString()})`);
    log("[ALERT] Telegram notification sent");
  } else if (process.env.TEST_EVENT_JSON) {
    await runOfflineCheck(process.env.TEST_EVENT_JSON);
  } else {
    log("[CHECK] Starting iTicket check");
    await main();
  }
} catch (error) {
  warn(`[ERROR] ${redact(error)}`);
  process.exitCode = 1;
}
