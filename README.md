# Amplifier for Chrome

Hold **Shift** and click any element on a web page to file it as an issue in
[Amplifier](https://amplifier.app) — complete with a screenshot of the element,
its DOM path, the Rails **view/partial chain** it lives in, the
**controller#action** that rendered it, the element's **key computed styles**,
and the page URL.

```
**Element:** `<a.block.overflow-hidden.rounded-xl> "Revenue $3.4k +517%"`
**DOM path:** `div#main-content-area > main.flex-1 > div.container:nth-of-type(2) > div.mt-4:nth-of-type(1) > div.grid > a.block:nth-of-type(1)`
**Key styles:**
```css
a.block {
  color: rgb(230, 230, 232);
  background-color: rgb(20, 21, 23);
  font-size: 14px;
  border-radius: 12px;
}
```
**View / partials:**
- app/views/dashboard/show.html.erb
  - app/views/dashboard/_office_dashboard.html.erb
    - app/views/dashboard/widgets/_kpi_strip.html.erb
**Controller:** DashboardController#show (app/controllers/dashboard_controller.rb)
**URL:** https://your-app.example.com/
```

The **key styles** block is the element's resolved computed CSS — colours,
typography, spacing, borders and shadows — so an LLM handed the capture can
recreate the look, not just the markup.

…plus the screenshot, attached to the issue's description.

The extension does three things:

- **Shift-click filing** — capture elements (across pages and origins) and file
  them as one issue, or pin them to a mood board.
- **Review bar** — draw on a page and drop numbered comment pins, then send the
  whole session to Claude Code as a single issue.
- **Element tagger** — assert that a spot in the GUI must render a particular
  `Component@variant` from your design system.

## Install (unpacked)

The extension is not on the Chrome Web Store — you load it from disk. It works
in Chrome, Edge, Brave, Arc and any other Chromium browser.

1. **Get the files.**

   ```bash
   git clone https://github.com/schappim/amplifier-chrome.git
   ```

   (Or download the ZIP from the repo's **Code → Download ZIP** and unzip it.)
   Keep the folder somewhere permanent — Chrome loads it from this path every
   time it starts, so deleting or moving it uninstalls the extension.

2. **Open the extensions page.** Go to `chrome://extensions` (Edge:
   `edge://extensions`, Brave: `brave://extensions`).

3. **Turn on Developer mode** with the toggle in the top-right corner.

4. **Click "Load unpacked"** and select the `amplifier-chrome` folder you just
   cloned — the folder that contains `manifest.json`, not a subfolder and not
   the `manifest.json` file itself.

5. **Pin it.** Click the puzzle-piece icon in the toolbar and pin *Shift-Click
   Issue Filer* so its popup is one click away. The badge reads **ON** when the
   inspector is armed.

To update later: `git pull` in that folder, then hit **↻ Reload** on the
extension's card in `chrome://extensions`.

### Connect it to your workspace

Click the extension icon → **Settings**:

- **Workspace URL** — already filled in with `https://amplifier.app`. Only
  change it if you run your own Amplifier workspace, in which case use its base
  URL with no trailing path. It is the workspace your issues live in, *not* the
  site you're inspecting: point it at a dev server and its index page comes back
  instead of the API, which **Connect & save** will tell you.
- **API token** — copy it from **Settings → MCP Connection** in your workspace.
  It's the same token the MCP server uses. The token is user-level, so it
  reaches every account you belong to; pick the account in the composer when you
  file.
- **Connect & save** validates the token and loads your teams, projects, labels
  and mood boards.

### (Optional) let the extension see your Rails internals

The element, DOM path, URL and screenshot work on **any** site with no setup. To
also capture the **view/partial chain** and **controller#action**, the target
Rails app needs view annotations on and a couple of meta tags — drop in the
[`page_inspector`](rails-lib/page_inspector) engine (one partial in your layout
`<head>`). See [its README](rails-lib/page_inspector/README.md).

## How it fits together

```
  ┌─────────────────────────────┐        shift-click
  │  Any web page (the target)  │◀───────  the user
  │  • DOM path + element  ─────┼─┐
  │  • <!-- BEGIN app/views… -->│ │  the extension reads these
  │  • <meta dev-controller>    │ │  straight from the page
  └─────────────────────────────┘ │
        page_inspector engine ─────┘   (adds the meta tags + annotations)

  ┌─────────────────────────────┐   captureVisibleTab + crop
  │  Extension content script   │─────────────┐
  │  builds the Markdown report │             ▼
  └──────────────┬──────────────┘     ┌───────────────┐   POST /inspector/issues
                 │  composer          │  background   │   Authorization: Bearer <token>
                 └───────────────────▶│  service      │──────────────────────────────▶  Your workspace
                                      │  worker       │   { title, body, url, image }     creates the issue
                                      └───────────────┘                                   + attaches the shot
```

## File an issue

On any page, hold **Shift** (a hint appears) and click an element. A panel opens
with that element captured and the cursor already in the **instruction for the
AI** — free text describing what should change, which leads the issue
description. That is the only field you have to fill in: everything else has a
working default, and **⌘↵** (Ctrl+↵ on Windows/Linux) files the issue from
anywhere in the panel.

Below the instruction, the **References** card shows what you captured — a
thumbnail, the element's own text, and the page it came from — so you can
confirm you grabbed the right thing. Leave **Title** blank and the AI names the
issue for you. **Team**, **Project** and **Label** route it. Toggle the whole
thing on/off from the popup or with **Alt+Shift+I**.

A project belongs to exactly one team, so **picking a project sets the team** —
the team picker follows it, and choosing a different team drops a project that
belongs elsewhere. The worker derives the team from the project one last time as
it files, so an issue can never be keyed to one team while carrying another
team's project.

Filing also puts the issue's **prompt on your clipboard** and plays a short
chime — the same text the issue page's **Copy as prompt** produces, rendered
through your workspace's default Issue template with absolute image URLs. So the
step after "Create issue" is a paste into Claude Code, not a trip back to
Amplifier. (If the clipboard is blocked — an unfocused tab, a plain-`http://`
page — the panel says so, and the prompt is still on the issue page.)

### Copy to a mood board instead

The same stack of captures can be pinned to a **Mood Board** in your workspace
(the "Mood Boards" section in the sidebar) rather than filed as an issue. In the
panel's **Mood board** picker choose an existing board, or pick **➕ New board…**
and type a name, then hit **Add to board**. Every captured element —
screenshot, source URL and your caption — becomes a **clip** on that board, so
you can gather visual references from all over the web into one place and keep
adding more over time. Boards you've created show up in the picker (the list
refreshes when the panel opens); a brand-new name creates the board on the fly.

### Stack elements across pages ("make _this_ look like _that_")

Every shift-click **adds** to a running stack instead of filing immediately — and
the stack lives in extension-global storage, so it **follows you across pages and
origins**. Grab a component on your app, navigate (or jump to a totally different
site), shift-click the thing you want it to resemble, and both are captured. When
you hit **Create issue**, all of them land in one issue, each under its own
`## Reference N — host/path` heading with its own screenshot. Each capture also
has its own **caption** box — jot down *why* you grabbed that element ("the
source style", "make it look like this") and it rides along as a blockquote above
that reference. Remove individual captures with their **✕** (the panel stays open
on its empty state, keeping the instruction you already typed), or **Clear all**
to throw the whole draft away. **✕** in the header tucks the panel away without
losing the stack; **Capture console**, in the References header, adds a cropped
screenshot of the DevTools console as another reference.

## The review bar (mark up & comments → Claude Code)

A design-review layer for the site you're building — see
[`docs/REVIEW_BAR_DESIGN.md`](docs/REVIEW_BAR_DESIGN.md) for the full design.
Toggle it from the popup's **Review bar** switch or **Alt+Shift+R**, and a menu
bar is inserted at the very top of the page (the page is pushed down, not
covered) with three modes:

- **Browse** — the page stays fully interactive.
- **Mark up** — draw straight on the page: pen, box, arrow, text label, four
  colours, undo. Drawings stick to the content (they scroll with it) and are
  snapshotted into screenshots as you work — navigate away whenever you like.
- **Comment** — click any element to drop a numbered pin and jot a note in the
  popover. Each pin captures the same element report as shift-click filing
  (DOM path, key styles, view/partials + controller on `page_inspector`
  apps) plus a cropped screenshot.

### Turn an annotation into a reference

A review is one issue about many pages. Sometimes you just want the drawing on
*this* page as an exhibit on the issue you're already writing. **Add reference**
in the bar screenshots the page exactly as annotated — strokes and comment pins
composited in, the bar and any open panel hidden — and drops it straight onto the
shift-click composer's **References** list, where it sits beside the elements you
grabbed and rides along when you hit **Create issue**. The button greys out until
there's something drawn on the page to capture.

Everything gathers into one review session that follows you across pages,
origins and tabs (up to 25 annotations), shown in the bar's counter. **Send to
Claude Code** opens a panel (title, instruction for the AI, team/project) and
files the whole session as **one issue** — the note leads, then a
`## Comment N — host/path` or `## Mark up — host/path` section per annotation —
and dispatches it through the Claude Code channel as an `issue_sent` prompt,
exactly like the issue page's "Send to Claude Code" button. No channel
connected? The issue still files; the panel says so. **Clear** (two-step)
wipes the session; **✕** just hides the bar and keeps it.

Prefer to paste instead of push? **Copy for Claude Code** (in the same panel)
files the identical issue — filing is what turns the local screenshots into
hosted image URLs — but skips the channel and puts the issue's rendered prompt
on your clipboard, image URLs included, ready to paste into any Claude Code
session. It's the same text the issue page's "Copy as prompt" action produces.

## The element tagger (bind a GUI spot to a component)

**Alt+Shift+C** arms the tagger (`content/component_tagger.js`). Hover
highlights, click opens a picker.

The tag is an *assertion*: "this element, on this route, must render
`Button@btn-primary`". It is what turns "please use the components" into
something a machine can check — `audit_components` verifies every tag, and
`set_component_status(..., deprecated)` hands back the list of tagged spots that
must migrate before a component can be retired.

- The picker is populated from `GET /inspector/components` — the project's live
  catalog, fetched each time it arms rather than cached. A catalog moves whenever
  the repo does, and tagging a spot to a variant that was withdrawn an hour ago is
  precisely the drift the registry exists to prevent. Variants a design session
  has *proposed* but the repo hasn't built are offered, and labelled as such.
- If the element already carries a catalogued class, the picker preselects that
  component and variant. It never guesses beyond what the class list says.
- The tag posts to `POST /inspector/component_instances`. The extension stays
  dumb: whether the spot was already bound to something else, whether the variant
  still exists, and whether the component is being retired are all decided
  server-side and reported back.

**The location** must survive the DOM around it changing, so it hangs off the
nearest stable anchor — a `data-testid`, a `data-controller`, or an `id` — and
only falls back to a full `nth-of-type` path when there is none:

```
/issues [data-controller="list-nav"] > div.toolbar > button.primary
```

**"Not a component yet"** is the other half, and matters just as much. When
nothing in the catalog fits, that's a finding, not a licence to hand-roll: the
button files a `design` issue carrying the element's report, its location and a
screenshot, so the gap becomes work.

## Keyboard shortcuts

| Shortcut | What it does |
| --- | --- |
| **Shift** + click | Capture the element under the cursor |
| **Alt+Shift+I** | Toggle the shift-click inspector on/off |
| **Alt+Shift+R** | Toggle the review bar |
| **Alt+Shift+C** | Arm the element tagger |
| **⌘↵** / **Ctrl+↵** | File the issue from anywhere in the composer |

Rebind any of them at `chrome://extensions/shortcuts`.

## The server endpoints

Every call is token-authed with the same `Bearer` scheme as Amplifier's MCP
server — reuse your MCP token — so it works cross-origin from the extension.

```bash
# Validate a token / list teams
curl -s https://amplifier.app/inspector/ping \
  -H "Authorization: Bearer $TOKEN"

# File an issue from one or more captures (each image is a data: URL; optional)
curl -s https://amplifier.app/inspector/issues \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Make the card match the KPI strip",
       "note":"Give the card the same padding, radius and shadow as the KPI strip.",
       "team":"ENG","project":"42","captures":[
        {"url":"https://a…","body":"**Element:** …","caption":"the source style","image":"data:image/png;base64,iVBOR…"},
        {"url":"https://b…","body":"**Element:** …","caption":"make it look like this","image":"data:image/png;base64,iVBOR…"}
      ]}'
# → {"ok":true,"identifier":"ENG-42","url":"https://amplifier.app/issues/ENG-42"}
#
# Add "include_prompt":true and the response also carries "prompt": the filed
# issue rendered through the account's default Issue template, image URLs
# absolutized — what the extension drops on your clipboard when it files.
#
# `note` (optional) leads the description; `project` (optional) is a project id
# from /inspector/ping; each capture's `caption` (optional) is the user's "why"
# note, rendered as a blockquote above that reference. A single top-level
# {title, body, url, image} is still accepted for one capture.
```

The screenshot is stored as an attachment and embedded in the description as
`![screenshot](…)`, exactly like paste-to-upload in the web editor.

### Mood boards

The same capture payload can be copied onto a **mood board** instead of an
issue. `GET /inspector/mood_boards` lists the account's boards; `POST` copies the
captures on as clips. Target an existing board with `board_id`, or create/append
one by name with `board_name`.

```bash
# List boards (for the picker)
curl -s https://amplifier.app/inspector/mood_boards \
  -H "Authorization: Bearer $TOKEN"
# → {"ok":true,"mood_boards":[{"id":1,"name":"Brand refresh","clips":4}]}

# Copy one or more captures onto a board (new board created if board_name is unknown)
curl -s https://amplifier.app/inspector/mood_boards \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"board_name":"Landing inspiration","captures":[
        {"url":"https://a…","body":"**Element:** …","caption":"love this hero","image":"data:image/png;base64,iVBOR…"},
        {"url":"https://b…","body":"**Element:** …","image":"data:image/png;base64,iVBOR…"}
      ]}'
# → {"ok":true,"mood_board":{"id":7,"name":"Landing inspiration","clips":2},"added":2,"url":"https://amplifier.app/mood_boards/7-landing-inspiration"}
```

Each clip keeps its screenshot, source URL, caption and the captured DOM report,
shown together on the board's page.

### Reviews

```bash
curl -s https://amplifier.app/inspector/reviews \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Review of app.example.com",
       "note":"Tighten this whole flow up.",
       "team":"ENG","send_to_claude":true,"items":[
        {"kind":"comment","number":1,"text":"This card is misaligned",
         "body":"**Element:** …","url":"https://app.example.com/dashboard","image":"data:image/png;base64,iVBOR…"},
        {"kind":"markup","url":"https://app.example.com/reports","image":"data:image/png;base64,iVBOR…"}
      ]}'
# → {"ok":true,"identifier":"ENG-42","url":"https://amplifier.app/issues/ENG-42","sent":true}
#
# `sent` is false when no Claude Code channel is connected (the issue is still
# created). `send_to_claude` defaults to true; pass false to just file quietly.
# Add "include_prompt":true to get back a `prompt` field: the issue rendered
# through the account's default Issue template with attachment URLs
# absolutized — what the "Copy for Claude Code" button puts on the clipboard.
```

## What's in this repo

| Path | What it is |
| --- | --- |
| `manifest.json`, `background.js` | MV3 manifest and the background service worker — every authenticated call to the workspace runs here. |
| `content/` | The content scripts: `shared.js` (capture machinery), `inspector.js` (shift-click + composer), `review_bar.js`, `component_tagger.js`. |
| `popup.html` / `options.html` | The toolbar popup (on/off, account switcher) and the settings page (workspace URL + token). |
| `icons/`, `sounds/` | Toolbar icons and the clipboard chime. |
| `test/` | Node smoke tests — `for t in test/*_test.mjs; do node "$t"; done`. No dependencies; they stub the `chrome.*` APIs, the DOM and a fake workspace. |
| `api.js` | Shared by the options page and the worker: normalizes the workspace URL you type and turns every response into JSON *or* a sentence. Nothing else calls `res.json()`. |
| `rails-lib/page_inspector/` | A drop-in Rails engine so **any** Rails app exposes its controller + view/partial info to the extension. Not part of the extension itself. |
| `docs/REVIEW_BAR_DESIGN.md` | The review bar's architecture and rationale. |

## Permissions, and why

| Permission | Why |
| --- | --- |
| `host_permissions: <all_urls>` | You can shift-click an element on *any* site — the point of the "make this look like that" workflow is grabbing references from anywhere. |
| `storage`, `unlimitedStorage` | Holds your settings and the capture stack (screenshots are big, hence unlimited). |
| `desktopCapture` | The "Capture console" button, which screenshots a region of your screen. |
| `clipboardWrite` | Puts the filed issue's prompt on your clipboard. |

## Security notes

- The API token lives in `chrome.storage.sync` and is only ever sent from the
  background worker to your configured workspace URL — never exposed to page
  scripts.
- Nothing leaves the browser except what you explicitly file: a capture is only
  uploaded when you hit **Create issue** / **Add to board** / **Send to Claude
  Code**.
- View annotations expose your view file paths in HTML comments, so the
  `page_inspector` engine only turns them on in development by default.

## Licence

MIT — see [LICENSE](LICENSE).
