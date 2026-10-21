# dsh-agent-checkin

> Daily check-in aggregation and model wiring for DeepSeek Harness — one plugin, two jobs.

English | [中文](README-zh.md) | [Español](README-es.md) | [Português](README-pt.md) | [हिन्दी](README-hi.md)

## What it does

This plugin connects the AI clients you already have installed to DeepSeek Harness (DSH) in three ways:

1. **Check-in aggregation** — runs one check-in round across every supported platform, then
   reports each platform's result *and* its live credit balance in a single place.
2. **Local clients as model providers** — reads the model catalog of the AI clients already signed
   in on this machine (TRAE, Qoder CN, WorkBuddy, Baidu DuMate, WPS Lingxi) and registers them as
   providers, so their models appear in the model picker and can be used in chat.
3. **Model wiring** — takes an OpenAI-compatible or Anthropic-compatible endpoint and registers
   it as a provider route inside DSH.

All three read from the same set of local clients. The balances in the dashboard and the models
in the picker belong to the same accounts.

The **token usage panel** is a fourth, independent surface: it reads DSH's own session logs and
reports how many tokens each provider and model has consumed, and at the bottom gives a **model
leaderboard with task recommendations** (capability scores from a public board; "which models exist"
from this machine only). It touches none of the above — see
[The token usage panel](#the-token-usage-panel).

> **Completion status (2026-10-19, v0.8.0).** ① Check-in aggregation is **done and working**.
> ② Local-client model wiring is **fixed and expanded to five platforms** — TRAE (CN/global),
> Qoder CN, WorkBuddy (CN/global), Baidu DuMate, and WPS Lingxi all share the `lib/connect/`
> five-layer architecture (local credentials → model catalog → loopback shim → PiAiAdapter →
> registration); pick the platforms and the models per platform under **Settings → Check-in
> aggregation → Platforms & models**, and the change applies on save with no restart.
> ③ The **token usage panel is done** — a "Token usage" entry in the sidebar reads DSH's own
> session logs and breaks token consumption, call counts and cache hit rates down by provider and
> model (with a trend, a by-provider donut, a ranking, and a detail table), plus a credit-balance
> badge for the current provider on the left of the composer. At the bottom of that same panel there
> is also a **model leaderboard with recommendations by task type** (capability scores from the
> public Artificial Analysis / OpenRouter board; "which models exist" from the local catalog and
> your own selections only — **being listed does not mean you are subscribed**).
> ④ The `modelRoutes` half works, but supports static `apiKeyEnv` only and has no `headers`
> support; the current profile declares no routes.
>
> **PhanthyWork is not wireable (measured).** Its reverse-proxy port 3456 never listens, and the
> real credentials live only in the main process's memory, so there is no bypass.

## Requirements

- DSH `0.2.x`.
- Python 3.9+ on `PATH` (only for the check-in half).
- Node 22.19+ or 24+ with the built-in `node:sqlite` module (only for `traeProvider`).
- The engine itself is **bundled** in this package under `engine/` — nothing extra to install.
  If you keep your own checkout of the engine, point `homeDir` at it instead.

## Installation

```bash
dsh plugin install ./dsh-agent-checkin
```

Or add it to a profile manually:

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- insert:
    - id: dsh-agent-checkin
      name: dsh-agent-checkin
```

## Usage

### Checking in

| Surface | How |
| --- | --- |
| Command | `/checkin` — one round across all platforms |
| Command | `/checkin trae,dumate` — only the listed platforms |
| Command | `/checkin --force` — ignore the same-day idempotency guard and claim again |
| Command | `/checkin-status` — show the previous round without re-running |
| Tool | `checkin_run` — the same thing, callable by the agent |
| Settings panel | the "Run check-in now" button — one click runs a round and shows per-platform results |
| HTTP | `GET /dsh-agent-checkin/status` — JSON snapshot for a dashboard |
| Browser | `GET /dsh-agent-checkin` — human-readable dashboard |

**Nothing is claimed by default.** The plugin ships with `allowClaim: false`, which forces every
run into read-only mode. A check-in that actually changes an account balance is a real-world
action, so it must be switched on deliberately:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    allowClaim: true
```

You can also flip it from the host's **plugin settings panel** — `allowClaim`, `pythonCommand`,
`homeDir`, `timeoutMs` and `pushResult` are hot-reloadable, so a change takes effect on the very
next run without restarting the host.

The claiming switch in that panel is genuinely wired up: it writes the new value back to your
profile's `cordis.patch.yml` through the host `configEditor` service (file lock, validation, atomic
write, rollback on failure), and the volatile hot-commit described above makes the running instance
read the new value immediately. One click is enough — no hand-editing YAML, no restart. If the write
fails the panel shows the server's real reason rather than a fake success, and if the value was
already what you asked for it says so instead of claiming it saved something.

### The dashboard

Open `http://127.0.0.1:<port>/dsh-agent-checkin` in a browser on the same machine. It is served only on
the loopback interface: any request whose `Host` or `Origin` is not a loopback address gets a 403,
so another local app (or a page reached through DNS rebinding) cannot read your balances.

The page follows the same honesty rules as the command output:

- **Read-only is stated up front.** With `allowClaim: false` the top of the page says the round
  claimed nothing.
- **Read-only platforms are a separate section.** Platforms with no claim endpoint are never
  counted as "check-in succeeded", because there was no such action.
- **There is no cross-platform total.** Points, credits and 灵感值 are different currencies; adding
  them produces a number that means nothing. The page says so instead of showing one.
- **Unknown balances show `—`, not `0`.** Zero is a reading; "could not read it" is not.
- **What was read gets shown.** Each platform keeps its usable balance under a different field name
  (QwenWork under a sum of three wallet tiers, TRAE and WorkBuddy CN under `total_credits`).
  Normalisation lives in the engine's `bridge.py`; the plugin repeats it defensively, so balances
  still render if you point `homeDir` at your own copy of the engine without that patch.
- **Every number is labelled by origin** — live this round, loaded from the state file, or absent.
- **Platform risks are listed.** Device fingerprinting notes and similar caveats appear at the
  bottom instead of living only in source comments.

The JSON endpoint at `/dsh-agent-checkin/status` returns the same data for scripts.

### The token usage panel

At the bottom of the settings sidebar, after the built-in sections, there is another entry:
**Token usage**. It is not inside the settings panel — it is a standalone main-area panel that opens
when you click that sidebar icon.

The panel counts model consumption across **every session in every workspace on this machine**,
sourced from DSH's own session logs (`$DSH_HOME/sessions/`), not from this plugin's check-in results.
It is therefore completely independent of the check-in half: it works without checking in, and a
failed check-in does not affect it.

- **Seven stat cards**: total, today, last 7 days, and call count, plus cache hit, cache miss, and
  cache hit rate. The call-count card's sub-label also reports "N providers · M models" — **the
  provider count is not the model count**; one provider often carries dozens of models, and
  reporting the two separately keeps "11 providers wired" from being misread as "only 11 models".
- **What the three cache figures mean** (spelled out on the cards and here): **hit = `cacheRead`**;
  **miss = `input + cacheWrite`**; **hit rate = hit ÷ (input + hit + write)**. The denominator
  **excludes output** — output tokens are never cache candidates, and counting them would flatter
  the rate for free. When the denominator is zero the card shows `—`, **not 0%**: 0% is a reading,
  "there is no denominator to compute from" is not. These three are on the same basis as "total"
  (all time) and do not follow the window — a per-window figure would require the backend's daily
  buckets to carry all four segments, which is a separate piece of work.
- **Switchable window**: 7 / 30 / 90 days / all. Switching only changes what is displayed; it does
  not rescan — the scanner buckets all history in one pass, and the window is cut over the result.
- **Three charts side by side on one row**: usage trend (switchable between daily and cumulative),
  a by-provider donut (top 6), and top models (top 8). The trend chart is sized for a one-third
  column (a 360-wide coordinate space, not the earlier 640 — at 640 the right-hand tick labels
  became unreadable in a third of the width).
- **Sources table**: one row per provider/model pair, with the four token segments, the call count,
  and three efficiency columns computed on the spot from that same data — **hit rate**,
  **per-call cost** (total ÷ calls), and **output share** (output ÷ total). The last two separate
  "expensive but finishes in one shot" from "cheap but goes back and forth".
- **The footer reports the scan cost honestly**: how many session files, how many MB, how many were
  rescanned this time, how many billed messages, and how many milliseconds. **A scan cut short by
  the timeout says so** rather than passing half the data off as a complete result.

The HTTP endpoint `GET /dsh-agent-checkin/usage` returns the same data for scripts:

| Parameter | Meaning |
| --- | --- |
| `days=7` | Window in days. Omit for the default; `3650` means "all" |
| `refresh=1` | Bypass the in-memory cache and rescan |

The endpoint shares the plugin's usual guards: loopback requests only (anything else gets a 403),
`GET` / `HEAD` only, and `cache-control: no-store` on every response — "it still shows the old
numbers right after I refreshed" is the failure mode that destroys trust in a panel like this.

#### How the numbers are computed

This deserves spelling out, because it ran into four traps that **silently compute the wrong answer**:

- **A session log is multi-frame zstd, not a single frame.** Measured: one `session.v4.jsonl.zstd`
  holds **12,829** independent zstd frames back to back; calling `zstdDecompressSync` directly
  decompresses only the first frame and **silently drops the other 99%**, without an error. The
  scanner therefore splits the stream frame by frame (finding boundaries by the zstd magic
  `0xfd2fb528`) and decompresses each one.
- **`assistant/attempt` usage is a duplicate.** A single call records its usage twice, once on
  `attempt` (where it appears only under `data.stream[].chunk.usage`) and once on `message` (the
  final `data.usage`), and the two are the same figure; counting both would double the total out of
  nowhere. The scanner counts **`assistant/message` only**, and uses `attempt` for de-duplication
  and correlation, never for totals.
- **The `totalTokens` field follows an older definition.** It equals `inputTokens + outputTokens +
  cacheReadTokens + cacheWriteTokens` (checked against 8,129 records: 7,952 matched exactly, and the
  remaining 177 were older records missing `cacheWriteTokens`), whereas the real "billed input" is
  `input + cacheRead + cacheWrite`. Everything displayed is therefore **summed from the four
  segments** rather than read from that ready-made field — it cannot be trusted to stay current.
- **When several versions of the same session exist, only the highest is read**
  (`session.v4.jsonl` alongside `session.jsonl`); otherwise the same usage is counted twice.

#### Incremental cache

Logs only grow, so the cache is "in-memory snapshot + per-file invalidation": each session file's
`size:mtime` is recorded, and only the files that changed are rescanned. Measured on 44 files and
9,333 billed messages: a cold scan takes about 1.5 s, a warm scan about 150 ms.

The cache TTL is the `usageCacheSeconds` config key (default 30 seconds). The panel's **Refresh**
button always bypasses the cache; this value only affects automatic polling and other callers.
**No database is introduced**: 43 logs / 48 MB scan cold in 1.3 s, logs only grow, and an in-memory
cache already brings routine refreshes down to single-digit milliseconds — SQLite would only add a
copy that needs migrating and reconciling against the logs.

#### The composer balance badge

The left side of the composer (`conversation.input.left`) also shows **the credit balance of the
provider that the currently referenced agent uses**. What matters most here is **not lying**:

- **It renders only when the platform really has a "credit balance" concept** (WorkBuddy, for
  instance). Post-paid, token-billed platforms have no such thing, and hard-coding a number would be
  a lie — so in that case **the whole badge is not rendered** and **no polling is started**.
- **An unknown balance means the badge does not appear at all**, rather than showing `0`. Zero is a
  reading; "could not read it" is not.
- **Hovering shows the origin**: whether the number is measured or hand-entered is in the `title`,
  and the two are never conflated.
- **Polling is sparse**: balances change by the day, so once a minute is already far more than
  needed.
- **Coexistence with `dsh-connect-workbuddy`**: the legacy plugin also occupies this slot (order 4,
  rendering only for its own provider); this plugin uses order 5 right after it, and the two stay
  apart by only recognising providers they know, so two badges never appear at once.

#### The panel's error boundary

The usage panel is wrapped in a React error boundary (a class component — `getDerivedStateFromError`
is class-only and has no function-component equivalent). **Why it is required**: if a component in
the `main` slot throws during render, the host renders the whole panel blank or falls back, and
**the user cannot see that error line in the browser console** (the desktop build has no devtools
entry point) — the symptom is "I clicked the sidebar button and nothing happened". With this
boundary the same failure becomes a red line on the page, and the user can read the reason straight
to the maintainer.

The ranking section **has its own** boundary on top of that: failing to reach the leaderboard must
not blank out the usage statistics above it, since the two fail for entirely unrelated reasons.

#### The model leaderboard and task recommendations

At the very bottom of the panel there is one more block: the **model leaderboard**, plus
recommendations by task type. It is assembled from two halves whose origins are kept strictly apart:

- **Capability scores come from a public leaderboard** — Artificial Analysis' intelligence, coding
  and agentic indices, fetched through OpenRouter's public API
  (`https://openrouter.ai/api/v1/models`, no auth). **This plugin estimates no score of its own**:
  the local client catalog carries only an id, a name, a multiplier and whether images are
  supported — **no quality dimension at all** — so guessing strength from names would be fabrication.
- **"Which models exist" comes only from this machine** — only models actually present in the local
  client catalog (for the region you are signed in to), after your platform/model selections are
  applied. Anything the leaderboard lists but the local catalog does not is excluded: the ranking is
  for "what can I use right now", not for "what exists in the world".

**One thing that must be stated plainly**: the client catalog is a **product roster and is not
filtered by account entitlement**. Measured on an unsubscribed `workbuddy-global` account, the
catalog still lists `gpt-6-astra` / `gpt-5.4` and the rest of the GPT family. So **being listed here
does not by itself mean your account may call it** — that sentence is printed on the panel verbatim,
and the panel does not pretend the ranking equals entitlement. It also cannot determine subscription
automatically: none of the platform catalogs carry **any entitlement field** (grepping the WorkBuddy
catalog for `vip|subscrib|entitle|tier|quota` hits only a comment about a free model). When a model
really cannot be called, the platform's own error surfaces as usual — that is the authoritative signal.

What the panel shows:

- **Overall board**: by intelligence index descending, at most 12 rows, each giving the platforms it
  is available through, the intelligence / coding / agentic indices, the context window, the price per
  million input tokens, and the multiplier the client reports (marked with an `x` prefix so it is not
  mistaken for part of the score).
- **Recommendations by task type**, six of them: coding, reasoning & math, agentic & tool use, long
  context, vision, and best value. **Each card prints its own ordering rule on the card**, so "why is
  this one first" can be recomputed on the spot:
  - Coding → by coding index descending, falling back to the intelligence index;
  - Reasoning & math → by intelligence index descending;
  - Agentic & tool use → by agentic index descending, falling back to the intelligence index;
  - Long context → by context window descending;
  - Vision → image-capable models only, by intelligence index descending;
  - Best value → intelligence index ≥ 40 only, cheapest input price first.
    **That floor of 40 is deliberate**: a cheap model below it does not deserve the name "value",
    it is simply weak.

Two numeric conventions are worth calling out separately, because they are the same class of mistake
seen from opposite sides:

- **"This index is missing" and "this index is 0" are two different things.** The leaderboard sends an
  **explicit `null`** for a missing index (measured: `anthropic/claude-haiku-5.5` has
  `coding_index: null`), and `Number(null)` is `0`. An early version called `Number(value)` directly,
  so **98 models with no coding index were treated as "coding score 0"** and ranked above genuinely
  weak models on the coding board. Now `null` stays `null` and the page shows `—`.
- **A model with no intelligence index sinks to the bottom, and is not treated as 0.** When sorting
  the overall board, `null` lands after every model that has a score, instead of mixing into the low
  scores.

A ranking failure is **not** fatal: with an older board in hand the panel keeps using it, and marks
"this refresh failed; showing the last successful fetch" plus the reason. Only "it has never once
succeeded" shows a failure — and even then it must explain **why there is no ranking**, rather than
drawing an empty table that suggests this machine has no usable models. Conversely, reaching the
board but matching nothing is not an error but a fact, and the panel says so: "None of the N locally
available models matched the leaderboard — it may not list them yet", listing the names that did not
match so you can tell whether the board is missing entries or the names differ.

The board cache follows the same pattern as the usage scanner: in-memory snapshot + disk fallback
(`$DSH_HOME/dsh-agent-checkin/model-rank.json`) + serialised concurrent requests. The TTL is 6 hours —
the board changes on the scale of days, so refreshing harder only wastes network.

The HTTP endpoint `GET /dsh-agent-checkin/model-rank` returns the same data; `?refresh=1` forces a
fresh board fetch past the cache. The guards match `/usage` (loopback only, `GET`/`HEAD` only,
`no-store`).

### The settings panel

**Settings → Agent Check-in** — it sits at the bottom of the settings sidebar, after the built-in
sections — so the day-to-day work does not need the command line:

- **Run check-in now** triggers a full check-in round from the panel (equivalent to `/checkin` in a
  conversation) — no command line needed.
  - The button answers "started" immediately; **`started` only means the round was accepted, not that
    it succeeded.** When the round finishes, a per-platform table appears below the buttons, and that
    table is the only verdict (`ALREADY` / already-claimed-today is shown as it is).
  - This is the **only panel action that really changes balances**: the button text and subtitle say
    plainly whether this round will claim or just verify (decided by `allowClaim`). While it runs, the
    buttons are disabled and show "running"; repeated clicks never start a second round.
  - "Force re-run" skips the already-claimed-today protection, and whether that double-claims is up to
    each platform — the panel spells that out next to the button. A normal click never does.
  - If the engine fails to start, the panel shows the failure reason (it never reports "no result" as
    "no failure"); if a round carries no per-platform detail, it says so instead of rendering an empty
    table as if nothing were missing.
- **Check sign-in (read-only)** runs a real read-only endpoint call for every platform and reports
  one of three states — OK / not set up / failed. It **claims nothing**, and it does not start
  claiming just because `allowClaim` is on.
- **One-click login** gives each of four platforms an *Open sign-in window* button, in two shapes:
  - **Cookie-based (WPS Lingxi, 即梦)**: launches a separate browser window on this machine; you log
    in normally and the plugin collects the cookie, verifies it once, and only then writes it to disk.
    No F12, no copying request headers, no command-line flags.
  - **Profile-based (Coze, Kling)**: these two platforms hand out their daily perk for *one signed-in
    visit*, and the credential is an entire browser profile rather than a single cookie. The button
    opens its own window too; after signing in you close that window yourself, and only then does the
    plugin run a read-only verification of the session — passing it is what counts as logged in.
  - The control is an **ordinary button that POSTs** to a local endpoint — nothing navigates, so the
    settings page and the rest of the harness stay exactly where they are. This is worth spelling
    out because two earlier designs both failed here: a link that opened in the same tab
    (`target: '_self'`) tore the whole host UI down, and one that opened a new tab (`target:
    '_blank'`) produced no window at all in this Electron shell.
  - Requests from the panel carry **no `Origin`**, which is normal for this host (DSH's own guard
    treats a missing `Origin` as acceptable). The write guard therefore checks: if an `Origin` *is*
    present it must be same-origin and point at this loopback port; if it is absent, only
    address-bar-style requests (`Sec-Fetch-Site: none`) are refused. Everything else from a loopback
    socket is accepted — anyone able to forge that is already running code on this machine, and could
    read the credential file directly.
  - **`started: true` only means the collection window opened.** It is not a successful sign-in. The
    panel polls the state endpoint every 2 s and decides by the capture result, never by the fact
    that the button responded.
  - The window uses a **throw-away profile**, so it cannot see your everyday browser session. That
    is deliberate: otherwise "captured" could just mean a cookie borrowed from another browser.
  - Collection waits in the background; the panel polls every 2 s and reports a timeout (5 minutes
    by default) as a timeout. A timeout is **never** recorded as success, and neither is a zero exit
    code without an explicit success marker. *Cancel* only stops the wait, and says plainly that the
    sign-in did not finish.
  - When the window cannot start, the reason comes straight from the server and is shown under the
    button. That kind of failure counts only as "the request did not go through"; it is never
    recorded as a failed sign-in.
- **Manual credentials (fallback)** remain for the two cookie-based platforms, for environments where
  the automation window cannot start. Saving runs a read-only verification immediately and shows the
  result below the field — **"saved" is not "can check in"**, and the two are shown separately. The
  field is cleared the moment the save succeeds, so the secret never lingers on the page. The two
  profile-based platforms have no input field to offer: their credential is not a cookie, and
  pasting one would do nothing.
- **The other six platforms have neither a login button nor an input field**, each with a one-line
  reason (the credential is stored encrypted inside the client, or there is no claimable endpoint at
  all). The entry point is absent because it would not help, not because it was forgotten.
- **Per-platform current balance, measured first with manual entry as fallback.** Each platform's
  currently shown balance is listed: a value the engine actually read last round is tagged
  "measured" (with the response field it came from); platforms without a balance endpoint let you
  record a current value by hand, tagged "manual" with an optional note. A manual value is your own
  note-keeping, **not a top-up**, and it never masquerades as a measured one — the next real
  measurement wins automatically.
- **Balances are listed per platform with no total**, matching the dashboard and the command output:
  different platforms use different currencies, and a sum would be meaningless.
- **The claiming switch really does work.** Clicking it writes the new value back to your profile's
  `cordis.patch.yml` through the host `configEditor` service (file lock, validation, atomic write,
  rollback on failure) and the volatile hot-commit makes the running instance pick it up immediately —
  no manual YAML editing, no restart. When the write fails the panel shows the server's real reason
  instead of pretending it worked; when the value is already what you asked for, it says plainly that
  nothing was written.
- **Tab "Providers & models": pick platforms and models right here.** Each attached provider gets a
  card: turn on "show this platform in the model selector", then choose either **all models (follow
  the client's catalog)** — models the client adds later show up automatically — or **pick my own**,
  which starts from nothing and stores an explicit subset. Bulk "select all / none / invert" means
  "just three of them" is one click plus three, not select-all-then-uncheck.
- **The rate after each model is the client's own multiplier** — WorkBuddy's `creditMultiplier`,
  Qoder's `priceFactor` (`0` reads as *free*), TRAE's `features.consumption_rate.data.rate` (promo
  price first). When the client does not publish one, the column stays **empty**; the page never
  shows a guessed number.
- **Image input is per-model, and independent of which models are shown.** A separate block on each
  card has three states: **follow the native capability** (the default — whatever the catalog says
  can take images, and multimodal models the client adds later work automatically), **pick my own**
  (an explicit list), or one click to turn everything off / on. A model shown but without the image
  tick still appears in the selector, it just cannot receive images; conversely a model the catalog
  does not declare can be ticked manually — **whether upstream really accepts it is a matter of
  measurement, and the plugin will not decide that on upstream's behalf.** The platform switch, the
  model whitelist and the image list are three independent stores: turning a platform off does not
  throw away the image ticks.
- **Saving applies immediately.** The plugin writes the file, then emits `llm/adapters-updated`, so
  the host's model selector redraws on the spot — **no host restart**. The selection lives in
  `~/.dsh/dsh-agent-checkin/model-selection.json` (switches and model ids only, never a credential).
  The browser dashboard `/dsh-agent-checkin/models` is the equivalent entry point when no settings UI
  is available; both read and write that same file.

All of this needs the host process to spawn Python and read files, so it happens host-side; the
browser half only issues HTTP calls to sub-routes of `/dsh-agent-checkin/settings`. The credential never
passes through the frontend and never reaches a log — a successful save answers with field names
only, never with values. Login progress reports carry no process id either.


### Idempotency and persistence

Each successful round is written to `$DSH_HOME/dsh-agent-checkin/last-run.json`, and a round will not
re-claim a platform that **already succeeded today** (local calendar day). This matters because the
claim endpoints are real network calls: running `/checkin` twice by accident should not hit them
twice.

- The guard is per platform **per natural day**, and only counts `OK` / `ALREADY` / `DONE` on
  platforms that actually have a claim action.
- **Failures are never remembered** — a platform that failed can be retried immediately.
- **Dry runs do not set the guard** — they claim nothing, so they are not evidence of "already
  done today".
- `/checkin --force` (or `checkin_run` with `force: true`) bypasses it; that escape hatch is
  deliberate rather than silent.
- When everything is already done, the round reports `source: skipped` and **sends no requests**.
  That is a third outcome, not a success and not a failure.
- The state file contains a whitelist of display fields only. Cookies, tokens and JWTs never reach
  disk.
- If the state file is unreadable or from an older format, it is ignored rather than trusted, and
  the round simply behaves like a first run.

### Daily check-in

| Command | What it does |
| --- | --- |
| `/checkin-schedule on 09:00` | enable a daily reminder in this session (time optional, default 09:00) |
| `/checkin-schedule off` | disable it |
| `/checkin-schedule status` | show the current schedule and the time actually in effect |

The task lives on the host's Schedule service and fires **on your machine's local clock**. When
it fires, the current session receives a reminder telling the agent to call `checkin_run` and
report the result.

The plugin only promises what it can actually guarantee here:

- The host guarantees the reminder is **queued into the session inbox** — not that the model is
  woken the instant it fires. If the session is idle, the reminder is processed when you next
  open it.
- So the check-in happens on the **agent-receives-reminder-and-calls-the-tool** path; the plugin
  does not secretly run anything in the background.
- Running `on` again in the same session does not stack duplicate tasks; `off` removes only the
  task this plugin created and leaves your other reminders alone.
- With `allowClaim: false` the schedule still fires, but that round is still read-only — the
  command output says so explicitly.

To change the time, just run `on HH:mm` again; it replaces the old task.

### Pushing results into the session

With `pushResult: true` (the default), `/checkin` injects a summary of the round into the current
session for later reference. It uses `agent.inject()`, not `followup()`: **injection does not wake
an idle session** — the content becomes visible on that session's next request. A check-in result
is something the session should know but should not be interrupted for.

If the push fails (no session, host refusal) it only logs a warning and never turns the check-in
result itself into a failure — you are looking at the real result of the run, and it should not be
re-classified because a side push did not land.

### Does the client have to be running?

Whether a platform's models work depends on **where the credential comes from**, not on whether
the client app is open. Three groups:

| Platform | Must the client stay running? | Why |
| --- | --- | --- |
| **DuMate (Baidu)** | **Yes — it must stay running** (signed in or not) | Its model gateway is a **local** `dumate-main-server` on a random port, and both the port and `X-Dumate-Inapp-Key` change on every launch. Close the client and the models are gone. **This is the only platform that hard-requires it.** |
| **WPS Lingxi** | **No** (but the cookie must be fresh) | Its model API is **cloud-side** (`lingxi.wps.cn`): create a session with `POST /api/aioffice/v1/sessions`, run inference over `wss://…/completions/ws`. No local port is involved. The client is only the **source of the login state** — the cookie is collected from it, and the client can be closed afterwards. The cookie **expires after three days** (`exp=259200`), so you re-open the client once in a while to re-collect it. |
| **WorkBuddy CN / global** | **No, but the client must be installed** | The model API is cloud-side too (`copilot.tencent.com` / `www.codebuddy.ai`). But since 5.6.x the client encrypts its login fields (`$wbEncrypted`), and the decryption key is handed over by the **desktop binary** through `ELECTRON_RUN_AS_NODE` — so `WorkBuddy.exe` has to be present and **executable** on this machine (installed is enough; it need not be running). |
| **TRAE CN / global** | No | Both the credential and the model catalog are **static files** (`storage.json` + `state.vscdb`), read once. |
| **Qoder CN** | No | The credential lives in Chromium OSCrypt storage and is decrypted in memory via the OS DPAPI — independent of the client process. |

In one line: **only DuMate requires the client to stay running; Lingxi needs a fresh cookie (not a
running client); WorkBuddy needs the client installed (not running).**

> **Where the Lingxi cookie lives**: `<dshHome>/dsh-agent-checkin/engine/lx_cookie.txt` (recommended
> — a plugin reinstall no longer wipes it). The plugin looks in this order: the `LINGXI_COOKIE_FILE`
> environment variable → that path → the bundled `engine/lx_cookie.txt`. Only when all three miss
> does the platform count as "not wired up", and the card then lists every path it tried.

### Using TRAE as a model provider

Turn it on:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    traeProvider: true
```

On activation the plugin reads two files from the signed-in TRAE client, **read-only**:

| File | What it provides |
| --- | --- |
| `%APPDATA%\TRAE CN\User\globalStorage\storage.json` | the decrypted login token, device id, user id, region |
| `%APPDATA%\TRAE CN\User\globalStorage\state.vscdb` | the model catalog — the list of models your account can use |

Nothing is written back. The credentials are never sent anywhere except TRAE's own API host — the same host the client itself talks to, taken from the credential rather than hardcoded.

Then chat with any model in the list. The plugin sends the same real request the client itself
sends — `POST /api/agent/v3/llm_utils_chat` on the gateway for your region
(`https://trae-api-cn.mchost.guru` for the CN client), with the same `Cloud-IDE-JWT`
authentication and the same device identity — so the account's own quota applies.

Three things the plugin states plainly:

- **Availability depends on which `function` a model is listed under.** The chat endpoint is
  `/api/agent/v3/llm_utils_chat`, and the request body carries a `function` alongside `model`; **a
  model only exists under some of them**. The plugin picks from the catalog entry's `appearedIn`
  in the order `solo_work_remote` → `solo_work_lite` → `solo_agent_remote` → `chat_v3` →
  `solo_coder` and always falls back to `solo_work_remote`, never passing through non-chat
  category names such as `assistant` or `solo_agent`.
- **Not every model is callable: 30 of the 34 selectable ones answer, 4 are rejected upstream.**
  Each was sent a minimal real request on 2026-10-18. `deepseek//deepseek-v4-flash`,
  `deepseek//deepseek-v4-pro` (custom `base_url` variants), `kimi-k2.8-preview` and
  `qwen3.8-flash` returned `4001` under every candidate `function`, so they are judged
  upstream-unavailable — the client itself cannot call those two `base_url` variants either. A
  model that does work may still work under only one `function`: `DeepSeek-V4-Flash-Official`
  answers on `solo_work_remote` / `solo_work_lite` / `solo_agent_remote`, returns `1005` (paid plan
  does not cover it) on `chat_v3` and `4001` on `solo_coder`. The server can change any of this,
  so the plugin does not pre-filter.
- **The response is real streaming, but the frames are named, not OpenAI-shaped.** Upstream sends
  `event: output` (`response` / `reasoning_content` / `tool_calls`), `event: token_usage` and
  `event: done`, plus bookkeeping frames (`metadata` / `timing_cost` / `progress_notice`). The
  plugin turns `output` into OpenAI chunks, normalises `token_usage` into usage and maps `done`
  into `finish_reason`; the bookkeeping frames are dropped. Text therefore appears token by token
  with internal traces hidden.

> **Correcting an earlier claim in this README.** It used to say "all 34 models answered
> `HTTP 200`". That was wrong: those probes went to `/api/ide/v2/llm_raw_chat`, an inferred
> endpoint the local client never sends, and the 200s were error frames from GET or non-JSON
> requests. Against the real `llm_utils_chat` endpoint the result is the 30 / 4 above.

If TRAE is not installed, not signed in, or the files cannot be read, the provider simply does not
register and the log says why. Everything else in the plugin keeps working.

> **Implementation status (v0.6.0, 2026-10-17).** The earlier "registration into DSH is broken"
> problem is **fixed**. TRAE wiring was rebuilt on the shared `lib/connect/` five-layer
> architecture: local credentials (read-only) → model catalog (state.vscdb, TTL refresh) →
> loopback shim (`127.0.0.1` random port + random bearer, translating the agent-task protocol
> into OpenAI SSE) → the host's own PiAiAdapter (streaming / usage / thinking levels) →
> `registerAdapter` + `registerConfigurableProviders` (providers array, settingsNs,
> declared:false, per the host contract). The CN and global clients are separate providers,
> switched by `traeProvider` / `traeIntlEnabled` respectively.

### Using Qoder CN as a model provider

Turn it on:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    qoderCnEnabled: true
```

The plugin reads the signed-in Qoder client's login state (Chromium OSCrypt at rest, decrypted
via the system DPAPI in memory; scratch files are deleted immediately) and registers the model
catalog through the same loopback shim as provider **Qoder CN (local client)**. If the client is
missing, signed out, or the credential cannot be decrypted, the provider does not register and
the log says why; everything else keeps working.

### Using WorkBuddy as a model provider

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    wbProvider: true        # CN client
    wbProviderIntl: true    # global client (optional)
```

> **Conflict note.** This feature takes over model wiring from the legacy **dsh-connect-workbuddy**
> plugin. Running both makes them fight over the same provider id. Disable the legacy plugin
> first: DSH settings → Plugins → dsh-connect-workbuddy → disable, then restart the host;
> uninstall it if disabling is not enough. On an id conflict this plugin logs a warning and skips
> WorkBuddy registration, leaving the other platforms and check-in untouched.

The catalog comes from the client's `/v3/config` (split by CN/global channel), and model ids are
**byte-for-byte identical** to the legacy plugin, so existing sessions and settings migrate
directly. Token refresh near expiry happens in process memory only — nothing is written to disk
and no client file is modified.

### Wiring models

Declare a route in the config:

```yaml
- id: dsh-agent-checkin
  name: dsh-agent-checkin
  config:
    modelRoutes:
      - provider: my-gateway
        displayName: My Gateway
        api: openai-completions
        baseURL: https://gateway.example.com/v1
        apiKeyEnv: MY_GATEWAY_API_KEY
        models:
          - id: some-model
            name: Some Model
            contextWindow: 131072
            maxTokens: 8192
```

Then apply it:

| Surface | How |
| --- | --- |
| Command | `/checkin-models` — write the routes into the current profile |
| Tool | `model_route_apply` — same, with `dryRun: true` to preview first |

`api` accepts `openai-completions`, `openai-responses`, or `anthropic-messages`. A self-built
route **must** list its models explicitly — the host has no catalog entry to fall back on, and a
route with no models is rejected outright.

Apply goes through the host's `configEditor` service when it is available: that path preserves
YAML comments, writes atomically, rolls back on failure, and reloads the configuration. When
`configEditor` is absent the plugin falls back to editing the profile patch directly, which needs
a DSH restart.

> **Limitation (not yet implemented).** `modelRoutes` supports **static credentials only**:
> `apiKeyEnv` is the *name of an environment variable*, not a token that can be pulled from a
> desktop client's login state at request time. Any upstream whose credential only exists inside
> another app at runtime cannot be wired this way. It also **does not support `headers`** yet —
> the host's `PiAiProviderProfile` has that field, but neither this plugin's `modelRoutes` schema
> nor `toProviderProfile()` exposes it. See `模型接入路线-逐平台定案.md` §1 and §3.4.

## Honest reporting

The check-in summary deliberately keeps four numbers apart:

- **success** counts `OK` / `ALREADY` / `DONE`
- **neutral** covers `DRY_RUN` / `READONLY` / `INACTIVE`
- **blocked** covers `SANDBOX_BLOCKED`
- **failure** covers `AUTH_REJECTED` / `FORBIDDEN` / `NETWORK` / `ERROR` / `EXCEPTION`

`READONLY` means "this platform has no claim action to perform". It is not a success, and folding
it into the success count would both inflate the numerator and disguise a non-existent action as
completed. The summary reports `healthy` separately: platforms that *do* have a real claim action
**and** succeeded.

`blocked` exists because some failures have nothing to do with the platform. Decrypting stored
credentials needs a scratch file, so adapters call `tempfile.mkdtemp()` and write a key there. Under
a workspace-write sandbox the child process can create the directory but not write into it, so the
decrypt fails with `PermissionError [Errno 13]`. Upstream adapters class that as "credentials
unavailable", which would send you off to log in again — and logging in again fixes nothing. The
plugin reclassifies it as `SANDBOX_BLOCKED`, keeps the original error text for traceability, and
states plainly that it is an environment limit, not a credential problem. Only the combination of a
permission-denied error **and** evidence pointing at the run environment (a temp path, or the
sandbox naming itself) triggers the reclassification; a genuinely unreadable credential file or an
expired session still reports `failure`.

Balances are never summed across platforms. Credits, points, and inspiration values are different
currencies; adding them produces a number with no meaning.

### Platforms supported

`workbuddy`, `workbuddy_intl`, `trae`, `lingxi`, `dumate`, `qwenwork`, `phanthywork` have a real
claim action (`claiming: true`). `jimeng`, `coze`, `kling` are read-only status probes
(`claiming: false`) — they report what the account holds but the plugin never claims for them.

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `pythonCommand` | `python` | Python executable used to drive the check-in engine |
| `homeDir` | bundled `engine/` | Root containing `adapters/` and `bridge.py` |
| `timeoutMs` | `180000` | Per-round timeout |
| `allowClaim` | `false` | Permit real claiming; `false` forces read-only |
| `pushResult` | `true` | Inject a summary of a manual round into the current session |
| `statusRoute` | `/dsh-agent-checkin` | Prefix for the HTTP status endpoint |
| `sessionsDir` | empty | Session-log root (the usage panel's data source). Empty means `$DSH_HOME/sessions` |
| `usageCacheSeconds` | `30` | In-memory cache TTL for the usage scan, in seconds; the panel's Refresh always bypasses it |
| `traeProvider` | `false` | Register the signed-in TRAE CN client as a model provider |
| `traeIntlEnabled` | `false` | Register the TRAE global client (can run alongside CN) |
| `qoderCnEnabled` | `false` | Register the signed-in Qoder CN client as a model provider |
| `wbProvider` | `false` | Register the signed-in WorkBuddy CN client as a model provider |
| `wbProviderIntl` | `false` | Register the WorkBuddy global client (can run alongside CN) |
| `modelRoutes` | `[]` | Provider routes to wire into DSH |

`pythonCommand` / `homeDir` / `timeoutMs` / `allowClaim` / `pushResult` are **hot-reloadable**
(`volatile`): they appear in the host's plugin settings panel and take effect on the next run
without a restart. `statusRoute` / `modelRoutes` and the five provider switches above are not,
because they are **registration-time facts** — they decide which HTTP route and which provider
get registered. Making them hot-editable would let the UI show "disabled" while the provider is
still mounted, which is a lie, so they require a restart instead.

`sessionsDir` and `usageCacheSeconds` are not `volatile` either: they are read once by the usage
scanner (the scanner is created at wiring time, and its parameters are fixed at that moment), so
changing them requires a host restart to take effect.

The leaderboard refresh TTL (6 hours) and the board URL are currently **not configuration**, but
constants in `lib/model-rank.js` (`DEFAULT_RANK_TTL_MS`, `LEADERBOARD_URL`). They are not exposed
because changing them can only make the panel slower or more failure-prone, never more accurate —
and when you do want a fresher board, the panel's own "Refresh board" button is the path.

The daily schedule's **time is deliberately not in this table**: it lives on the host's Schedule
task record and is managed with `/checkin-schedule on HH:mm`. The plugin does not keep its own
`dailyTime` copy, because that would inevitably drift into two sources of truth.

### Where the engine writes

The bundled engine lives inside the installed package. Two adapters store hand-entered cookies
next to it, and the browser-automation adapter creates its throwaway profile there too
(`jimeng_cookie.txt`, `lx_cookie.txt`, `.<name>_profile/`). npm-installed packages are normally
read-only, so either:

- point `homeDir` at a writable checkout of the engine, **or**
- pre-populate `jimeng_cookie.txt` / `lx_cookie.txt` in a location the engine can write to, and
  expect `driver of browser automation` adapters (`jimeng`) to fail rather than silently
  half-work.

Everything that touches real credentials stays inside those files; nothing leaves your machine.
See `engine/SECURITY.md` for the engine authors' own policy, and `engine/DISCLAIMER.md` for the
risks of automated check-ins.

### DuMate's local gateway and its ephemeral key

DuMate's desktop app exposes an OpenAI-compatible endpoint on a random local port, but every
request must carry the header `X-Dumate-Inapp-Key`, a 32-byte random hex string generated at
process start and injected into the renderer and child processes via an environment variable.
It **changes on every restart**.

The value is not stored in any config file, but it **is printed into the app's own logs**:

```
log\electron.log        DUMATE_INAPP_KEY: '<64 hex>'
log\desktop-main\Main.log
  [OPENCODE PROXY] ... headers: map[ ... X-Dumate-Inapp-Key:[<64 hex>] ]
```

So a separate DSH process *can* read it at runtime (the port too, from the
`doInitServices completed, result: {"backendPort":…}` line). Two costs come with that: DuMate
must be **running** for the port and key to exist, and the log format is an implementation
detail of the current build (1.0.83.335) that may change.

The plugin **does** ship a DuMate model route: it reads the port and `X-Dumate-Inapp-Key` from the
logs and forwards through a local shim to `http://127.0.0.1:<port>/api/qianfanproxy/v1/chat/completions`
(the upstream is OpenAI-compatible, so no protocol translation is needed). That makes DuMate the
**only model platform that hard-requires the client to stay running** — close the client and there
is no port and no key, so the models are gone. DuMate *check-in* works fine and uses none of this:
it reads the app's own stored cookie and calls Baidu's official endpoints.

## Design notes

**Why a subprocess instead of a native port?** The ten platforms decrypt their credentials in ten
different ways (Electron at-rest AES-256-GCM, Chromium OSCrypt, plain AES-CBC, Ed25519 signing,
CDP browser automation). Those implementations are already hardened and covered by real runs.
Rewriting them in Node would add failure modes without removing any. The plugin's job is
scheduling and presentation — so it ships a curated subset of the engine that already existed
(`engine/`, MIT, 漏 2026 sole373) instead of a rewrite.

**Why not write a `LlmAdapter`?** The host already ships `@deepseek-ai/dsh-llm-pi-ai`, which
handles streaming chunking, tool-call deltas, usage normalisation, thinking-level mapping, and
image budgets. Re-implementing that means re-implementing a streaming protocol *and* competing for
the same LLM registration slot, which drifts silently the next time the host updates. Registering a
route is a configuration problem, so the plugin solves it as one.

The TRAE / Qoder / WorkBuddy local-client providers use the same PiAiAdapter too — the rule is
no longer bent. The plugin only runs a `127.0.0.1` loopback shim (random port + random bearer)
on its own side, translating each client's private protocol into an OpenAI-compatible
`/v1/chat/completions`, and PiAiAdapter calls it like any other OpenAI endpoint. Protocol
translation is the only code beyond configuration, and it has to exist: these clients expose no
public endpoint to point at, and their credentials live inside a signed-in desktop client rather
than in an API key. Credentials stay in process memory and on the loopback port — no new secret
is written to disk.

## Licence

MIT — this plugin. The bundled `engine/` subset is MIT too, originally Copyright (c) 2026
sole373; its notice is kept in `engine/ENGINE-LICENSE.txt`, and its `DISCLAIMER.md` /
`SECURITY.md` travel with the bundle and bind use of that portion.
