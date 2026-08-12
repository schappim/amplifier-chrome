# Review bar: markup & comments → Claude Code (design)

> The architectural snapshot the review bar was built from — kept because it
> explains *why* the pieces are shaped the way they are. The user-facing docs
> live in [README.md](../README.md).

## Concept

A claude.ai/design-style review layer for the site you are actually building,
powered by the existing Shift-Click Issue Filer extension. Toggle **review
mode** on and the extension inserts a **top menu bar at the very top of the
host page**. From it the user switches between three modes:

- **Browse** — the page stays fully interactive; the bar just shows what has
  been gathered so far.
- **Mark up** — draw directly on the page (pen, rectangle, arrow, text label,
  a small colour set, undo), like claude.ai/design's Mark up mode.
- **Comment** — click anywhere to drop a numbered pin anchored to the element
  under the cursor; a popover ("Describe the issue or suggestion…") captures
  the note, mirroring claude.ai/design's comment popover.

Everything accumulates into one **review session** that — like the existing
shift-click capture stack — lives in `chrome.storage.local`, survives
navigation, and follows the user across pages and origins. When done, **Send
to Claude Code** ships the whole session at once: it is filed as a workspace
issue (screenshots hosted on Active Storage, one section per annotation, full
element context per pin) and immediately dispatched through the Claude Code
channel as an `issue_sent` prompt — the same event the issue page's "Send to
Claude Code" button emits — so a connected session starts working on it
straight away.

```
 host page ──(review bar: markup + pins)──▶ review session (chrome.storage.local)
                                                  │  Send to Claude Code
                                                  ▼
                       background worker ──POST /inspector/reviews──▶ workspace
                                                  │                    issue
                                                  ▼
                              Channel.dispatch("issue_sent", prompt)  ──▶ Claude Code session
```

## Why deliver as an issue + `issue_sent` (not a bespoke channel event)

- An issue gives the review **persistence, image hosting, a URL, and a comment
  thread** — Claude's channel reply tool (`reply_to_issue`) needs an issue to
  answer onto, so the round-trip conversation about the review works for free.
- `issue_sent` is delivered to every enabled channel **regardless of its event
  filter** (it is an explicit user action) — the exact semantics of the
  existing "Send to Claude Code" button, reused rather than reinvented.
- Graceful degradation: with no channel connected the issue is still filed and
  the bar says so ("Filed STR-42 — no Claude Code channel connected").

The mood-board `send_to_claude` (seeding a chat thread) was considered and
rejected for reviews: a multi-item review with screenshots wants issue
sections, attachments and a durable identifier, not a one-shot chat prompt.

## Extension architecture

| Piece | Change |
| --- | --- |
| `content/shared.js` *(new)* | Capture helpers extracted from `inspector.js` — element description, CSS/DOM path, view/partial chain, controller meta, key computed styles, report assembly, element screenshot crop, extension-liveness/messaging, HTML escaping. Loaded before both feature scripts; shift-click filing behaviour unchanged. |
| `content/inspector.js` | Slims down to the shift-click stack + composer, importing from shared. |
| `content/review_bar.js` *(new)* | The top bar, the three modes, the pins + canvas overlays, and the send panel. Shadow DOM throughout; every node carries `data-sci-ignore` so shift-click capture ignores the review UI (both features can be armed at once). |
| `background.js` | New `SEND_REVIEW` message → `POST /inspector/reviews`. `CAPTURE_TAB` reused for markup snapshots. |
| `popup.js` / `popup.html` | "Review bar" toggle beside the existing inspector toggle. |
| `manifest.json` | Second content script, new `toggle-review-bar` command (**Alt+Shift+R**). |

### The top bar

- A shadow-DOM host `position: fixed; top: 0; left: 0; right: 0` at maximum
  z-index. To sit *at the very top* rather than covering the site's own
  header, the document is pushed down (`document.documentElement` top margin,
  `!important`, restored when the bar is closed and re-asserted on
  `turbo:load` — Turbo swaps `<body>`, so the bar host and margin live on
  `<html>` and follow the same `turbo:before-cache` teardown the composer
  already uses). Sites with their own `top: 0` fixed headers will sit under
  the bar's offset exactly as they do under Chrome's managed-browser infobars;
  that is accepted, not fought.
- Left: icon + host name. Centre/right: **Browse / Mark up / Comment** mode
  switch, gathered-item count, **Clear**, primary **Send to Claude Code**,
  and ✕ (turns review mode off, keeps the session unless cleared).
- Toggled from the popup, **Alt+Shift+R**, or the ✕ — all writing one
  extension-global `review.active` flag, so the bar follows the user across
  tabs the way the capture stack does.

### Review session storage

`chrome.storage.local.review = { active, startedAt, items: [], draft: {} }`

- `items` — ordered annotations, each
  `{id, kind: "comment"|"markup", url, host, path, image, …}`; comment items
  add `{number, text, body}` where `body` is the standard element report
  (element, DOM path, key styles, view/partials, controller, URL) built by the
  shared helpers.
- `draft` — `{title, note, team, project}` for the send panel, debounced
  writes exactly like the composer's draft (never re-serialises images on
  keystroke).
- Caps mirror the server: 25 items, per-image and total-image byte budgets.
- Cross-tab sync follows the stack's `storage.onChanged` pattern (id-key
  comparison, never rebuild mid-submit or mid-typing).

### Mark up mode

- A full-document overlay (absolutely positioned, `height` = document height)
  hosting a canvas in **page coordinates**, so strokes scroll with the content
  they annotate. Pointer events are only captured while Mark up is the active
  mode — Browse/Comment leave the canvas inert.
- Tools: pen, rectangle, arrow, text label; four colours; undo; clear-page.
- **Snapshot model**: strokes stay live and editable while the user remains on
  the page. On leaving the page, switching review mode off, or hitting Send,
  the annotated viewport is captured (`CAPTURE_TAB` — the overlay is real DOM,
  so the compositor picks the drawings up automatically) and stored as a
  markup item `{image, url}`. Markup is *not* re-hydrated as editable vectors
  on a later visit — the screenshot is the artifact. This keeps scope sane and
  matches what Claude Code actually consumes (an image).

### Comment mode

- Click → numbered pin dropped at the click point, anchored to the underlying
  element: stored as element DOM path + offset ratio within the element's
  rect, with absolute page coordinates as fallback when the path no longer
  resolves.
- The popover mirrors claude.ai/design's: textarea, Save / Cancel (and Delete
  on an existing pin). Saving builds the full element report and an
  element-crop screenshot via the shared helpers — so on a Rails app running
  the `page_inspector` engine every comment automatically carries the
  **view/partial chain and controller#action**, which is exactly the context
  Claude Code needs to find the code.
- Pins for the current URL re-render when the page is revisited during the
  session (and after Turbo visits); each is clickable to edit/delete.

## Server: `POST /inspector/reviews`

Token-authed like the other inspector endpoints (`Inspector::BaseController`,
same `ApiToken` Bearer scheme), sharing `Inspector::CaptureHandling` for image
decoding and size budgets.

```jsonc
{
  "title": "Review of app.example.com",        // optional; defaulted from host
  "note": "Tighten this whole flow up",        // optional; leads the description
  "team": "STR", "project": "42",              // optional; resolved like issues#create
  "send_to_claude": true,                      // default true
  "items": [
    {"kind": "comment", "number": 1, "text": "This card is misaligned",
     "body": "**Element:** …full report…", "url": "https://…", "image": "data:image/png;base64,…"},
    {"kind": "markup", "url": "https://…", "image": "data:image/png;base64,…"}
  ]
}
// → {"ok": true, "identifier": "STR-42", "url": "https://…/issues/STR-42", "sent": true}
```

- Builds one issue: the note leads; each comment renders as
  `## Comment N — host/path` (quoted text, element report, pinned crop); each
  markup as `## Mark up — host/path` (annotated screenshot). Blobs attach via
  the existing decode/attach path.
- When `send_to_claude` and the account has enabled channels: mirror
  `IssuesController#send_to_claude` — `Channel.dispatch("issue_sent", issue:,
  actor:, body: issue.render_prompt(default template))` plus the
  `sent_to_claude` activity — and return `sent: true`. Otherwise the issue is
  filed and `sent: false` tells the bar to explain.

## `page_inspector` engine enhancement

The bar works on **any** site with zero setup (markup, pins, screenshots, DOM
paths). The engine's existing affordances — view/partial annotations and the
`dev-controller` meta tags — flow into every pinned comment automatically
because the report builder is shared. One addition: a
`<meta name="dev-app-name">` (the Rails application's module name) so a
review's issue and prompt can say *which app* the review is about even when
filed from an ngrok URL.

## Non-goals

- Re-editable vector markup across page reloads or sessions (snapshot model).
- Multi-user / realtime collaborative review; sessions are single-user.
- Any claude.ai/design API integration — delivery is via the workspace issue +
  channel, which is the point of the feature.
- Production exposure of view annotations (`page_inspector` stays dev-only by
  default).
