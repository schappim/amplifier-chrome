// Review bar — claude.ai/design-style markup & comments for any page.
//
// When review mode is on, a menu bar is inserted at the very top of the host
// page with three modes:
//   Browse   — the page stays fully interactive
//   Mark up  — draw pen / rectangle / arrow / text directly on the page
//   Comment  — click to drop numbered pins anchored to elements
// Everything gathers into one review session that (like the shift-click
// capture stack in inspector.js) lives in chrome.storage.local, survives
// navigation and follows you across pages, origins and tabs. "Send to Claude
// Code" files the whole session as a workspace issue and dispatches it through
// the Claude Code channel as an issue_sent prompt.
//
// Element reports and screenshots reuse content/shared.js so review captures
// and shift-click captures can never drift apart in format.

(() => {
  const INIT_FLAG = "__sciReviewBar"
  if (window[INIT_FLAG]) return
  window[INIT_FLAG] = true

  const shared = window.__sciShared
  if (!shared) return
  const {
    IGNORE_ATTR,
    CHROME_ATTR,
    sendMessage,
    escapeHtml,
    escapeAttr,
    copyTextToClipboard,
    playSound,
    buildReport,
    buildChromeConsoleReport,
    buildAnnotationReport,
    describeElement,
    cssPathParts,
    captureTab,
    captureElement,
    captureDesktopArea,
    OVERLAY_TOKENS,
    OVERLAY_CONTROLS,
    OVERLAY_ICONS: ICON,
    guardFieldKeystrokes
  } = shared

  // ── Review session store (chrome.storage.local) ─────────────────────
  // Split across FOUR keys rather than one nested object so that:
  //   - popup + background can flip `reviewActive` without read-modify-writing
  //     the image-heavy items array (no clobber races with content scripts),
  //   - draft keystrokes never re-serialize the screenshots (the same trick as
  //     the capture stack's saveDraft),
  //   - item writes never touch the flag another surface just toggled.
  const MAX_ITEMS = 25 // keep in sync with the server's cap
  // Byte budgets mirror Inspector::CaptureHandling: one image's data: URL, and
  // the sum of all of them, so nothing we let the user gather gets bounced by
  // the server at send time.
  const MAX_IMAGE_BYTES = 14_000_000
  const MAX_TOTAL_IMAGE_BYTES = 40_000_000

  const STORE_DEFAULTS = {reviewActive: false, reviewStartedAt: null, reviewItems: [], reviewDraft: {}}

  let review = {active: false, startedAt: null, items: [], draft: {}}

  // Workspace connection + picker data, shared with the issue filer via
  // chrome.storage.sync (the options page writes it on Connect & save).
  let config = {baseUrl: "", token: "", accountId: "", accounts: [], team: "", teams: [], projects: [], labels: [], lastProject: "", lastLabel: ""}

  function loadConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(config, (stored) => {
          config = stored || config
          resolve(config)
        })
      } catch (_e) {
        resolve(config)
      }
    })
  }

  const isConfigured = () => Boolean(config.baseUrl && config.token)

  function loadReview() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORE_DEFAULTS, (s) => {
          review = {
            active: Boolean(s.reviewActive),
            startedAt: s.reviewStartedAt || null,
            items: s.reviewItems || [],
            draft: s.reviewDraft || {}
          }
          resolve(review)
        })
      } catch (_e) {
        resolve(review)
      }
    })
  }

  // Full items write — the array holds screenshots, so only call this when
  // items actually change (add/remove/replace/clear), never on keystrokes.
  function saveItems() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({reviewItems: review.items}, () => {
          const lastError = chrome.runtime?.lastError
          if (lastError) {
            console.warn("[review bar] could not save annotation:", lastError.message)
            resolve(false)
          } else {
            resolve(true)
          }
        })
      } catch (_e) {
        resolve(false)
      }
    })
  }

  // Cheap, debounced write for the send-panel draft
  // (title/note/team/project/label).
  let draftTimer = null
  function saveDraft() {
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      draftTimer = null
      try {
        chrome.storage.local.set({reviewDraft: review.draft})
      } catch (_e) {
        /* best effort */
      }
    }, 250)
  }

  // Flip review mode on/off for every tab. The bar's ✕, the popup switch and
  // the Alt+Shift+R command all funnel through this one flag; items survive
  // toggling off (Clear is the only thing that wipes them).
  function setActive(on) {
    review.active = Boolean(on)
    const write = {reviewActive: review.active}
    if (review.active && !review.startedAt) {
      review.startedAt = Date.now()
      write.reviewStartedAt = review.startedAt
    }
    try {
      chrome.storage.local.set(write)
    } catch (_e) {
      /* best effort */
    }
    onActiveChanged()
  }

  const itemsKey = (list) => (list || []).map((i) => i.id).join(",")
  const imageBytes = (list) => (list || []).reduce((sum, i) => sum + (i.image ? String(i.image).length : 0), 0)

  // Session-global, stable comment numbering: deletes never renumber pins.
  function nextCommentNumber() {
    return review.items.reduce((max, i) => (i.kind === "comment" && i.number > max ? i.number : max), 0) + 1
  }

  // Add (or replace, for evolving markup snapshots) an annotation, enforcing
  // the caps the server will also enforce. Returns {ok} or {ok: false, error}
  // so the caller can surface the refusal in the bar.
  async function addItem(item, {replaceId = null} = {}) {
    const others = replaceId ? review.items.filter((i) => i.id !== replaceId) : review.items.slice()
    if (others.length >= MAX_ITEMS) {
      return {ok: false, error: `You can gather up to ${MAX_ITEMS} annotations — send this review first.`}
    }
    if (item.image && String(item.image).length > MAX_IMAGE_BYTES) {
      return {ok: false, error: "That screenshot is too large to attach."}
    }
    if (imageBytes(others) + (item.image ? String(item.image).length : 0) > MAX_TOTAL_IMAGE_BYTES) {
      return {ok: false, error: "Screenshot budget reached — send this review, then keep going."}
    }
    if (!item.id) item.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (replaceId) {
      const at = review.items.findIndex((i) => i.id === replaceId)
      if (at === -1) {
        review.items.push(item)
      } else {
        item.id = replaceId
        review.items[at] = item
      }
    } else {
      review.items.push(item)
    }
    await saveItems()
    onItemsChanged()
    return {ok: true, item}
  }

  async function updateItem(id, patch) {
    const at = review.items.findIndex((i) => i.id === id)
    if (at === -1) return false
    review.items[at] = {...review.items[at], ...patch}
    await saveItems()
    onItemsChanged()
    return true
  }

  async function removeItem(id) {
    review.items = review.items.filter((i) => i.id !== id)
    await saveItems()
    onItemsChanged()
  }

  async function clearSession() {
    review.items = []
    review.draft = {}
    review.startedAt = null
    try {
      chrome.storage.local.set({reviewItems: [], reviewDraft: {}, reviewStartedAt: null})
    } catch (_e) {
      /* best effort */
    }
    // Wipe the live drawings too — a cleared (or sent) review starts blank.
    strokesByPage.clear()
    liveMarkupIds.clear()
    queueRedraw()
    onItemsChanged()
  }

  // ── Cross-tab / cross-surface sync ───────────────────────────────────
  // The popup, the background command and other tabs all write the same keys;
  // react here so the bar and pins follow along everywhere. Items use the
  // stack's id-key comparison so a tab never rebuilds in response to its own
  // write; the active flag is idempotent to apply.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "sync") {
      for (const [key, {newValue}] of Object.entries(changes)) {
        if (key in config) config[key] = newValue
      }
      return
    }
    if (area !== "local") return
    if (changes.reviewActive) {
      const next = Boolean(changes.reviewActive.newValue)
      if (next !== review.active) {
        review.active = next
        onActiveChanged()
      }
    }
    if (changes.reviewStartedAt) review.startedAt = changes.reviewStartedAt.newValue || null
    if (changes.reviewItems) {
      const next = changes.reviewItems.newValue || []
      if (itemsKey(next) !== itemsKey(review.items)) {
        review.items = next
        onItemsChanged()
      }
    }
    if (changes.reviewDraft && !isTypingInReview()) {
      review.draft = changes.reviewDraft.newValue || {}
    }
  })

  // ── Top bar (Shadow DOM so page CSS can't touch it) ──────────────────
  const BAR_HEIGHT = 44

  const BAR_CSS = `
    :host { all: initial; }
    .bar {
      position: fixed; top: 0; left: 0; right: 0; height: ${BAR_HEIGHT}px; z-index: 2147483647;
      box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 14px;
      background: #141517; color: #e7edf3; border-bottom: 1px solid #2a2c30;
      font: 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 6px 18px rgba(0,0,0,.35);
    }
    .brand { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; white-space: nowrap; }
    .brand .dot { width: 9px; height: 9px; border-radius: 50%; background: #5e6ad2; }
    /* min-width:0 because a flex item defaults to min-width:auto and so refuses
       to shrink below its text — without it the buttons on the right get pushed
       off the end of the bar instead. */
    .page-host { color: #8b8d94; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; min-width: 0; flex: 0 1 auto; }
    .modes { display: flex; background: #0e1013; border: 1px solid #2a2c30; border-radius: 8px; padding: 2px; margin-left: 6px; flex: none; }
    .modes button { background: none; border: 0; color: #b7b9c0; font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
    .modes button.on { background: #5e6ad2; color: #fff; }
    .modes button:hover:not(.on) { color: #e7edf3; }
    .sp { flex: 1 1 0; min-width: 0; }
    .msg { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
    .msg.err { color: #f38ba0; }
    .msg.ok { color: #7ee7a8; }
    .msg a { color: #8b93e6; }
    .count { font-size: 12px; color: #8b8d94; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }
    button.ghost.ref { display: inline-flex; align-items: center; gap: 6px; }
    /* The controls always win the fight for room; the labels step aside first. */
    @media (max-width: 1180px) { .page-host { display: none; } }
    @media (max-width: 1100px) { button.ghost.ref span { display: none; } }
    @media (max-width: 1020px) { .count { display: none; } .brand-name { display: none; } }
    button.ghost { background: none; color: #b7b9c0; border: 1px solid #2a2c30; border-radius: 7px; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
    button.ghost:hover { color: #e7edf3; }
    button.ghost:disabled { opacity: .45; cursor: default; }
    button.ghost:disabled:hover { color: #b7b9c0; }
    button.ghost.danger { color: #f38ba0; border-color: #5a2a33; }
    button.primary { background: #5e6ad2; color: #fff; border: 0; border-radius: 7px; padding: 6px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    button.primary:hover { background: #5763c9; }
    .x { cursor: pointer; color: #8b8d94; background: none; border: 0; font-size: 15px; line-height: 1; padding: 4px 6px; }
    .x:hover { color: #e7edf3; }
    .tools { display: flex; align-items: center; gap: 3px; margin-left: 6px; }
    .tools button { background: none; border: 1px solid transparent; color: #b7b9c0; font: inherit; font-size: 13px; padding: 4px 7px; border-radius: 6px; cursor: pointer; }
    .tools button.on { border-color: #5e6ad2; color: #fff; background: #1c1e26; }
    .tools button:hover:not(.on) { color: #e7edf3; }
    .tools .swatch { width: 16px; height: 16px; border-radius: 50%; padding: 0; border: 2px solid transparent; }
    .tools .swatch.on { border-color: #fff; }
    .tools .sep { width: 1px; height: 18px; background: #2a2c30; margin: 0 4px; }
  `

  let barHost = null
  let mode = "browse" // per-context UI state; a fresh page load starts in Browse
  let prevHtmlMargin = null // the page's own inline margin-top, restored on close
  let flashTimer = null
  let flashState = null // {text, kind} — survives a renderBar() rebuild
  let addingReference = false // an annotation capture is in flight
  let clearArmed = false
  let clearArmTimer = null

  // Push the whole document down so the bar sits at the very top rather than
  // covering the site's own header. The page's inline margin-top (if any) is
  // remembered once and restored when the bar closes. Sites with their own
  // fixed top-0 headers sit under the offset — same behaviour as Chrome's
  // managed-browser infobars; accepted, not fought.
  function pushPage() {
    const html = document.documentElement
    if (prevHtmlMargin === null) {
      prevHtmlMargin = {
        value: html.style.getPropertyValue("margin-top"),
        priority: html.style.getPropertyPriority("margin-top")
      }
    }
    html.style.setProperty("margin-top", `${BAR_HEIGHT}px`, "important")
  }

  function restorePage() {
    if (prevHtmlMargin === null) return // never pushed — don't touch the page's own margin
    const html = document.documentElement
    if (prevHtmlMargin.value) {
      html.style.setProperty("margin-top", prevHtmlMargin.value, prevHtmlMargin.priority)
    } else {
      html.style.removeProperty("margin-top")
    }
    prevHtmlMargin = null
  }

  function mountBar() {
    if (barHost && barHost.isConnected) {
      renderBar()
      return
    }
    barHost = document.createElement("div")
    barHost.setAttribute(IGNORE_ATTR, "")
    // Tool chrome — hidden while a screenshot of the page is taken. The mark-up
    // canvas and the comment pins are not, because they ARE the annotation.
    barHost.setAttribute(CHROME_ATTR, "")
    const shadow = barHost.attachShadow({mode: "open"})
    guardFieldKeystrokes(shadow) // typing in the bar's fields must not trip page shortcuts
    const style = document.createElement("style")
    style.textContent = BAR_CSS
    shadow.appendChild(style)
    const bar = document.createElement("div")
    bar.className = "bar"
    shadow.appendChild(bar)
    barHost._bar = bar
    // Attached to <html>, not <body>: Turbo caches/swaps only the body, so the
    // bar survives Turbo navigations without flicker or snapshot duplication.
    document.documentElement.appendChild(barHost)
    pushPage()
    renderBar()
  }

  function unmountBar() {
    clearFlash() // so reopening the bar within 5s doesn't re-show a stale message
    if (barHost) {
      barHost.remove()
      barHost = null
    }
    restorePage()
  }

  // Is there anything drawn on THIS page worth capturing? Strokes live in
  // memory per page; pins live in the review session, filtered by host+path.
  function hasPageAnnotations() {
    return strokesForPage().length > 0 || commentsForPage().length > 0
  }

  // Turn what's drawn on this page into a reference on the issue the composer is
  // assembling — the same stack shift-clicking an element feeds. A review is one
  // issue about many pages; a reference is one exhibit on an issue you're
  // writing now, so the two destinations stay separate on purpose.
  async function addAnnotationReference() {
    if (addingReference) return // the capture takes a beat; don't stack two
    const filer = window.__sciFiler
    if (!filer) {
      flashBar("Reload this page to add references.", "err")
      return
    }

    const strokes = strokesForPage().length
    const comments = commentsForPage().length
    if (!strokes && !comments) {
      flashBar("Draw a mark-up or drop a comment on this page first.", "err")
      return
    }

    // Claim the guard before the first await, or three quick clicks all sail past
    // the check while the first is still suspended and file three captures.
    addingReference = true
    let popEl = null
    let popVis = null

    try {
      // Ask before shooting: an unconnected extension or a full stack would
      // refuse the capture anyway, and a screenshot costs a frame of hidden UI.
      const room = await filer.canAddCapture()
      if (!room.ok) {
        flashBar(room.error, "err")
        return
      }

      // The comment popover lives inside the pins overlay, which stays visible
      // for the shot because the pins are the annotation. Hide just the popover
      // for the frame — closing it would throw away a comment being typed.
      popEl = popover && popover.el
      popVis = popEl ? popEl.style.visibility : null
      if (popEl) popEl.style.visibility = "hidden"

      const shot = await captureAnnotatedViewport()
      if (!shot.ok) {
        flashBar(shot.error, "err")
        return
      }

      const res = await filer.addCapture({
        body: buildAnnotationReport({strokes, comments}),
        label: "Page annotation",
        image: shot.image,
        url: window.location.href,
        host: window.location.host,
        path: window.location.pathname,
        source: "page_annotation"
      })

      if (res?.ok) {
        flashBar(`Added as reference ${res.count}.`, "ok")
      } else {
        flashBar(res?.error || "Could not add that reference.", "err")
      }
    } finally {
      if (popEl && popEl.isConnected) popEl.style.visibility = popVis
      addingReference = false
    }
  }

  function countsLabel() {
    const comments = review.items.filter((i) => i.kind === "comment").length
    const markups = review.items.filter((i) => i.kind === "markup").length
    const consoleCaptures = review.items.filter((i) => i.kind === "console").length
    if (!comments && !markups && !consoleCaptures) return "No annotations yet"
    const parts = []
    if (comments) parts.push(`${comments} comment${comments === 1 ? "" : "s"}`)
    if (markups) parts.push(`${markups} mark-up${markups === 1 ? "" : "s"}`)
    if (consoleCaptures) parts.push(`${consoleCaptures} console capture${consoleCaptures === 1 ? "" : "s"}`)
    return parts.join(" · ")
  }

  function renderBar() {
    if (!barHost) return
    const bar = barHost._bar
    const modeButton = (key, label) =>
      `<button data-mode="${key}" class="${mode === key ? "on" : ""}">${label}</button>`

    bar.innerHTML = `
      <span class="brand"><span class="dot"></span><span class="brand-name">Review</span></span>
      <span class="page-host">${escapeHtml(window.location.host)}</span>
      <div class="modes">
        ${modeButton("browse", "Browse")}
        ${modeButton("markup", "Mark up")}
        ${modeButton("comment", "Comment")}
      </div>
      ${mode === "markup" ? markupToolsHtml() : ""}
      <span class="sp"></span>
      <span class="msg" id="rb-msg"></span>
      <span class="count">${escapeHtml(countsLabel())}</span>
      <button class="ghost ref" data-act="reference" ${hasPageAnnotations() ? "" : "disabled"}
              title="Add this page's annotations to the issue you're filing, as a reference"
        ><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 2.5v7M2.5 6h7"/></svg><span>Add reference</span></button>
      <button class="ghost" data-act="console" title="Capture a Chrome console area">Console</button>
      <button class="ghost ${clearArmed ? "danger" : ""}" data-act="clear">${clearArmed ? "Really clear?" : "Clear"}</button>
      <button class="primary" data-act="send">Send to Claude Code</button>
      <button class="x" data-act="close" title="Close review bar (annotations are kept)">✕</button>
    `

    bar.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.onclick = () => setMode(btn.getAttribute("data-mode"))
    })
    bar.querySelector('[data-act="clear"]').onclick = onClearClicked
    bar.querySelector('[data-act="reference"]').onclick = addAnnotationReference
    bar.querySelector('[data-act="console"]').onclick = addConsoleCapture
    bar.querySelector('[data-act="send"]').onclick = () => openSendPanel()
    bar.querySelector('[data-act="close"]').onclick = () => setActive(false)
    bar.querySelectorAll("[data-tool]").forEach((btn) => {
      btn.onclick = () => {
        markupTool = btn.getAttribute("data-tool")
        renderBar()
      }
    })
    bar.querySelectorAll("[data-color]").forEach((btn) => {
      btn.onclick = () => {
        markupColor = btn.getAttribute("data-color")
        renderBar()
      }
    })
    const undoBtn = bar.querySelector('[data-act="undo"]')
    if (undoBtn) undoBtn.onclick = undoMarkupStroke
    paintFlash()
  }

  // The markup tool cluster shown while Mark up is the active mode.
  function markupToolsHtml() {
    const tools = MARKUP_TOOLS.map(
      ([key, icon, title]) =>
        `<button data-tool="${key}" class="${markupTool === key ? "on" : ""}" title="${escapeAttr(title)}">${icon}</button>`
    ).join("")
    const swatches = MARKUP_COLORS.map(
      (c) =>
        `<button data-color="${escapeAttr(c)}" class="swatch ${markupColor === c ? "on" : ""}" style="background:${escapeAttr(c)}" title="Colour"></button>`
    ).join("")
    return `<div class="tools">${tools}<span class="sep"></span>${swatches}<span class="sep"></span><button data-act="undo" title="Undo last stroke">↩</button></div>`
  }

  // The status line is repainted from module state rather than written once into
  // the DOM, because renderBar() rebuilds the whole bar — a stroke landing or an
  // annotation arriving used to swallow the message mid-read.
  function paintFlash() {
    const msg = barHost && barHost._bar && barHost._bar.querySelector("#rb-msg")
    if (!msg) return
    msg.className = "msg" + (flashState ? ` ${flashState.kind}` : "")
    msg.innerHTML = flashState ? flashState.text : ""
  }

  function flashBar(text, kind = "err") {
    flashState = {text, kind}
    paintFlash()
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashState = null
      paintFlash()
    }, 5000)
  }

  // A message belongs to the page and the session that raised it. Because the
  // bar lives on <html>, its JS context (and so flashState) outlives a Turbo
  // navigation and a close/reopen — without this, page A's message would repaint
  // itself on page B.
  function clearFlash() {
    flashState = null
    if (flashTimer) {
      clearTimeout(flashTimer)
      flashTimer = null
    }
    paintFlash()
  }

  async function addConsoleCapture() {
    flashBar("Choose the Chrome window or screen that contains DevTools.", "ok")
    const capture = await captureDesktopArea({
      title: "Capture Chrome console",
      detail: "Choose the Chrome window or screen with DevTools, then crop the console area.",
      action: "Add console capture"
    })
    if (!capture?.ok) {
      if (!capture?.canceled) flashBar(capture?.error || "Could not capture the Chrome console.", "err")
      return
    }

    const result = await addItem({
      kind: "console",
      text: "Chrome console capture",
      body: buildChromeConsoleReport(),
      image: capture.dataUrl,
      url: window.location.href,
      host: window.location.host,
      path: window.location.pathname
    })
    if (result.ok) {
      flashBar("Console capture added.", "ok")
    } else {
      flashBar(result.error, "err")
    }
  }

  // Two-step clear so a stray click can't wipe a gathered review — no
  // window.confirm, which would block the page's event loop.
  function onClearClicked() {
    if (clearArmTimer) clearTimeout(clearArmTimer)
    if (clearArmed) {
      clearArmed = false
      clearSession()
      return
    }
    clearArmed = true
    renderBar()
    clearArmTimer = setTimeout(() => {
      clearArmed = false
      renderBar()
    }, 3000)
  }

  function setMode(next) {
    if (mode === next) return
    mode = next
    applyMode()
    renderBar()
  }

  function applyMode() {
    armMarkupMode()
    armCommentMode()
  }

  // ── Comment mode ─────────────────────────────────────────────────────
  // Click → a numbered pin dropped at that point, anchored to the element
  // under the cursor (DOM path + offset ratio within its rect, absolute page
  // coordinates as the fallback when the path stops resolving). A popover —
  // styled after claude.ai/design's — takes the note; saving builds the full
  // element report and an element-crop screenshot via the shared helpers, so
  // on a page_inspector-annotated app every comment carries the view/partial
  // chain and controller#action. Pins for the current page re-render on
  // revisits within the session; numbering is session-global and stable
  // (deletes never renumber).

  const PIN_Z = 2147483644 // under the markup canvas so drawing isn't blocked
  const COMMENT_OUTLINE_CLASS = "rb-comment-target"

  let pinsHost = null
  let popover = null // {el, itemId|null} — null itemId means a new draft
  let draftPin = null // {target, anchor, x, y} while composing a new comment
  let commentHovered = null

  const PINS_CSS = `
    :host { all: initial; }
    .wrap { position: absolute; top: 0; left: 0; }
    .pin {
      position: absolute; transform: translate(-50%, -50%); width: 24px; height: 24px;
      border-radius: 50%; background: #5e6ad2; color: #fff; border: 2px solid #fff;
      box-shadow: 0 2px 8px rgba(0,0,0,.45); cursor: pointer; padding: 0;
      font: 700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .pin:hover { background: #4954c9; }
    .pin.draft { background: #f59e0b; }
    .popover {
      position: absolute; z-index: 2; width: 300px; box-sizing: border-box;
      background: #16181d; color: #e7edf3; border: 1px solid #2a2c30; border-radius: 12px;
      box-shadow: 0 18px 48px rgba(0,0,0,.5); padding: 12px;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .popover .head { display: flex; align-items: center; margin-bottom: 8px; }
    .popover .head b { font-size: 13px; }
    .popover .head .sp { flex: 1; }
    .popover .x { cursor: pointer; color: #8b8d94; background: none; border: 0; font-size: 15px; line-height: 1; padding: 2px 4px; }
    .popover .x:hover { color: #e7edf3; }
    .popover textarea {
      width: 100%; box-sizing: border-box; min-height: 74px; resize: vertical;
      background: #0e1013; color: #e7edf3; border: 1px solid #2a2c30; border-radius: 8px;
      padding: 8px 10px; font: inherit;
    }
    .popover textarea:focus { outline: none; border-color: #5e6ad2; }
    .popover .el { margin-top: 6px; font: 11px/1.4 ui-monospace, Menlo, monospace; color: #6b6d75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .popover .actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .popover .actions .sp { flex: 1; }
    .popover button.primary { background: #5e6ad2; color: #fff; border: 0; border-radius: 7px; padding: 6px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .popover button.primary:hover { background: #5763c9; }
    .popover button.ghost { background: none; color: #b7b9c0; border: 1px solid #2a2c30; border-radius: 7px; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; }
    .popover button.ghost:hover { color: #e7edf3; }
    .popover button.danger { background: none; color: #f38ba0; border: 1px solid #5a2a33; border-radius: 7px; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; }
  `

  function ensurePinsOverlay() {
    if (pinsHost && pinsHost.isConnected) return
    pinsHost = document.createElement("div")
    pinsHost.setAttribute(IGNORE_ATTR, "")
    // Absolute at the document origin so pins scroll with the content they
    // mark; attached to <html> so Turbo body swaps never cache or wipe it.
    Object.assign(pinsHost.style, {position: "absolute", top: "0", left: "0", width: "0", height: "0", zIndex: String(PIN_Z)})
    const shadow = pinsHost.attachShadow({mode: "open"})
    guardFieldKeystrokes(shadow) // the comment popover's textarea lives in here
    const style = document.createElement("style")
    style.textContent = PINS_CSS
    shadow.appendChild(style)
    const wrap = document.createElement("div")
    wrap.className = "wrap"
    shadow.appendChild(wrap)
    pinsHost._wrap = wrap
    document.documentElement.appendChild(pinsHost)
  }

  function teardownPinsOverlay() {
    closePopover()
    if (pinsHost) {
      pinsHost.remove()
      pinsHost = null
    }
    draftPin = null
  }

  // Hover affordance while picking an element to comment on. The class lands
  // on page elements, so it must be cleared before Turbo caches the body.
  function ensureCommentStyles() {
    if (document.getElementById("rb-comment-styles")) return
    const style = document.createElement("style")
    style.id = "rb-comment-styles"
    style.setAttribute(IGNORE_ATTR, "")
    style.textContent = `.${COMMENT_OUTLINE_CLASS}{outline:2px solid #5e6ad2 !important;outline-offset:1px;cursor:pointer !important;}`
    document.documentElement.appendChild(style)
  }

  function clearCommentHighlight() {
    if (commentHovered) commentHovered.classList.remove(COMMENT_OUTLINE_CLASS)
    commentHovered = null
  }

  function armCommentMode() {
    if (mode !== "comment") clearCommentHighlight()
  }

  function onCommentMouseMove(event) {
    if (!review.active || mode !== "comment" || event.shiftKey) return
    const el = event.target
    if (!(el instanceof Element) || el.hasAttribute(IGNORE_ATTR) || el.closest(`[${IGNORE_ATTR}]`)) {
      clearCommentHighlight()
      return
    }
    ensureCommentStyles()
    if (el === commentHovered) return
    clearCommentHighlight()
    commentHovered = el
    el.classList.add(COMMENT_OUTLINE_CLASS)
  }

  function onCommentClick(event) {
    // Shift-clicks stay with the issue filer, which listens on the same
    // capture phase — both features can be armed at once.
    if (!review.active || mode !== "comment" || event.shiftKey) return
    const el = event.target
    if (!(el instanceof Element) || el.hasAttribute(IGNORE_ATTR) || el.closest(`[${IGNORE_ATTR}]`)) return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    const rect = el.getBoundingClientRect()
    draftPin = {
      target: el,
      anchor: {
        domPath: cssPathParts(el).join(" > "),
        offsetX: rect.width ? (event.clientX - rect.left) / rect.width : 0.5,
        offsetY: rect.height ? (event.clientY - rect.top) / rect.height : 0.5,
        pageX: event.pageX,
        pageY: event.pageY
      },
      x: event.pageX,
      y: event.pageY
    }
    clearCommentHighlight()
    renderPins()
    openPopover({x: event.pageX, y: event.pageY})
  }

  function resolveAnchor(domPath) {
    if (!domPath) return null
    try {
      return document.querySelector(domPath)
    } catch (_e) {
      return null
    }
  }

  // Where a comment's pin belongs right now: re-anchored to its element when
  // the DOM path still resolves, its recorded page coordinates otherwise.
  function pinPosition(item) {
    const anchor = item.anchor || {}
    const el = resolveAnchor(anchor.domPath)
    if (el) {
      const rect = el.getBoundingClientRect()
      return {
        x: rect.left + window.scrollX + rect.width * (anchor.offsetX ?? 0.5),
        y: rect.top + window.scrollY + rect.height * (anchor.offsetY ?? 0.5)
      }
    }
    return {x: anchor.pageX || 0, y: anchor.pageY || 0}
  }

  function commentsForPage() {
    return review.items.filter(
      (i) => i.kind === "comment" && i.host === window.location.host && i.path === window.location.pathname
    )
  }

  function renderPins() {
    if (!review.active) return
    ensurePinsOverlay()
    // Never rebuild under an open popover — it would eat the caret. The
    // popover re-renders pins when it closes.
    if (popover) return
    const wrap = pinsHost._wrap
    wrap.querySelectorAll(".pin").forEach((p) => p.remove())

    for (const item of commentsForPage()) {
      const {x, y} = pinPosition(item)
      const pin = document.createElement("button")
      pin.className = "pin"
      pin.textContent = String(item.number || "•")
      pin.style.left = `${x}px`
      pin.style.top = `${y}px`
      pin.title = item.text || "Comment"
      pin.onclick = (e) => {
        e.stopPropagation()
        openPopover({x, y, item})
      }
      wrap.appendChild(pin)
    }

    if (draftPin) {
      const pin = document.createElement("button")
      pin.className = "pin draft"
      pin.textContent = String(nextCommentNumber())
      pin.style.left = `${draftPin.x}px`
      pin.style.top = `${draftPin.y}px`
      wrap.appendChild(pin)
    }
  }

  function openPopover({x, y, item = null}) {
    closePopover({keepDraft: true})
    ensurePinsOverlay()
    const el = document.createElement("div")
    el.className = "popover"
    // Keep the popover on-screen: flip left of the pin near the right edge,
    // and never above the bar.
    const width = 300
    const left = Math.max(window.scrollX + 8, Math.min(x + 14, window.scrollX + window.innerWidth - width - 12))
    const top = Math.max(window.scrollY + BAR_HEIGHT + 8, y + 12)
    el.style.left = `${left}px`
    el.style.top = `${top}px`

    const heading = item ? `Comment ${item.number}` : "Comment"
    const elementLine = (item ? item.label : draftPin && draftPin.target ? describeElement(draftPin.target) : "") || ""
    el.innerHTML = `
      <div class="head"><b>${escapeHtml(heading)}</b><span class="sp"></span><button class="x" title="Close">✕</button></div>
      <textarea placeholder="Describe the issue or suggestion…">${escapeHtml(item ? item.text || "" : "")}</textarea>
      ${elementLine ? `<div class="el">${escapeHtml(elementLine)}</div>` : ""}
      <div class="actions">
        ${item ? `<button class="danger" data-act="delete">Delete</button>` : ""}
        <span class="sp"></span>
        <button class="ghost" data-act="cancel">Cancel</button>
        <button class="primary" data-act="save">${item ? "Save" : "Add comment"}</button>
      </div>
    `
    pinsHost._wrap.appendChild(el)
    popover = {el, itemId: item ? item.id : null}

    const textarea = el.querySelector("textarea")
    textarea.focus()
    textarea.addEventListener("keydown", (ev) => {
      ev.stopPropagation() // page hotkeys must not fire while typing
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault()
        save()
      } else if (ev.key === "Escape") {
        ev.preventDefault()
        closePopover()
      }
    })

    const save = () => {
      const text = textarea.value.trim()
      if (!text) {
        textarea.focus()
        return
      }
      if (item) {
        saveExistingComment(item.id, text)
      } else {
        createComment(text)
      }
    }
    el.querySelector(".x").onclick = () => closePopover()
    el.querySelector('[data-act="cancel"]').onclick = () => closePopover()
    el.querySelector('[data-act="save"]').onclick = save
    const deleteBtn = el.querySelector('[data-act="delete"]')
    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        closePopover()
        await removeItem(item.id)
      }
    }
  }

  function closePopover({keepDraft = false} = {}) {
    if (popover) {
      popover.el.remove()
      popover = null
    }
    if (!keepDraft) draftPin = null
    renderPins()
  }

  async function createComment(text) {
    if (!draftPin) return
    const {anchor} = draftPin
    const target = draftPin.target && draftPin.target.isConnected ? draftPin.target : resolveAnchor(anchor.domPath)
    const number = nextCommentNumber()
    const body = target ? buildReport(target) : `**URL:** ${window.location.href}`
    const label = target ? describeElement(target) : ""

    // Close the popover before the screenshot so it doesn't cover the element;
    // two frames let its removal actually paint.
    if (popover) {
      popover.el.remove()
      popover = null
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const image = target ? await captureElement(target) : null

    draftPin = null
    const result = await addItem({
      kind: "comment",
      number,
      text,
      body,
      label,
      image,
      url: window.location.href,
      host: window.location.host,
      path: window.location.pathname,
      anchor
    })
    if (!result.ok) flashBar(result.error, "err")
    renderPins()
  }

  async function saveExistingComment(id, text) {
    closePopover()
    await updateItem(id, {text})
  }

  // ── Send panel ───────────────────────────────────────────────────────
  // The bar's primary action: title + instruction + team/project pickers
  // (prefilled from the draft and the composer's cached lists), a summary of
  // what's gathered, and the POST that files the review and pushes it into
  // the connected Claude Code session.

  // Tokens, controls and buttons come from shared.js, so this panel and the
  // shift-click composer are visibly the same product.
  const SEND_CSS = `
    ${OVERLAY_TOKENS}
    ${OVERLAY_CONTROLS}
    .panel {
      position: fixed; z-index: 2147483647; right: 16px; top: ${BAR_HEIGHT + 12}px; width: 400px;
      max-height: calc(100vh - ${BAR_HEIGHT + 28}px);
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--c-panel); color: var(--c-text); color-scheme: dark;
      border: 1px solid var(--c-border); border-radius: 8px;
      box-shadow: 0 16px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.04);
      font: 13px/1.5 var(--font); -webkit-font-smoothing: antialiased;
    }
    .head {
      flex: none; display: flex; align-items: center; gap: 8px;
      padding: 9px 10px 9px 12px; border-bottom: 1px solid var(--c-border-soft);
    }
    .head b { font-size: 12px; font-weight: 600; color: var(--c-text); }
    .sp { flex: 1; }
    /* One scroll region, so the send buttons stay pinned and reachable. */
    .body {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
      padding: 12px; display: flex; flex-direction: column; gap: 10px;
    }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    #rs-note { min-height: 76px; }
    .sum { font-size: 11px; line-height: 1.45; color: var(--c-faint); }
    .foot {
      flex: none; padding: 10px 12px; border-top: 1px solid var(--c-border-soft);
      background: var(--c-panel); display: flex; flex-direction: column; gap: 8px;
    }
    .bar-row { display: flex; align-items: center; gap: 8px; }
  `

  let sendHost = null
  let submitting = false
  let projectsFetched = false
  let labelsFetched = false

  async function openSendPanel() {
    if (!review.items.length) {
      flashBar("Add mark-up or comments first.", "err")
      return
    }
    // Snapshot any drawing still pending so the summary — and the payload —
    // include the freshest strokes.
    await flushMarkupSnapshot()
    ensureSendHost()
    renderSendPanel()
  }

  function ensureSendHost() {
    if (sendHost && sendHost.isConnected) return
    sendHost = document.createElement("div")
    sendHost.setAttribute(IGNORE_ATTR, "")
    sendHost.setAttribute(CHROME_ATTR, "")
    const shadow = sendHost.attachShadow({mode: "open"})
    guardFieldKeystrokes(shadow) // rs-title / rs-note keystrokes stay inside the panel
    const style = document.createElement("style")
    style.textContent = SEND_CSS
    shadow.appendChild(style)
    const panel = document.createElement("div")
    panel.className = "panel"
    shadow.appendChild(panel)
    panel.addEventListener("keydown", (e) => {
      e.stopPropagation() // page hotkeys must not fire while typing
      if (e.key === "Escape") {
        e.preventDefault()
        closeSendPanel()
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        submitReview()
      }
    })
    sendHost._panel = panel
    document.documentElement.appendChild(sendHost)
  }

  function closeSendPanel() {
    submitting = false
    projectsFetched = false // refetch the project list next time the panel opens
    labelsFetched = false // ditto for the label list
    if (sendHost) {
      sendHost.remove()
      sendHost = null
    }
  }

  function firstTeamKey() {
    return ((config.teams || [])[0] && (config.teams || [])[0].key) || ""
  }

  function labelsForTeam(teamKey) {
    return (config.labels || []).filter((label) => !label.team || !teamKey || label.team === teamKey)
  }

  function labelOptionsForTeam(teamKey, selected) {
    const labels = labelsForTeam(teamKey)
    const selectedId = labels.some((label) => String(label.id) === String(selected)) ? String(selected) : ""
    return [`<option value=""${selectedId === "" ? " selected" : ""}>No label</option>`]
      .concat(
        labels.map((label) => {
          const id = String(label.id)
          const name = label.team && !teamKey ? `${label.team} · ${label.name}` : label.name
          return `<option value="${escapeAttr(id)}"${id === selectedId ? " selected" : ""}>${escapeHtml(name)}</option>`
        })
      )
      .join("")
  }

  function renderSendPanel() {
    if (!sendHost) return
    const panel = sendHost._panel

    if (!isConfigured()) {
      panel.innerHTML = `
        <div class="head">
          <b>Send review</b>
          <span class="sp"></span>
          <button class="x" type="button" title="Close" aria-label="Close">${ICON.close}</button>
        </div>
        <div class="body">
          <p class="cfg">Connect the extension to your workspace first — set the app URL and API token in settings.</p>
        </div>
        <div class="foot">
          <div class="bar-row">
            <button class="ghost" type="button" data-act="cancel">Close</button>
            <span class="sp"></span>
            <button class="primary" type="button" data-act="settings">Open settings</button>
          </div>
        </div>`
      panel.querySelector(".x").onclick = closeSendPanel
      panel.querySelector('[data-act="cancel"]').onclick = closeSendPanel
      panel.querySelector('[data-act="settings"]').onclick = () => sendMessage({type: "OPEN_OPTIONS"})
      return
    }

    const draftTitle = review.draft.title || `Review of ${window.location.host}`
    const draftNote = review.draft.note || ""
    const draftTeam = review.draft.team || config.team || ""
    const draftProject = review.draft.project !== undefined ? review.draft.project : config.lastProject || ""
    // Like the project, the label defaults to the last one filed with; a
    // touched picker (including "No label") lives on the draft and wins.
    const draftLabel = review.draft.label !== undefined ? review.draft.label : config.lastLabel || ""
    const effectiveTeam = draftTeam || firstTeamKey()
    const labelOptions = labelOptionsForTeam(effectiveTeam, draftLabel)

    // Like the composer: the account picker only appears when the user belongs
    // to more than one workspace (the token is user-level).
    const accountOptions = (config.accounts || []).length > 1
      ? (config.accounts || [])
          .map((a) => `<option value="${escapeAttr(String(a.id))}"${String(a.id) === String(config.accountId) ? " selected" : ""}>${escapeHtml(a.name)}</option>`)
          .join("")
      : ""
    const teamOptions = (config.teams || [])
      .map((t) => `<option value="${escapeAttr(t.key)}"${t.key === draftTeam ? " selected" : ""}>${escapeHtml(t.key)} — ${escapeHtml(t.name)}</option>`)
      .join("")
    const projectOptions = [`<option value=""${draftProject === "" ? " selected" : ""}>No project</option>`]
      .concat(
        (config.projects || []).map((p) => {
          const id = String(p.id)
          const emoji = p.icon ? `${p.icon} ` : ""
          const label = p.team ? `${emoji}${p.team} · ${p.name}` : `${emoji}${p.name}`
          return `<option value="${escapeAttr(id)}"${id === String(draftProject) ? " selected" : ""}>${escapeHtml(label)}</option>`
        })
      )
      .join("")

    panel.innerHTML = `
      <div class="head">
        <b>Send review to Claude Code</b>
        <span class="sp"></span>
        <button class="x" type="button" title="Close" aria-label="Close">${ICON.close}</button>
      </div>
      <div class="body">
        <div class="field">
          <label class="lbl" for="rs-note">Instruction for the AI</label>
          <textarea id="rs-note" rows="3" placeholder="What should Claude Code do with this review?">${escapeHtml(draftNote)}</textarea>
        </div>
        <div class="field">
          <label class="lbl" for="rs-title">Title</label>
          <input type="text" id="rs-title" value="${escapeAttr(draftTitle)}">
        </div>
        ${accountOptions ? `<div class="field"><label class="lbl" for="rs-account">Account</label><select id="rs-account">${accountOptions}</select></div>` : ""}
        ${teamOptions ? `<div class="field"><label class="lbl" for="rs-team">Team</label><select id="rs-team">${teamOptions}</select></div>` : ""}
        <div class="grid2">
          <div class="field"><label class="lbl" for="rs-project">Project</label><select id="rs-project">${projectOptions}</select></div>
          <div class="field"><label class="lbl" for="rs-label">Label</label><select id="rs-label">${labelOptions}</select></div>
        </div>
        <div class="sum">${escapeHtml(countsLabel())} · files as one issue, pushed straight into your Claude Code session</div>
      </div>
      <div class="foot">
        <span class="msg" id="rs-msg"></span><div class="bar-row">
          <span class="sp"></span>
          <button class="ghost" type="button" data-act="copy" title="File the review and copy its prompt — with hosted image URLs — to paste into any Claude Code session">Copy for Claude Code</button>
          <button class="primary" type="button" data-act="send">Send to Claude Code</button>
        </div>
      </div>`

    const titleInput = panel.querySelector("#rs-title")
    const noteInput = panel.querySelector("#rs-note")
    const accountSelect = panel.querySelector("#rs-account")
    const teamSelect = panel.querySelector("#rs-team")
    const projectSelect = panel.querySelector("#rs-project")
    const labelSelect = panel.querySelector("#rs-label")
    titleInput.addEventListener("input", () => {
      review.draft.title = titleInput.value
      saveDraft()
    })
    noteInput.addEventListener("input", () => {
      review.draft.note = noteInput.value
      saveDraft()
    })
    if (accountSelect) {
      accountSelect.addEventListener("change", async () => {
        if (submitting) return
        const switching = panel.querySelector("#rs-msg")
        if (switching) {
          switching.className = "msg"
          switching.textContent = "Switching account…"
        }
        const res = await sendMessage({type: "SWITCH_ACCOUNT", payload: {id: accountSelect.value}})
        // The old account's picks mean nothing in the new one; the new
        // account's remembered last-used values (restored by the switch) fill
        // the pickers instead.
        delete review.draft.team
        delete review.draft.project
        delete review.draft.label
        saveDraft()
        const refreshed = Boolean(res?.ok && !res.warning)
        projectsFetched = refreshed
        labelsFetched = refreshed
        await loadConfig()
        renderSendPanel()
        const msg = sendHost && sendHost._panel && sendHost._panel.querySelector("#rs-msg")
        if (msg) {
          msg.className = "msg " + (refreshed ? "ok" : "err")
          msg.textContent = refreshed
            ? `Switched to ${res.account || "the account"}.`
            : res?.warning || res?.error || "Could not switch account."
        }
      })
    }
    if (teamSelect) {
      teamSelect.addEventListener("change", () => {
        review.draft.team = teamSelect.value
        const teamKey = teamSelect.value || firstTeamKey()
        if (!labelsForTeam(teamKey).some((label) => String(label.id) === String(review.draft.label))) {
          review.draft.label = ""
        }
        saveDraft()
        renderSendPanel()
      })
    }
    projectSelect.addEventListener("change", () => {
      review.draft.project = projectSelect.value
      saveDraft()
    })
    labelSelect.addEventListener("change", () => {
      review.draft.label = labelSelect.value
      saveDraft()
    })
    panel.querySelector(".x").onclick = closeSendPanel
    panel.querySelector('[data-act="send"]').onclick = () => submitReview()
    panel.querySelector('[data-act="copy"]').onclick = () => submitReview({copy: true})

    // Refresh the project picker once per panel session, like the composer.
    if (!projectsFetched) {
      projectsFetched = true
      refreshReviewProjects()
    }
    if (!labelsFetched) {
      labelsFetched = true
      refreshReviewLabels()
    }
  }

  async function refreshReviewProjects() {
    const res = await sendMessage({type: "LIST_PROJECTS"})
    if (res?.ok && Array.isArray(res.projects)) {
      config.projects = res.projects
      if (sendHost && !submitting && !isTypingInReview()) renderSendPanel()
    }
  }

  async function refreshReviewLabels() {
    const res = await sendMessage({type: "LIST_LABELS"})
    if (res?.ok && Array.isArray(res.labels)) {
      config.labels = res.labels
      if (sendHost && !submitting && !isTypingInReview()) renderSendPanel()
    }
  }

  // Send and Copy share the whole pipeline — both file the review as an issue
  // (that's what turns the local screenshots into hosted image URLs). Send
  // pushes it through the channel; Copy skips the push and puts the rendered
  // prompt (with those URLs) on the clipboard instead, for pasting into any
  // Claude Code session.
  async function submitReview({copy = false} = {}) {
    if (submitting || !sendHost) return
    const panel = sendHost._panel
    const titleInput = panel.querySelector("#rs-title")
    const noteInput = panel.querySelector("#rs-note")
    const teamSelect = panel.querySelector("#rs-team")
    const projectSelect = panel.querySelector("#rs-project")
    const labelSelect = panel.querySelector("#rs-label")
    const msg = panel.querySelector("#rs-msg")
    const sendBtn = panel.querySelector('[data-act="send"]')
    const copyBtn = panel.querySelector('[data-act="copy"]')
    if (!msg || !sendBtn) return

    if (!review.items.length) {
      msg.className = "msg err"
      msg.textContent = "Add mark-up or comments first."
      return
    }

    submitting = true
    sendBtn.disabled = true
    if (copyBtn) copyBtn.disabled = true
    msg.className = "msg"
    msg.textContent = copy ? "Filing & copying…" : "Sending…"

    await flushMarkupSnapshot()
    const res = await sendMessage({
      type: "SEND_REVIEW",
      payload: {
        title: (titleInput?.value || "").trim(),
        note: noteInput ? noteInput.value.trim() : "",
        team: teamSelect ? teamSelect.value : review.draft.team || config.team || "",
        project: projectSelect ? projectSelect.value : "",
        label: labelSelect ? labelSelect.value : review.draft.label || "",
        sendToClaude: !copy,
        includePrompt: copy,
        items: review.items.map((i) => ({
          kind: i.kind,
          number: i.number,
          text: i.text,
          body: i.body,
          url: i.url,
          image: i.image
        }))
      }
    })

    if (res?.ok) {
      const copied = copy ? await copyTextToClipboard(res.prompt) : false
      if (copied) playSound("copied")
      msg.className = "msg ok"
      const link = `<a href="${escapeAttr(res.url)}" target="_blank" rel="noopener">${escapeHtml(res.identifier)}</a>`
      if (copy) {
        // The issue exists either way; if the clipboard was blocked, the
        // issue page's "Copy as prompt" has the same text.
        msg.innerHTML = copied
          ? `Copied for Claude Code — filed ${link} ✓`
          : `Filed ${link} — clipboard blocked, use “Copy as prompt” there`
      } else {
        msg.innerHTML = res.sent
          ? `Sent ${link} to Claude Code ✓`
          : `Filed ${link} — no Claude Code channel connected`
      }
      const actionBtn = copy && copyBtn ? copyBtn : sendBtn
      actionBtn.textContent = copy ? "Copied" : "Done"
      await clearSession()
      setTimeout(closeSendPanel, 3200)
    } else {
      submitting = false
      sendBtn.disabled = false
      if (copyBtn) copyBtn.disabled = false
      msg.className = "msg err"
      msg.textContent = res?.error || "Could not send the review."
    }
  }

  // ── Mark up mode ──────────────────────────────────────────────────────
  // A fixed, viewport-sized canvas redrawn on scroll: strokes are stored in
  // PAGE coordinates so they stay glued to the content they annotate, and the
  // canvas translates them by the current scroll offset each frame. Strokes
  // live in memory per page (they survive Turbo navigations, which keep this
  // script's context) — durability comes from the snapshot model below, not
  // from re-hydrating vectors.
  //
  // Snapshot model: after every committed stroke (and undo), a debounced
  // CAPTURE_TAB composites the drawings into a screenshot stored as a markup
  // item — replaced in place as the drawing evolves, keyed by page +
  // half-viewport scroll band so drawing in two screenfuls yields two items.
  // Eager capture means navigating away loses at most the last ~900ms of
  // drawing; unload has nothing to do.

  const MARKUP_Z = 2147483645 // below the bar, above everything else
  const STROKE_WIDTH = 3
  const MARKUP_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6"]
  const MARKUP_TOOLS = [
    ["pen", "✏️", "Pen — freehand"],
    ["rect", "▭", "Box"],
    ["arrow", "➚", "Arrow"],
    ["text", "T", "Text label"]
  ]
  const SNAPSHOT_DEBOUNCE_MS = 900

  let markupHost = null
  let markupCanvas = null
  let markupTool = "pen"
  let markupColor = MARKUP_COLORS[0]
  let liveStroke = null // the stroke being drawn right now
  const strokesByPage = new Map() // pageKey → [stroke]
  const liveMarkupIds = new Map() // `${pageKey}::${band}` → review item id
  let snapshotTimer = null
  let redrawQueued = false

  const pageKey = () => window.location.host + window.location.pathname

  function strokesForPage() {
    const key = pageKey()
    if (!strokesByPage.has(key)) strokesByPage.set(key, [])
    return strokesByPage.get(key)
  }

  const MARKUP_CSS = `
    :host { all: initial; }
    canvas {
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
      z-index: ${MARKUP_Z}; pointer-events: none;
    }
    canvas.armed { pointer-events: auto; cursor: crosshair; }
    input.label {
      position: fixed; z-index: ${MARKUP_Z + 1}; box-sizing: border-box; min-width: 160px;
      background: rgba(14, 16, 19, .95); border: 1px solid #5e6ad2; border-radius: 6px;
      padding: 4px 8px; font: 600 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    input.label:focus { outline: none; }
  `

  function ensureMarkupOverlay() {
    if (markupHost && markupHost.isConnected) return
    markupHost = document.createElement("div")
    markupHost.setAttribute(IGNORE_ATTR, "")
    const shadow = markupHost.attachShadow({mode: "open"})
    guardFieldKeystrokes(shadow) // the inline text-label input lives in here
    const style = document.createElement("style")
    style.textContent = MARKUP_CSS
    shadow.appendChild(style)
    markupCanvas = document.createElement("canvas")
    shadow.appendChild(markupCanvas)
    document.documentElement.appendChild(markupHost)

    markupCanvas.addEventListener("pointerdown", onMarkupPointerDown)
    markupCanvas.addEventListener("pointermove", onMarkupPointerMove)
    markupCanvas.addEventListener("pointerup", onMarkupPointerUp)
    markupCanvas.addEventListener("pointercancel", onMarkupPointerUp)

    sizeMarkupCanvas()
    armMarkupMode()
    redrawMarkup()
  }

  function teardownMarkupOverlay() {
    if (markupHost) {
      markupHost.remove()
      markupHost = null
      markupCanvas = null
    }
    liveStroke = null
  }

  function armMarkupMode() {
    if (markupCanvas) markupCanvas.classList.toggle("armed", mode === "markup")
  }

  function sizeMarkupCanvas() {
    if (!markupCanvas) return
    const dpr = window.devicePixelRatio || 1
    markupCanvas.width = Math.round(window.innerWidth * dpr)
    markupCanvas.height = Math.round(window.innerHeight * dpr)
  }

  function queueRedraw() {
    if (redrawQueued) return
    redrawQueued = true
    requestAnimationFrame(() => {
      redrawQueued = false
      redrawMarkup()
    })
  }

  function redrawMarkup() {
    if (!markupCanvas) return
    const ctx = markupCanvas.getContext("2d")
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, markupCanvas.width, markupCanvas.height)
    // Draw in CSS pixels, translated from page space to the current viewport.
    ctx.setTransform(dpr, 0, 0, dpr, -window.scrollX * dpr, -window.scrollY * dpr)
    for (const stroke of strokesForPage()) drawStroke(ctx, stroke)
    if (liveStroke) drawStroke(ctx, liveStroke)
  }

  function drawStroke(ctx, stroke) {
    ctx.strokeStyle = stroke.color
    ctx.fillStyle = stroke.color
    ctx.lineWidth = STROKE_WIDTH
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    const pts = stroke.points || []
    if (stroke.tool === "pen" && pts.length) {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.stroke()
    } else if (stroke.tool === "rect" && pts.length > 1) {
      const [a, b] = [pts[0], pts[pts.length - 1]]
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    } else if (stroke.tool === "arrow" && pts.length > 1) {
      const [a, b] = [pts[0], pts[pts.length - 1]]
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      const angle = Math.atan2(b.y - a.y, b.x - a.x)
      const head = 13
      ctx.beginPath()
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6))
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6))
      ctx.stroke()
    } else if (stroke.tool === "text" && stroke.text) {
      ctx.font = "600 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
      // A soft dark plate behind the label keeps it readable on any page.
      const metrics = ctx.measureText(stroke.text)
      ctx.save()
      ctx.fillStyle = "rgba(14, 16, 19, .78)"
      ctx.fillRect(stroke.x - 4, stroke.y - 15, metrics.width + 8, 21)
      ctx.restore()
      ctx.fillText(stroke.text, stroke.x, stroke.y)
    }
  }

  function onMarkupPointerDown(e) {
    if (mode !== "markup" || e.button !== 0) return
    e.preventDefault()
    if (markupTool === "text") {
      openTextLabelInput(e)
      return
    }
    markupCanvas.setPointerCapture?.(e.pointerId)
    liveStroke = {tool: markupTool, color: markupColor, points: [{x: e.pageX, y: e.pageY}]}
    queueRedraw()
  }

  function onMarkupPointerMove(e) {
    if (!liveStroke) return
    e.preventDefault()
    liveStroke.points.push({x: e.pageX, y: e.pageY})
    queueRedraw()
  }

  function onMarkupPointerUp(e) {
    if (!liveStroke) return
    e.preventDefault()
    // A bare click with pen/box/arrow draws nothing worth keeping.
    const stroke = liveStroke
    liveStroke = null
    if (stroke.points.length > 1) {
      strokesForPage().push(stroke)
      scheduleMarkupSnapshot()
    }
    queueRedraw()
  }

  // The text tool: click → an inline input at that spot; Enter commits it as
  // a stroke, Escape (or an empty blur) cancels.
  function openTextLabelInput(e) {
    const shadow = markupHost.shadowRoot
    const existing = shadow.querySelector("input.label")
    if (existing) existing.remove()
    const input = document.createElement("input")
    input.className = "label"
    input.placeholder = "Label…"
    input.style.left = `${e.clientX}px`
    input.style.top = `${e.clientY - 14}px`
    input.style.color = markupColor
    shadow.appendChild(input)
    input.focus()

    // `done` guards the two ways this can double-fire: Enter commits and the
    // input's removal may blur it (committing again), and Escape's removal
    // must not let the blur handler commit a cancelled label.
    let done = false
    const commit = () => {
      if (done) return
      done = true
      const text = input.value.trim()
      input.remove()
      if (!text) return
      strokesForPage().push({tool: "text", color: markupColor, text, x: e.pageX, y: e.pageY})
      queueRedraw()
      scheduleMarkupSnapshot()
    }
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation()
      if (ev.key === "Enter") {
        commit()
      } else if (ev.key === "Escape") {
        done = true
        input.remove()
      }
    })
    input.addEventListener("blur", commit)
  }

  function undoMarkupStroke() {
    const strokes = strokesForPage()
    if (!strokes.length) return
    strokes.pop()
    queueRedraw()
    scheduleMarkupSnapshot()
  }

  // ── Markup snapshots ─────────────────────────────────────────────────
  // Every stroke added or undone comes through here, so it is also where the bar
  // learns whether "Add reference" has anything to capture. The snapshot itself
  // is debounced; the button must not be.
  function scheduleMarkupSnapshot() {
    if (barHost) renderBar()
    if (snapshotTimer) clearTimeout(snapshotTimer)
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null
      takeMarkupSnapshot()
    }, SNAPSHOT_DEBOUNCE_MS)
  }

  // Fire a pending snapshot immediately (mode/bar close, navigation, send).
  // Returns the capture promise so callers that CAN wait (send) do.
  function flushMarkupSnapshot() {
    if (!snapshotTimer) return Promise.resolve()
    clearTimeout(snapshotTimer)
    snapshotTimer = null
    return takeMarkupSnapshot()
  }

  // Half-viewport bands: drawing across two screenfuls produces two items,
  // each captured where the user actually drew, without ever auto-scrolling
  // the page under them.
  const scrollBand = () => Math.round(window.scrollY / Math.max(1, window.innerHeight * 0.5))

  // The page as annotated: mark-up strokes and comment pins composited in by the
  // compositor (they're real DOM), our panels hidden by captureTab, and the band
  // the bar reserves at the top cropped away — it's chrome, not page content.
  async function captureAnnotatedViewport() {
    const response = await captureTab()
    if (!response?.ok) return {ok: false, error: response?.error || "Could not capture the page."}

    let img
    try {
      img = await shared.loadImage(response.dataUrl)
    } catch (_e) {
      return {ok: false, error: "Could not read the captured page."}
    }

    const scaleY = img.naturalHeight / window.innerHeight
    const sy = Math.round(BAR_HEIGHT * scaleY)
    const canvas = document.createElement("canvas")
    canvas.width = img.naturalWidth
    canvas.height = Math.max(1, img.naturalHeight - sy)
    const ctx = canvas.getContext("2d")
    ctx.drawImage(img, 0, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
    try {
      return {ok: true, image: canvas.toDataURL("image/png")}
    } catch (_e) {
      return {ok: true, image: response.dataUrl} // tainted canvas — ship the uncropped shot
    }
  }

  async function takeMarkupSnapshot() {
    const key = pageKey()
    const strokes = strokesByPage.get(key) || []

    // Everything undone → drop the live items this context created for the page.
    if (!strokes.length) {
      for (const [bandKey, itemId] of Array.from(liveMarkupIds)) {
        if (bandKey.startsWith(`${key}::`)) {
          liveMarkupIds.delete(bandKey)
          await removeItem(itemId)
        }
      }
      return
    }

    const shot = await captureAnnotatedViewport()
    if (!shot.ok) {
      flashBar(shot.error, "err")
      return
    }
    const image = shot.image

    const bandKey = `${key}::${scrollBand()}`
    const result = await addItem(
      {
        kind: "markup",
        image,
        url: window.location.href,
        host: window.location.host,
        path: window.location.pathname
      },
      {replaceId: liveMarkupIds.get(bandKey) || null}
    )
    if (result.ok) {
      liveMarkupIds.set(bandKey, result.item.id)
    } else {
      flashBar(result.error, "err")
    }
  }

  // ── Store → UI reactions ──────────────────────────────────────────────
  async function onActiveChanged() {
    if (review.active) {
      mountBar()
      ensureMarkupOverlay()
      ensurePinsOverlay()
      renderPins()
    } else {
      mode = "browse"
      applyMode()
      clearCommentHighlight()
      closeSendPanel()
      // Capture any pending drawing BEFORE the overlay comes down, or the
      // screenshot would miss the strokes it exists to record.
      await flushMarkupSnapshot()
      teardownMarkupOverlay()
      teardownPinsOverlay()
      unmountBar()
    }
  }

  function onItemsChanged() {
    if (barHost) renderBar()
    if (review.active) renderPins()
  }

  function isTypingInReview() {
    return [barHost, pinsHost, sendHost].some((host) => {
      const ae = host && host.shadowRoot && host.shadowRoot.activeElement
      return Boolean(ae && ["INPUT", "TEXTAREA", "SELECT"].includes(ae.tagName))
    })
  }

  // ── Boot ─────────────────────────────────────────────────────────────
  async function boot() {
    await Promise.all([loadReview(), loadConfig()])
    onActiveChanged()

    // Comment mode's pick-an-element listeners live for the page's lifetime
    // and gate on (review.active && mode === "comment"), mirroring how the
    // shift-click filer arms itself.
    document.addEventListener("click", onCommentClick, true)
    document.addEventListener("mousemove", onCommentMouseMove, true)

    // The bar lives on <html> so Turbo's body swaps never cache or clobber it;
    // just re-assert the push-down margin (the new page's CSS may have reset
    // it) and refresh what the bar shows. The canvas redraw swaps in the new
    // page's strokes (usually none), clearing the old page's drawings.
    document.addEventListener("turbo:load", () => {
      if (!review.active) return
      clearFlash() // page A's status line is not page B's news
      pushPage()
      mountBar()
      queueRedraw()
      renderPins() // the new page's pins (if any) replace the old page's
    })

    // The hover outline class sits on real page elements — strip it before
    // Turbo snapshots the body, or it comes back on cache restores.
    document.addEventListener("turbo:before-cache", () => {
      clearCommentHighlight()
      closePopover()
    })

    // Strokes are drawn in page coordinates: translate on scroll, re-rasterise
    // on resize (the canvas backing store is viewport-sized).
    window.addEventListener(
      "scroll",
      () => {
        if (markupCanvas) queueRedraw()
      },
      {passive: true}
    )
    window.addEventListener(
      "resize",
      () => {
        if (markupCanvas) {
          sizeMarkupCanvas()
          queueRedraw()
        }
        if (review.active) renderPins() // anchored elements may have reflowed
      },
      {passive: true}
    )

    // Best-effort last capture when the page is about to go away — eager
    // per-stroke snapshots mean this only chases the final ~900ms of drawing.
    document.addEventListener("turbo:before-visit", () => flushMarkupSnapshot())
    window.addEventListener("pagehide", () => flushMarkupSnapshot())
  }

  boot()
})()
