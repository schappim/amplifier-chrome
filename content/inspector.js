// Shift-click issue filer — content script.
//
// Armed on every page. Hold Shift and click any element to capture:
//   - the element itself (tag / id / classes / a snippet of its text)
//   - a readable CSS path from the document root down to the element
//   - the chain of Rails views & partials the element lives inside
//   - the controller#action that rendered the page (+ its file path)
//   - the current URL
//   - a screenshot of the element (cropped from the visible tab)
//
// A small composer then lets you title and file the issue into your workspace.
//
// The element / DOM-path / view-partial / controller logic is the same technique
// used by a Rails dev inspector: the view/partial chain is recovered from the
// HTML comments Rails emits when
// `config.action_view.annotate_rendered_view_with_filenames = true`, and the
// controller#action comes from <meta name="dev-controller"> tags the page emits.
// See rails-lib/page_inspector for the drop-in that exposes those on any Rails app.

(() => {
  const INIT_FLAG = "__shiftClickIssueFiler"
  if (window[INIT_FLAG]) return
  window[INIT_FLAG] = true

  // Element-report + screenshot machinery lives in content/shared.js (loaded
  // before this script by the manifest) so the review bar captures elements
  // exactly the same way this filer does.
  const shared = window.__sciShared
  if (!shared) return
  const {
    IGNORE_ATTR,
    CHROME_ATTR,
    describeElement,
    buildReport,
    buildChromeConsoleReport,
    captureElement,
    captureDesktopArea,
    sendMessage,
    escapeHtml,
    escapeAttr,
    copyTextToClipboard,
    playSound,
    OVERLAY_TOKENS,
    OVERLAY_CONTROLS,
    OVERLAY_ICONS: ICON,
    SUBMIT_KEYS,
    guardFieldKeystrokes
  } = shared

  const OUTLINE_CLASS = "sci-hover-outline"
  const MAX_CAPTURES = 25 // keep in sync with the server's cap

  // Settings (chrome.storage.sync) and the cached workspace lists
  // (chrome.storage.local), kept apart because sync caps each item at 8KB and
  // the lists outgrow it — api.js has the long version. Content scripts each
  // run in their own scope in the isolated world, so the split is spelled out
  // here rather than shared with api.js; keep the two in step.
  const SETTING_DEFAULTS = {enabled: true, baseUrl: "", token: "", accountId: "", team: "", lastProject: "", lastLabel: ""}
  const CACHE_DEFAULTS = {accounts: [], teams: [], projects: [], labels: [], moodBoards: []}
  let config = {...SETTING_DEFAULTS, ...CACHE_DEFAULTS}
  let hovered = null
  // Fetch the mood-board list once per panel session (reset when the panel is
  // dismissed), so opening the composer shows fresh boards without refetching on
  // every cross-tab re-render.
  let boardsFetched = false
  // Same once-per-panel-session refresh for the project picker, so projects
  // added/archived since the last connect show up (and stay current).
  let projectsFetched = false
  // Same once-per-panel-session refresh for labels, so the picker reflects
  // labels added or assigned to teams since the last connect.
  let labelsFetched = false
  // True while a create/add request is in flight, so an async board-list refresh
  // (or a stray second click/keypress) can't rebuild the panel out from under the
  // request — which would detach the status line and re-enable the action button.
  let submitting = false
  // Whether the "Full captured context" dump is expanded. Module state, not a
  // <details open>: renderPanel() swaps innerHTML wholesale, so DOM-held
  // disclosure state would silently collapse on any cross-tab or refresh rebuild.
  let contextOpen = false
  // Set when a capture is added, so the next render drops the caret into the
  // instruction box — the one field the user always has to fill in. Consumed
  // once, so later rebuilds (a board-list arrival, a cross-tab sync) don't yank
  // focus back out of whatever field the user has moved on to.
  let focusNote = false

  // The capture stack lives in chrome.storage.local (extension-global) so it
  // survives navigations and works across pages/origins — you can grab an
  // element on one page, navigate anywhere, and keep adding to the same issue.
  let stack = {captures: [], draft: {}}
  let panelVisible = false
  let panelHost = null
  // Live voice-dictation session (the "Dictate" mic on the instruction field),
  // or null when not recording. Holds the WebRTC peer connection, data channel,
  // mic stream, and the transcript buffers — see startTranscription(). Kept in
  // module scope (not the DOM) so a panel rebuild mid-recording doesn't drop it.
  let transcription = null
  // Where the user has dragged the panel to, as {left, top} in viewport px.
  // Null until first dragged, in which case the panel keeps its default
  // bottom-right anchor. Persists across re-renders and same-session navigations
  // so the panel stays where you put it while you keep collecting elements.
  let panelPos = null

  // ── Config (chrome.storage) ─────────────────────────────────────────
  function loadConfig() {
    return new Promise((resolve) => {
      try {
        let pending = 2
        const merge = (stored) => {
          config = {...config, ...(stored || {})}
          if (--pending === 0) resolve(config)
        }
        chrome.storage.sync.get(SETTING_DEFAULTS, merge)
        chrome.storage.local.get(CACHE_DEFAULTS, merge)
      } catch (_e) {
        resolve(config)
      }
    })
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "sync") {
      for (const [key, {newValue}] of Object.entries(changes)) {
        if (key in SETTING_DEFAULTS) config[key] = newValue
      }
      return
    }
    if (area !== "local") return
    // The workspace lists share this area with the capture stack — an account
    // switch arrives here, so the pickers follow it without a reload.
    for (const [key, {newValue}] of Object.entries(changes)) {
      if (key in CACHE_DEFAULTS) config[key] = newValue === undefined ? CACHE_DEFAULTS[key] : newValue
    }
    if (changes.captures) {
      const next = changes.captures.newValue || []
      // Only react to changes made in another tab (ours already updated `stack`
      // and re-rendered), so typing/adding here doesn't trigger a rebuild loop.
      if (idsKey(next) !== idsKey(stack.captures)) {
        stack.captures = next
        if (changes.draft) stack.draft = changes.draft.newValue || stack.draft
        // Respect an explicit hide: only refresh a panel that's already open,
        // never force it back open in a tab where the user dismissed it. Also
        // never rebuild mid-submit (it would detach the in-flight status line).
        if (panelVisible && !submitting) renderPanel()
      }
    } else if (changes.draft && !isTypingInPanel() && !transcription) {
      // ...and never while dictating: applyTranscript()'s own debounced saveDraft
      // echoes back here, and the mic button isn't a text field so isTypingInPanel
      // wouldn't catch it — a rebuild would fight the transcript mid-utterance.
      stack.draft = changes.draft.newValue || {}
      if (panelVisible && !submitting) renderPanel()
    }
  })

  const idsKey = (list) => (list || []).map((c) => c.id).join(",")

  // ── Capture stack (chrome.storage.local) ────────────────────────────
  function loadStack() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({captures: [], draft: {}}, (s) =>
          resolve({captures: s.captures || [], draft: s.draft || {}})
        )
      } catch (_e) {
        resolve({captures: [], draft: {}})
      }
    })
  }

  // Full write — the captures array holds screenshots, so only call this when
  // captures actually change (add/remove/clear), never on every keystroke.
  function saveStack() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({captures: stack.captures, draft: stack.draft}, () => {
          const lastError = chrome.runtime?.lastError
          if (lastError) {
            console.warn("[shift-click issue filer] could not save capture:", lastError.message)
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

  // Cheap, debounced write for the title/team/project/label/note draft — never
  // re-serializes the screenshot stack, so typing stays snappy and doesn't
  // broadcast images to every open tab.
  let draftTimer = null
  function saveDraft() {
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      draftTimer = null
      try {
        chrome.storage.local.set({draft: stack.draft})
      } catch (_e) {
        /* best effort */
      }
    }, 250)
  }

  function isConfigured() {
    return Boolean(config.baseUrl && config.token)
  }

  // True when focus is in one of the panel's own fields, so a cross-tab sync
  // doesn't rebuild the panel out from under the caret.
  function isTypingInPanel() {
    const ae = panelHost && panelHost.shadowRoot && panelHost.shadowRoot.activeElement
    return Boolean(ae && ["INPUT", "TEXTAREA", "SELECT"].includes(ae.tagName))
  }

  // Re-render on behalf of the once-per-open picker refreshes.
  //
  // Those land a network round-trip after the panel opens, by which point the
  // instruction box already holds the caret (we put it there). Treating that as
  // "typing" would skip the rebuild for the whole session and strand the team /
  // project / label / board pickers on whatever chrome.storage.local last cached.
  // An empty, freshly-focused instruction box has nothing to lose from a rebuild,
  // so rebuild and put the caret straight back.
  function renderForRefresh() {
    if (!panelVisible || submitting) return
    const ae = panelHost && panelHost.shadowRoot && panelHost.shadowRoot.activeElement
    const idleInNote = Boolean(ae && ae.id === "sci-note" && !ae.value)
    if (isTypingInPanel() && !idleInNote) return
    if (idleInNote) focusNote = true
    renderPanel()
  }

  // Set the panel's inline status line, if the panel is mounted.
  function flash(text, kind = "err") {
    const msg = panelHost && panelHost._panel && panelHost._panel.querySelector("#sci-msg")
    if (msg) {
      msg.className = "msg " + kind
      msg.textContent = text
    }
  }

  // ── Page-level styles (hover outline only) ──────────────────────────
  function ensurePageStyles() {
    if (document.getElementById("sci-page-styles")) return
    const style = document.createElement("style")
    style.id = "sci-page-styles"
    style.setAttribute(IGNORE_ATTR, "")
    style.textContent = `.${OUTLINE_CLASS}{outline:2px solid #f59e0b !important;outline-offset:1px;cursor:copy !important;}`
    document.documentElement.appendChild(style)
  }

  function clearHighlight() {
    if (hovered) hovered.classList.remove(OUTLINE_CLASS)
    hovered = null
  }

  // ── Hint badge (shown while Shift is held) ──────────────────────────
  let hintEl = null
  function showHint() {
    if (hintEl) {
      hintEl.style.display = ""
      return
    }
    hintEl = document.createElement("div")
    hintEl.setAttribute(IGNORE_ATTR, "")
    hintEl.setAttribute(CHROME_ATTR, "")
    hintEl.textContent = "⇧ Shift-click to file an issue"
    Object.assign(hintEl.style, {
      position: "fixed", zIndex: "2147483646", top: "12px", right: "12px",
      padding: "6px 10px", borderRadius: "8px", background: "#11181f", color: "#f59e0b",
      font: "12px/1 ui-monospace, SFMono-Regular, Menlo, monospace",
      boxShadow: "0 6px 20px rgba(0,0,0,.4)", border: "1px solid rgba(255,255,255,.08)",
      pointerEvents: "none"
    })
    document.documentElement.appendChild(hintEl)
  }
  function hideHint() {
    if (hintEl) hintEl.style.display = "none"
  }

  // ── Composer (Shadow DOM so page CSS can't touch it) ────────────────
  //
  // Tokens, form controls and buttons come from shared.js so this panel and the
  // review bar's send panel stay the same product. What follows is only what is
  // specific to the composer.
  const COMPOSER_CSS = `
    ${OVERLAY_TOKENS}
    ${OVERLAY_CONTROLS}

    /* Shell: pinned header + one scrolling body + pinned action bar, so the
       primary action is reachable at any viewport height or capture count. */
    .panel {
      position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;
      width: 400px; max-height: min(720px, calc(100vh - 32px));
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--c-panel); color: var(--c-text); color-scheme: dark;
      border: 1px solid var(--c-border); border-radius: 8px;
      box-shadow: 0 16px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.04);
      font: 13px/1.5 var(--font); -webkit-font-smoothing: antialiased;
    }

    .head {
      flex: none; display: flex; align-items: center; gap: 8px;
      padding: 9px 10px 9px 12px; border-bottom: 1px solid var(--c-border-soft);
      cursor: move; user-select: none;
    }
    .head.dragging { cursor: grabbing; }
    .grip { flex: none; color: var(--c-faint); }
    .head b { font-size: 12px; font-weight: 600; color: var(--c-text); }
    .sp { flex: 1; }
    .count {
      font-size: 11px; font-weight: 500; color: var(--c-sec);
      background: var(--c-inset); border: 1px solid var(--c-border);
      padding: 1px 8px; border-radius: 999px; white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .count.full { color: var(--c-danger); background: var(--c-danger-bg); border-color: transparent; }

    .body {
      flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
      padding: 12px; display: flex; flex-direction: column; gap: 10px;
    }
    .body::-webkit-scrollbar { width: 10px; }
    .body::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--c-muted) 35%, transparent);
      border-radius: 6px; border: 3px solid transparent; background-clip: padding-box;
    }
    .body::-webkit-scrollbar-thumb:hover {
      background: color-mix(in srgb, var(--c-muted) 55%, transparent); background-clip: padding-box;
    }

    /* Fields — sentence-case labels (from OVERLAY_CONTROLS). No shouting. */
    .field { display: flex; flex-direction: column; gap: 4px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    #sci-note { min-height: 76px; }

    /* A field whose label shares its row with an inline action (the note's
       "Dictate" mic). The label keeps its baseline; the button sits flush right. */
    .lblrow { display: flex; align-items: center; gap: 8px; min-height: 20px; }
    /* The Dictate button reuses .mini; recording turns it into a pulsing red Stop
       so it's obvious the mic is live even at a glance. */
    button.mini.rec { color: var(--c-danger); }
    button.mini.rec svg { animation: sci-pulse 1.4s ease-in-out infinite; }
    @keyframes sci-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

    /* References card. "REFERENCES" is the panel's one uppercase label, mirroring
       the app's only legitimate use of it (a card section header). */
    .refs {
      background: var(--c-card); border: 1px solid var(--c-border-soft);
      border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px;
    }
    .refs-head { display: flex; align-items: center; gap: 8px; }
    .sec { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: .025em; color: var(--c-muted); }
    /* Adding a reference belongs with the references, not with the commit actions. */
    button.mini {
      display: inline-flex; align-items: center; gap: 5px; flex: none;
      height: 24px; padding: 0 8px; border: 0; border-radius: 5px; background: none;
      color: var(--c-sec); font: inherit; font-size: 11px; font-weight: 500; cursor: pointer;
    }
    button.mini:hover { background: var(--c-active); color: var(--c-text); }
    button.mini:disabled { opacity: .5; cursor: default; }

    .caps { display: flex; flex-direction: column; gap: 8px; }
    .cap { display: flex; flex-direction: column; gap: 6px; }
    .cap + .cap { border-top: 1px solid var(--c-border-soft); padding-top: 8px; }
    .cap-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .cap-n {
      flex: none; width: 18px; height: 18px; border-radius: 999px;
      background: var(--c-accent); color: var(--c-onaccent);
      font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .cap-thumb {
      flex: none; display: inline-block; width: 48px; height: 34px; object-fit: cover;
      border-radius: 5px; border: 1px solid var(--c-border); background: var(--c-inset);
    }
    .cap-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    /* The element's own text is what you recognise it by, so it leads in plain
       sans. Only a text-less element falls back to its selector, in mono. */
    .cap-el { font: 12px/1.4 var(--font); color: var(--c-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cap-el.mono { font: 11px/1.4 var(--mono); color: var(--c-text2); }
    .cap-src { font-size: 11px; color: var(--c-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cap-x {
      flex: none; display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border: 0; border-radius: 5px; background: none;
      color: var(--c-faint); cursor: pointer;
    }
    .cap-x:hover { color: var(--c-danger); background: var(--c-danger-bg); }
    .cap-note {
      width: 100%; min-height: 28px; height: auto; padding: 5px 7px; resize: vertical;
      font: inherit; font-size: 12px; line-height: 1.4; color: var(--c-text);
      background: var(--c-inset); border: 1px solid var(--c-border); border-radius: 6px;
    }
    .cap-note::placeholder { color: var(--c-faint); }
    .cap-note:focus { outline: none; border-color: var(--c-accent); }
    /* The caption and its dictation mic share a row; the textarea flexes, the mic
       stays a fixed square pinned to its right. */
    .cap-note-row { display: flex; align-items: flex-start; gap: 6px; }
    .cap-note-row .cap-note { flex: 1; min-width: 0; }
    .cap-mic {
      flex: none; display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border: 0; border-radius: 6px; background: none;
      color: var(--c-sec); cursor: pointer;
    }
    .cap-mic:hover { background: var(--c-active); color: var(--c-text); }
    .cap-mic:disabled { opacity: .5; cursor: default; }
    .cap-mic.rec { color: var(--c-danger); }
    .cap-mic.rec svg { animation: sci-pulse 1.4s ease-in-out infinite; }
    .tip { font-size: 11px; line-height: 1.45; color: var(--c-faint); }
    .tip b { color: var(--c-sec); font-weight: 600; }
    .empty { display: flex; flex-direction: column; gap: 4px; align-items: center; text-align: center; padding: 14px 8px; }
    .empty b { font-size: 12px; font-weight: 600; color: var(--c-sec); }
    .empty span { font-size: 11px; color: var(--c-faint); }

    /* Full captured context. A <details> would silently collapse on every
       innerHTML rebuild, so the open state lives in a module variable. */
    .ctx { display: flex; flex-direction: column; }
    .ctxhead {
      display: flex; align-items: center; gap: 6px; width: 100%;
      padding: 7px 8px; border: 0; border-radius: 6px; background: none;
      color: var(--c-sec); font: inherit; font-size: 12px; text-align: left; cursor: pointer;
    }
    .ctxhead:hover { background: var(--c-hover); color: var(--c-text); }
    .chev { flex: none; color: var(--c-faint); transition: transform .12s ease; }
    .ctxhead[aria-expanded="true"] .chev { transform: rotate(90deg); }
    .ctxpre {
      margin: 6px 0 0; padding: 10px 12px; background: var(--c-card);
      border: 1px solid var(--c-border); border-radius: 8px;
      white-space: pre-wrap; word-break: break-word;
      font: 11px/1.5 var(--mono); color: var(--c-text2);
      max-height: 240px; overflow: auto;
    }
    .ctxpre[hidden] { display: none; }

    .foot {
      flex: none; padding: 10px 12px; border-top: 1px solid var(--c-border-soft);
      background: var(--c-panel); display: flex; flex-direction: column; gap: 8px;
    }
    .bar { display: flex; align-items: center; gap: 8px; }

    button.mini:focus-visible, .ctxhead:focus-visible, .cap-x:focus-visible {
      outline: 2px solid var(--c-accent); outline-offset: 2px;
    }
  `

  // The panel host persists across re-renders; only its contents are rebuilt.
  function ensureHost() {
    if (panelHost && panelHost.isConnected) return
    panelHost = document.createElement("div")
    panelHost.setAttribute(IGNORE_ATTR, "")
    // Tool chrome: never photograph the composer into a capture of the page.
    panelHost.setAttribute(CHROME_ATTR, "")
    const shadow = panelHost.attachShadow({mode: "open"})
    // Typing in the composer's fields (title, instruction, caption, board name)
    // must never reach the host page's keyboard shortcuts — see guardFieldKeystrokes.
    guardFieldKeystrokes(shadow)
    const style = document.createElement("style")
    style.textContent = COMPOSER_CSS
    shadow.appendChild(style)
    const panel = document.createElement("div")
    panel.className = "panel"
    shadow.appendChild(panel)
    // One keydown listener for the panel's lifetime (renderPanel only swaps
    // innerHTML, so binding here avoids stacking duplicate listeners).
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault()
        hidePanel()
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        submitIssue(panel)
      }
    })
    // Drag by the header so you can move the panel off whatever's underneath it.
    // Delegated from the persistent panel element (renderPanel swaps .head away
    // on every rebuild), so it survives re-renders without stacking listeners.
    panel.addEventListener("mousedown", (e) => startDrag(e, panel))
    panelHost._panel = panel
    applyPanelPos(panel)
    document.documentElement.appendChild(panelHost)
  }

  // Re-anchor the panel to a previously dragged {left, top}. Switches off the
  // default right/bottom anchor so left/top take effect.
  function applyPanelPos(panel) {
    if (!panelPos) return
    panel.style.right = "auto"
    panel.style.bottom = "auto"
    panel.style.left = panelPos.left + "px"
    panel.style.top = panelPos.top + "px"
  }

  // Header drag. Ignores clicks on the header's buttons (e.g. ✕) so they still
  // fire, and clamps the panel to the viewport so it can't be lost off-screen.
  function startDrag(e, panel) {
    if (e.button !== 0) return
    const t = e.target
    if (!t || !t.closest || !t.closest(".head")) return
    if (t.closest("button")) return
    e.preventDefault()
    const rect = panel.getBoundingClientRect()
    const offX = e.clientX - rect.left
    const offY = e.clientY - rect.top
    const head = panel.querySelector(".head")
    if (head) head.classList.add("dragging")
    panel.style.right = "auto"
    panel.style.bottom = "auto"

    const onMove = (ev) => {
      ev.preventDefault()
      const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth)
      const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight)
      const left = Math.min(Math.max(0, ev.clientX - offX), maxLeft)
      const top = Math.min(Math.max(0, ev.clientY - offY), maxTop)
      panel.style.left = left + "px"
      panel.style.top = top + "px"
      panelPos = {left, top}
    }
    const onUp = () => {
      document.removeEventListener("mousemove", onMove, true)
      document.removeEventListener("mouseup", onUp, true)
      const h = panel.querySelector(".head")
      if (h) h.classList.remove("dragging")
    }
    document.addEventListener("mousemove", onMove, true)
    document.addEventListener("mouseup", onUp, true)
  }

  function removeHost() {
    if (panelHost) {
      panelHost.remove()
      panelHost = null
    }
  }

  function hidePanel() {
    stopTranscription() // never leave the mic live behind a dismissed panel
    panelVisible = false
    boardsFetched = false // refetch the board list next time the panel opens
    projectsFetched = false // ditto for the project list
    labelsFetched = false // ditto for the label list
    submitting = false
    contextOpen = false
    focusNote = false
    removeHost()
  }

  const newCaptureId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // Add a captured element to the stack and (re)show the panel.
  async function addCapture(el) {
    if (stack.captures.length >= MAX_CAPTURES) {
      panelVisible = true
      renderPanel()
      flash(`You can stack up to ${MAX_CAPTURES} references — file this issue first.`, "err")
      return
    }
    const body = buildReport(el)
    const label = describeElement(el)
    clearHighlight()
    hideHint()
    // Let the outline removal paint before we snapshot the tab.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const image = await captureElement(el)

    stack.captures.push({
      id: newCaptureId(),
      body,
      label,
      image: image || null,
      url: window.location.href,
      host: window.location.host,
      path: window.location.pathname
    })
    // The title is deliberately left blank: the AI names the issue from the
    // instruction and the captured elements. Seeding it with the clicked
    // element's own text only ever produced a title nobody wanted.
    if (!stack.draft.team) stack.draft.team = config.team || ""
    await saveStack()
    panelVisible = true
    focusNote = true
    renderPanel()
  }

  async function addConsoleCapture() {
    if (stack.captures.length >= MAX_CAPTURES) {
      flash(`You can stack up to ${MAX_CAPTURES} references — file this issue first.`, "err")
      return
    }

    flash("Choose the Chrome window or screen that contains DevTools.", "ok")
    const result = await captureDesktopArea({
      title: "Capture Chrome console",
      detail: "Choose the Chrome window or screen with DevTools, then crop the console area.",
      action: "Add console capture"
    })
    if (!result?.ok) {
      if (!result?.canceled) flash(result?.error || "Could not capture the Chrome console.", "err")
      return
    }

    stack.captures.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      body: buildChromeConsoleReport(),
      label: "Chrome console area",
      image: result.dataUrl,
      url: window.location.href,
      host: window.location.host,
      path: window.location.pathname,
      source: "chrome_console"
    })
    if (!stack.draft.team) stack.draft.team = config.team || ""
    await saveStack()
    panelVisible = true
    focusNote = true
    renderPanel()
    flash("Console capture added.", "ok")
  }

  // Removing the last reference leaves the panel open on its empty state rather
  // than dismissing it — the instruction you already typed is worth more than the
  // reference you just deleted, and shift-clicking another one puts you straight
  // back. "Clear all" is the deliberate way to throw the whole draft away.
  async function removeCapture(id) {
    // Releasing the reference this mic was dictating into (its caption is about
    // to disappear) — stop the session so it isn't left recording into nothing.
    if (transcription && transcription.key === "caption:" + id) stopTranscription()
    stack.captures = stack.captures.filter((c) => c.id !== id)
    if (stack.draft.captions) delete stack.draft.captions[id]
    await saveStack()
    renderPanel()
  }

  async function clearStack() {
    stopTranscription()
    stack = {captures: [], draft: {}}
    await saveStack()
    hidePanel()
  }

  // ── Voice dictation into a text field ───────────────────────────────
  //
  // A mic opens an OpenAI Realtime transcription session over WebRTC and streams
  // the speech-to-text straight into a target field as you talk — the instruction
  // box (the "Dictate" button) or any reference's caption (its inline mic). Flow:
  //   1. The workspace mints a short-lived ephemeral key (MINT_REALTIME_TOKEN) —
  //      our standard OpenAI key never reaches the browser.
  //   2. getUserMedia + an RTCPeerConnection here in the page (media APIs need a
  //      DOM); the SDP handshake is proxied through the background worker so it
  //      isn't blocked by the host page's CORS (REALTIME_SDP_EXCHANGE).
  //   3. Transcription events arrive on the data channel and land in the field.
  //
  // Only one field records at a time. While recording the target field is
  // read-only (the mic owns it); the instruction, dictated, still names the issue
  // for free because the title tracks it by default.

  const liveEl = (sel) => (panelHost && panelHost._panel ? panelHost._panel.querySelector(sel) : null)

  // A dictation target describes which field a session writes into: how to find
  // the field and its mic button, and how to persist the composed text into the
  // draft (the note also mirrors into the still-tracking title).
  function noteTarget() {
    return {
      key: "note",
      fieldSelector: "#sci-note",
      buttonSelector: '[data-act="dictate"]',
      commit(text) {
        stack.draft.note = text
        const note = liveEl("#sci-note")
        if (note) note.value = text
        if (!stack.draft.titleEdited) {
          stack.draft.title = text
          const title = liveEl("#sci-title")
          if (title) title.value = text
        }
      }
    }
  }

  function captionTarget(id) {
    const sel = `[data-caption="${id}"]`
    return {
      key: "caption:" + id,
      fieldSelector: sel,
      buttonSelector: `[data-dictate-caption="${id}"]`,
      commit(text) {
        if (!stack.draft.captions) stack.draft.captions = {}
        stack.draft.captions[id] = text
        const box = liveEl(sel)
        if (box) box.value = text
      }
    }
  }

  // Toggle dictation for a field: stop if it's already recording this one, else
  // switch the mic to it (stopping any other field's session first).
  function toggleDictation(target) {
    if (transcription && transcription.key === target.key) {
      stopTranscription("Dictation stopped.", "")
    } else {
      if (transcription) stopTranscription()
      startTranscription(target)
    }
  }

  async function startTranscription(target) {
    if (transcription) return
    const field = liveEl(target.fieldSelector)
    if (!field) return
    if (!isConfigured()) {
      flash("Set the app URL and API token in settings first.", "err")
      return
    }
    const btn = liveEl(target.buttonSelector)
    if (btn) btn.disabled = true
    flash("Starting microphone…", "ok")

    // 1) Mint the ephemeral key from the workspace (never our standard key).
    const minted = await sendMessage({type: "MINT_REALTIME_TOKEN"})
    if (!minted?.ok) {
      if (btn) btn.disabled = false
      flash(minted?.error || "Could not start dictation.", "err")
      return
    }
    const key = minted.token?.value
    if (!key) {
      if (btn) btn.disabled = false
      flash("Dictation token was malformed.", "err")
      return
    }

    // 2) Microphone. Denied/blocked mic is the common case, so name it plainly.
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: true})
    } catch (_e) {
      if (btn) btn.disabled = false
      flash("Microphone access was blocked — allow the mic and try again.", "err")
      return
    }

    // 3) Peer connection + data channel (transcription events) + the mic track.
    // `base` anchors the transcript after whatever was already in the field;
    // `done` holds finalized utterances and `live` the in-progress one (see
    // applyTranscript). The target's field/button/commit ride on the session.
    const pc = new RTCPeerConnection()
    const dc = pc.createDataChannel("oai-events")
    const existing = field.value || ""
    const base = existing && !/\s$/.test(existing) ? existing + " " : existing
    transcription = {...target, pc, dc, stream, base, done: "", live: ""}
    dc.addEventListener("message", onRealtimeEvent)
    pc.addTrack(stream.getTracks()[0], stream)
    pc.addEventListener("connectionstatechange", () => {
      if (transcription && transcription.pc === pc && ["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        stopTranscription("Dictation disconnected.", "err")
      }
    })

    try {
      // 4) SDP handshake, proxied through the background worker.
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const exchanged = await sendMessage({type: "REALTIME_SDP_EXCHANGE", payload: {key, sdp: offer.sdp}})
      // The user may have hit Stop while the handshake was in flight.
      if (!transcription || transcription.pc !== pc) return
      if (!exchanged?.ok) {
        stopTranscription(exchanged?.error || "Could not connect to OpenAI.", "err")
        return
      }
      await pc.setRemoteDescription({type: "answer", sdp: exchanged.sdp})
    } catch (e) {
      stopTranscription("Could not start dictation: " + e.message, "err")
      return
    }

    if (btn) btn.disabled = false
    const liveField = liveEl(target.fieldSelector)
    if (liveField) liveField.readOnly = true // the mic owns the field while it's live
    updateDictateButton()
    flash(target.key === "note" ? "Listening — speak your instruction, then click Stop." : "Listening — speak the caption, then click Stop.", "ok")
  }

  // Tear down the session (idempotent — safe to call when not recording). An
  // optional status message reports why we stopped.
  function stopTranscription(msg, kind) {
    const t = transcription
    if (!t) return
    transcription = null
    try {
      t.dc && t.dc.close()
    } catch (_e) {
      /* already gone */
    }
    try {
      t.stream && t.stream.getTracks().forEach((tr) => tr.stop())
    } catch (_e) {
      /* already gone */
    }
    try {
      t.pc && t.pc.close()
    } catch (_e) {
      /* already gone */
    }
    const field = liveEl(t.fieldSelector)
    if (field) field.readOnly = false
    const btn = liveEl(t.buttonSelector)
    if (btn) setDictateButtonState(btn, false)
    if (msg) flash(msg, kind || "")
  }

  // Paint a mic button for the given state. The instruction's button carries a
  // "Dictate"/"Stop" label; a caption's inline mic is icon-only.
  function setDictateButtonState(btn, on) {
    btn.classList.toggle("rec", on)
    btn.setAttribute("aria-pressed", String(on))
    const icon = on ? ICON.stop : ICON.mic
    btn.innerHTML = btn.getAttribute("data-act") === "dictate" ? `${icon}${on ? "Stop" : "Dictate"}` : icon
  }

  // Reflect the active session on its own mic button, so start/stop and any
  // rebuild agree on what it shows without a full re-render.
  function updateDictateButton() {
    if (!transcription) return
    const btn = liveEl(transcription.buttonSelector)
    if (btn) setDictateButtonState(btn, true)
  }

  // Handle a Realtime data-channel event. We only care about the input-audio
  // transcription deltas (incremental) and completed utterances (authoritative),
  // plus surfacing errors.
  function onRealtimeEvent(e) {
    if (!transcription) return
    let event
    try {
      event = JSON.parse(e.data)
    } catch (_e) {
      return
    }
    switch (event.type) {
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          transcription.live += event.delta
          applyTranscript()
        }
        break
      case "conversation.item.input_audio_transcription.completed": {
        // The completed transcript is authoritative for the utterance, so it
        // replaces the accumulated deltas rather than adding to them.
        const seg = (event.transcript || "").trim()
        if (seg) transcription.done += (transcription.done ? " " : "") + seg
        transcription.live = ""
        applyTranscript()
        break
      }
      case "error":
        stopTranscription(event.error?.message || "Dictation error.", "err")
        break
    }
  }

  // Compose the transcript and hand it to the target's commit(), which writes the
  // draft and the live field. Reads live elements each time so it survives a
  // rebuild, and keeps stack.draft the source of truth so a rebuild re-seeds it.
  function applyTranscript() {
    if (!transcription) return
    const t = transcription
    const parts = [t.done, t.live].filter(Boolean)
    const text = t.base + parts.join(t.done && t.live ? " " : "")
    t.commit(text)
    saveDraft()
  }

  // Combined preview of every captured element's report.
  function fullContext(captures) {
    return captures.map((c, i) => `— Reference ${i + 1} —\n${c.body}`).join("\n\n")
  }

  // How a capture introduces itself in the references list.
  //
  // describeElement() hands us `<a.text-[13px].text-[var(--c-e6e6e8)]> "Some text"`.
  // On a Tailwind app the class soup is both the longest and the least useful
  // part, and it is exactly what a one-line row ellipsises the text away behind.
  // So the quoted text leads; only an element with no text of its own falls back
  // to showing its selector. The full description stays on the row's tooltip and
  // in the captured-context dump either way.
  //
  // The selector group is greedy rather than [^>]*, because a Tailwind class can
  // itself contain a ">" — `[&>svg]:size-4` — and stopping at the first one made
  // the whole label unparseable, so exactly the class soup this elides came back.
  // Backtracking settles on the last ">" that leaves a valid remainder, which
  // also keeps a ">" inside the element's own text working.
  const LABEL_RE = /^<(.*)>(?:\s+"([\s\S]*)")?$/

  function captureIdentity(c) {
    // A capture with a source (a console crop, an annotated page) isn't an
    // element — it already carries a human label, so show it as it is.
    if (c.source) return {text: c.label || "Capture", mono: false}
    const match = LABEL_RE.exec(c.label || "")
    if (!match) return {text: c.label || "element", mono: false}
    const text = (match[2] || "").trim()
    return text ? {text, mono: false} : {text: `<${match[1]}>`, mono: true}
  }

  function firstTeamKey() {
    return ((config.teams || [])[0] && (config.teams || [])[0].key) || ""
  }

  // The project picker's value, defaulting to the project we last filed into.
  // An untouched draft has no `project` key at all, which is how "no project"
  // and "not chosen yet" stay distinguishable.
  function effectiveProject() {
    return stack.draft.project !== undefined ? stack.draft.project : (config.lastProject || "")
  }

  // A project belongs to exactly one team, so whenever a project is chosen it
  // is the project that decides the team — never the other way round. Leaving
  // the two pickers independent filed an "STR · Getting Started" issue into
  // HOM, because the untouched team picker sent nothing and the server fell
  // back to the workspace's first team.
  function teamForProject(projectId) {
    if (!projectId) return ""
    const project = (config.projects || []).find((p) => String(p.id) === String(projectId))
    return (project && project.team) || ""
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

  function renderPanel() {
    if (!panelVisible) {
      removeHost()
      return
    }
    ensureHost()
    const panel = panelHost._panel

    if (!isConfigured()) {
      panel.innerHTML = `
        <div class="head">
          ${ICON.grip}
          <b>File an issue</b>
          <span class="sp"></span>
          <button class="x" type="button" title="Hide" aria-label="Hide">${ICON.close}</button>
        </div>
        <div class="body">
          <p class="cfg">Connect the extension to your workspace first — set the app URL and API token in settings.</p>
        </div>
        <div class="foot">
          <div class="bar">
            <button class="ghost" type="button" data-act="hide">Hide</button>
            <span class="sp"></span>
            <button class="primary" type="button" data-act="settings">Open settings</button>
          </div>
        </div>`
      panel.querySelector(".x").onclick = hidePanel
      panel.querySelector('[data-act="hide"]').onclick = hidePanel
      panel.querySelector('[data-act="settings"]').onclick = () => sendMessage({type: "OPEN_OPTIONS"})
      return
    }

    const captures = stack.captures
    const draftNote = stack.draft.note || ""
    // The title tracks the instruction by default so a one-line note names the
    // issue for free. Once the user gives the title its own text `titleEdited`
    // detaches it; emptying the title re-attaches it (see the input handlers).
    const draftTitle = stack.draft.titleEdited ? (stack.draft.title || "") : draftNote
    // Default to the project of the last issue we filed; once the user touches
    // the picker their explicit choice (including "No project") lives on the
    // draft and wins. An empty draft (fresh, or just after filing) has no
    // `project` key, so we fall through to the remembered last project.
    const draftProject = effectiveProject()
    // Resolved after the project on purpose: a chosen project owns the team.
    const draftTeam = teamForProject(draftProject) || stack.draft.team || config.team || ""
    // The label defaults to the last one filed with, the same way the project
    // does; a touched picker (including "No label") lives on the draft and wins.
    const draftLabel = stack.draft.label !== undefined ? stack.draft.label : (config.lastLabel || "")
    const effectiveTeam = draftTeam || firstTeamKey()
    const labelOptions = labelOptionsForTeam(effectiveTeam, draftLabel)
    const boards = config.moodBoards || []
    // The board picker defaults to "No board" — filing an issue is the primary
    // path, and defaulting to "➕ New board…" meant the name input sat open and
    // empty under every capture, demanding attention it hadn't earned.
    // "__new__" means "create/append by name" (the name input appears);
    // any other non-empty value is an existing board's id.
    const rawBoard = stack.draft.board
    const draftBoard =
      rawBoard === "__new__" || (rawBoard && boards.some((b) => String(b.id) === String(rawBoard)))
        ? String(rawBoard)
        : ""
    const draftBoardName = stack.draft.boardName || ""
    const isNewBoard = draftBoard === "__new__"
    const boardOptions = [`<option value=""${draftBoard === "" ? " selected" : ""}>No board</option>`]
      .concat(
        boards.map((b) => {
          const id = String(b.id)
          const count = typeof b.clips === "number" ? ` (${b.clips})` : ""
          return `<option value="${escapeAttr(id)}"${id === draftBoard ? " selected" : ""}>${escapeHtml(b.name)}${count}</option>`
        })
      )
      .concat([`<option value="__new__"${isNewBoard ? " selected" : ""}>➕ New board…</option>`])
      .join("")
    // The account picker only earns its row when the user belongs to more than
    // one workspace — the token is user-level, so the list comes from the
    // server and switching just re-scopes every request.
    const accountOptions = (config.accounts || []).length > 1
      ? (config.accounts || [])
          .map((a) => `<option value="${escapeAttr(String(a.id))}"${String(a.id) === String(config.accountId) ? " selected" : ""}>${escapeHtml(a.name)}</option>`)
          .join("")
      : ""
    // Selected against the EFFECTIVE team, not the raw draft: with no team
    // chosen the browser used to show the first team while the draft held ""
    // — the picker said one thing and the filed issue did another.
    const teamOptions = (config.teams || [])
      .map((t) => `<option value="${escapeAttr(t.key)}"${t.key === effectiveTeam ? " selected" : ""}>${escapeHtml(t.key)} — ${escapeHtml(t.name)}</option>`)
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

    const captions = stack.draft.captions || {}
    const rows = captures
      .map((c, i) => {
        const {text, mono} = captureIdentity(c)
        return `
        <div class="cap">
          <div class="cap-row">
            <span class="cap-n">${i + 1}</span>
            ${c.image ? `<img class="cap-thumb" src="${escapeAttr(c.image)}" alt="">` : `<span class="cap-thumb"></span>`}
            <span class="cap-main">
              <span class="cap-el${mono ? " mono" : ""}" title="${escapeAttr(c.label || "element")}">${escapeHtml(text)}</span>
              <span class="cap-src">${escapeHtml((c.host || "") + (c.path || ""))}</span>
            </span>
            <button class="cap-x" type="button" data-remove="${escapeAttr(c.id)}" title="Remove" aria-label="Remove reference ${i + 1}">${ICON.remove}</button>
          </div>
          <div class="cap-note-row">
            <textarea class="cap-note" data-caption="${escapeAttr(c.id)}" rows="1" placeholder="Add a caption (optional)">${escapeHtml(captions[c.id] || "")}</textarea>
            <button class="cap-mic" type="button" data-dictate-caption="${escapeAttr(c.id)}" title="Dictate this caption by voice" aria-label="Dictate caption for reference ${i + 1}" aria-pressed="false">${ICON.mic}</button>
          </div>
        </div>`
      })
      .join("")

    const n = captures.length
    const full = n >= MAX_CAPTURES
    // "reference", not "element": a console screenshot is a capture too.
    const countPill = n ? `<span class="count${full ? " full" : ""}">${n} reference${n === 1 ? "" : "s"}</span>` : ""
    // Nothing to file or clip with an empty stack. "Clear all" stays live even
    // then — it is how you discard a leftover instruction and start clean.
    const disabled = n ? "" : " disabled"
    // The "match reference 1 to reference 2" example only means something once
    // there are two of them to compare.
    const notePlaceholder = n > 1
      ? "What should change? e.g. Make reference 1 match reference 2 — same padding, radius and shadow."
      : n === 1
        ? "What should change about this?"
        : "What should change?"
    // With nothing stacked the empty block already explains shift-clicking, so
    // the tip would just say it twice.
    const stackTip = !n
      ? ""
      : full
        ? `Stack full — ${MAX_CAPTURES} references max. File this issue to start another.`
        : `Hold <b>Shift</b> and click to stack more — on this page or any other.`

    panel.innerHTML = `
      <div class="head">
        ${ICON.grip}
        <b>File an issue</b>
        ${countPill}
        <span class="sp"></span>
        <button class="x" type="button" title="Hide" aria-label="Hide">${ICON.close}</button>
      </div>
      <div class="body">
        <div class="field">
          <div class="lblrow">
            <label class="lbl" for="sci-note">Instruction for the AI</label>
            <span class="sp"></span>
            <button class="mini" type="button" data-act="dictate" title="Dictate your instruction by voice" aria-pressed="false">${ICON.mic}Dictate</button>
          </div>
          <textarea id="sci-note" rows="3" placeholder="${escapeAttr(notePlaceholder)}">${escapeHtml(draftNote)}</textarea>
        </div>

        <div class="refs">
          <div class="refs-head">
            <span class="sec">References</span>
            <span class="sp"></span>
            <button class="mini" type="button" data-act="console" title="Screenshot the Chrome DevTools console"${full ? " disabled" : ""}>${ICON.console}Capture console</button>
          </div>
          <div class="caps">${rows || `<div class="empty"><b>No references yet</b><span>Shift-click any element on the page to add one.</span></div>`}</div>
          ${stackTip ? `<div class="tip">${stackTip}</div>` : ""}
        </div>

        <div class="field">
          <label class="lbl" for="sci-title">Title <span class="opt">optional</span></label>
          <input type="text" id="sci-title" value="${escapeAttr(draftTitle)}" placeholder="The AI names the issue if left blank">
        </div>

        ${accountOptions ? `<div class="field"><label class="lbl" for="sci-account">Account</label><select id="sci-account">${accountOptions}</select></div>` : ""}

        ${teamOptions ? `<div class="field"><label class="lbl" for="sci-team">Team</label><select id="sci-team">${teamOptions}</select></div>` : ""}

        <div class="grid2">
          <div class="field"><label class="lbl" for="sci-project">Project</label><select id="sci-project">${projectOptions}</select></div>
          <div class="field"><label class="lbl" for="sci-label">Label</label><select id="sci-label">${labelOptions}</select></div>
        </div>

        <div class="field">
          <label class="lbl" for="sci-board">Mood board</label>
          <select id="sci-board">${boardOptions}</select>
          <input type="text" id="sci-board-name" value="${escapeAttr(draftBoardName)}" placeholder="New board name" style="${isNewBoard ? "" : "display:none;"}">
        </div>

        <div class="ctx">
          <button class="ctxhead" type="button" data-act="context" aria-expanded="${contextOpen}">${ICON.chev}<span>Full captured context</span></button>
          <pre class="ctxpre"${contextOpen ? "" : " hidden"}>${escapeHtml(fullContext(captures))}</pre>
        </div>
      </div>
      <div class="foot">
        <span class="msg" id="sci-msg"></span><div class="bar">
          <button class="ghost danger" type="button" data-act="clear">Clear all</button>
          <span class="sp"></span>
          <button class="ghost" type="button" data-act="board"${disabled}>Add to board</button>
          <button class="primary" type="button" data-act="create"${disabled}>Create issue<span class="kbd">${SUBMIT_KEYS}</span></button>
        </div>
      </div>`

    const titleInput = panel.querySelector("#sci-title")
    const accountSelect = panel.querySelector("#sci-account")
    const teamSelect = panel.querySelector("#sci-team")
    const projectSelect = panel.querySelector("#sci-project")
    const labelSelect = panel.querySelector("#sci-label")
    const noteInput = panel.querySelector("#sci-note")
    // Persist drafts as the user types so they survive navigation/other tabs.
    // saveDraft() writes ONLY the draft (never the screenshots) and is debounced,
    // and there's no re-render here, so the caret is never disturbed.
    titleInput.addEventListener("input", () => {
      stack.draft.title = titleInput.value
      // Typing a title of its own detaches it from the note; clearing it back to
      // blank re-attaches so it resumes mirroring what you write below.
      stack.draft.titleEdited = titleInput.value.trim() !== ""
      saveDraft()
    })
    noteInput.addEventListener("input", () => {
      stack.draft.note = noteInput.value
      // Mirror the instruction into the title until the user has given the title
      // its own text. The title isn't focused here, so writing .value is caret-safe.
      if (!stack.draft.titleEdited) {
        stack.draft.title = noteInput.value
        titleInput.value = noteInput.value
      }
      saveDraft()
    })
    if (accountSelect) {
      accountSelect.addEventListener("change", async () => {
        if (submitting) return
        flash("Switching account…", "ok")
        const res = await sendMessage({type: "SWITCH_ACCOUNT", payload: {id: accountSelect.value}})
        // The old account's picks mean nothing in the new one; dropping them
        // lets the new account's remembered last-used values (restored into
        // config by the switch) fill the pickers instead.
        delete stack.draft.team
        delete stack.draft.project
        delete stack.draft.label
        delete stack.draft.board
        delete stack.draft.boardName
        saveDraft()
        // A successful switch just repopulated the picker caches from the
        // ping; a failed one left them empty, so let the once-per-session
        // refreshers refetch when the panel re-renders.
        const refreshed = Boolean(res?.ok && !res.warning)
        boardsFetched = refreshed
        projectsFetched = refreshed
        labelsFetched = refreshed
        await loadConfig()
        renderPanel()
        flash(
          refreshed ? `Switched to ${res.account || "the account"}.` : (res?.warning || res?.error || "Could not switch account."),
          refreshed ? "ok" : "err"
        )
      })
    }
    if (teamSelect) {
      teamSelect.addEventListener("change", () => {
        stack.draft.team = teamSelect.value
        const teamKey = teamSelect.value || firstTeamKey()
        // Moving to another team abandons a project that belongs to the one we
        // just left — keeping it would file the issue into one team carrying
        // another team's project.
        const projectTeam = teamForProject(effectiveProject())
        if (projectTeam && projectTeam !== teamKey) stack.draft.project = ""
        if (!labelsForTeam(teamKey).some((label) => String(label.id) === String(stack.draft.label))) {
          stack.draft.label = ""
        }
        saveDraft()
        renderPanel()
      })
    }
    if (projectSelect) {
      projectSelect.addEventListener("change", () => {
        stack.draft.project = projectSelect.value
        // Adopt the project's team, and drop a label belonging to the team we
        // just left. Re-rendering makes the team picker show the move.
        const teamKey = teamForProject(projectSelect.value)
        if (teamKey) {
          stack.draft.team = teamKey
          if (!labelsForTeam(teamKey).some((label) => String(label.id) === String(stack.draft.label))) {
            stack.draft.label = ""
          }
        }
        saveDraft()
        renderPanel()
      })
    }
    if (labelSelect) {
      labelSelect.addEventListener("change", () => {
        stack.draft.label = labelSelect.value
        saveDraft()
      })
    }
    const boardSelect = panel.querySelector("#sci-board")
    const boardNameInput = panel.querySelector("#sci-board-name")
    if (boardSelect) {
      boardSelect.addEventListener("change", () => {
        stack.draft.board = boardSelect.value
        // Show the name field only when creating/appending a board by name.
        boardNameInput.style.display = boardSelect.value === "__new__" ? "" : "none"
        saveDraft()
      })
    }
    if (boardNameInput) {
      boardNameInput.addEventListener("input", () => {
        stack.draft.boardName = boardNameInput.value
        saveDraft()
      })
    }
    panel.querySelector(".x").onclick = hidePanel
    panel.querySelector('[data-act="clear"]').onclick = clearStack
    panel.querySelector('[data-act="console"]').onclick = addConsoleCapture
    panel.querySelector('[data-act="create"]').onclick = () => submitIssue(panel)
    panel.querySelector('[data-act="board"]').onclick = () => submitMoodBoard(panel)
    panel.querySelector('[data-act="dictate"]').onclick = () => toggleDictation(noteTarget())
    // Each reference's caption has its own inline mic; wire them to a caption
    // target keyed by capture id.
    panel.querySelectorAll("[data-dictate-caption]").forEach((btn) => {
      const id = btn.getAttribute("data-dictate-caption")
      btn.onclick = () => toggleDictation(captionTarget(id))
    })
    // A rebuild mid-recording (e.g. a cross-tab capture change) hands us fresh,
    // idle-looking controls and an editable field; re-assert the live state on
    // whichever field is recording so the transcript keeps flowing.
    if (transcription) {
      const field = liveEl(transcription.fieldSelector)
      if (field) field.readOnly = true
      updateDictateButton()
    }
    // Toggled in place rather than via renderPanel(), so expanding the dump can't
    // reset the body's scroll position or blur the field you were editing.
    const ctxBtn = panel.querySelector('[data-act="context"]')
    ctxBtn.onclick = () => {
      contextOpen = !contextOpen
      panel.querySelector(".ctxpre").hidden = !contextOpen
      ctxBtn.setAttribute("aria-expanded", String(contextOpen))
    }
    panel.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.onclick = () => removeCapture(btn.getAttribute("data-remove"))
    })
    // Per-capture captions live in the draft (keyed by capture id), so editing
    // one is a cheap draft-only write — it never re-serializes the screenshots.
    panel.querySelectorAll("[data-caption]").forEach((box) => {
      box.addEventListener("input", () => {
        const id = box.getAttribute("data-caption")
        if (!stack.draft.captions) stack.draft.captions = {}
        stack.draft.captions[id] = box.value
        saveDraft()
      })
    })

    // Drop the caret into the instruction box on the render that follows a
    // capture. preventScroll because focusing inside a fixed-position overlay
    // otherwise scrolls the host page underneath it.
    if (focusNote && !isTypingInPanel()) {
      focusNote = false
      noteInput.focus({preventScroll: true})
    }

    // Refresh the mood-board picker once per panel session so boards created
    // since the last connect show up, without refetching on every re-render.
    if (!boardsFetched) {
      boardsFetched = true
      refreshMoodBoards()
    }
    // Likewise refresh the project list once per session so the picker always
    // reflects the workspace's current projects (and their emoji).
    if (!projectsFetched) {
      projectsFetched = true
      refreshProjects()
    }
    if (!labelsFetched) {
      labelsFetched = true
      refreshLabels()
    }
  }

  // Pull the account's current projects and, if the panel is open and the user
  // isn't mid-edit, re-render so the picker reflects them.
  async function refreshProjects() {
    const res = await sendMessage({type: "LIST_PROJECTS"})
    if (res?.ok && Array.isArray(res.projects)) {
      config.projects = res.projects
      renderForRefresh()
    }
  }

  // Pull the account's current labels and, if the panel is open and the user
  // isn't mid-edit, re-render so the picker reflects them.
  async function refreshLabels() {
    const res = await sendMessage({type: "LIST_LABELS"})
    if (res?.ok && Array.isArray(res.labels)) {
      config.labels = res.labels
      renderForRefresh()
    }
  }

  // Pull the account's current mood boards and, if the panel is open and the
  // user isn't mid-edit, re-render so the picker reflects them.
  // Never re-renders mid-submit — that would detach the status line and action
  // button the in-flight submit is holding onto. renderForRefresh() guards it.
  async function refreshMoodBoards() {
    const res = await sendMessage({type: "LIST_MOODBOARDS"})
    if (res?.ok && Array.isArray(res.moodBoards)) {
      config.moodBoards = res.moodBoards
      renderForRefresh()
    }
  }

  async function submitIssue(panel) {
    // The unconfigured "connect first" panel has no title/create controls, so a
    // stray Cmd/Ctrl+Enter must be a no-op rather than a TypeError.
    if (!isConfigured()) return
    if (submitting) return
    stopTranscription() // commit whatever was dictated and release the mic
    const titleInput = panel.querySelector("#sci-title")
    const teamSelect = panel.querySelector("#sci-team")
    const projectSelect = panel.querySelector("#sci-project")
    const labelSelect = panel.querySelector("#sci-label")
    const noteInput = panel.querySelector("#sci-note")
    const msg = panel.querySelector("#sci-msg")
    const createBtn = panel.querySelector('[data-act="create"]')
    if (!msg || !createBtn) return

    if (!stack.captures.length) {
      msg.className = "msg err"
      msg.textContent = "Shift-click at least one element first."
      return
    }
    // Title is optional: when blank, the AI working the issue writes one (and
    // applies appropriate labels). The server fills a readable fallback in the
    // meantime, so a missing title is never an error.
    const finalTitle = (titleInput?.value || "").trim()

    submitting = true
    createBtn.disabled = true
    msg.className = "msg"
    msg.textContent = "Filing…"

    // The project has the final word on the team. The pickers are kept in step
    // above, but a draft restored from storage can still pair a project with a
    // team it doesn't belong to, and that must never reach the server.
    const chosenProject = projectSelect ? projectSelect.value : effectiveProject()
    const chosenTeam =
      teamForProject(chosenProject) || (teamSelect ? teamSelect.value : stack.draft.team || config.team || "")

    const res = await sendMessage({
      type: "CREATE_ISSUE",
      payload: {
        title: finalTitle,
        note: noteInput ? noteInput.value.trim() : stack.draft.note || "",
        team: chosenTeam,
        project: chosenProject,
        label: labelSelect ? labelSelect.value : stack.draft.label || "",
        // Ask for the filed issue rendered through the workspace's default Issue
        // prompt template, so it can go straight on the clipboard below.
        includePrompt: true,
        captures: stack.captures.map((c) => ({
          body: c.body,
          url: c.url,
          image: c.image,
          caption: (stack.draft.captions && stack.draft.captions[c.id]) || ""
        }))
      }
    })

    if (res?.ok) {
      // Filing is the last step here: put the ready-to-work prompt on the
      // clipboard and chime, so the next move is a paste into Claude Code
      // rather than a trip to the issue page's "Copy as prompt".
      const copied = await copyTextToClipboard(res.prompt)
      if (copied) playSound("copied")
      msg.className = "msg ok"
      const link = `<a href="${escapeAttr(res.url)}" target="_blank" rel="noopener">${escapeHtml(res.identifier)}</a>`
      // The prompt is on the issue page either way, so a blocked clipboard (an
      // unfocused tab, an http:// page) is worth saying, not worth failing —
      // and a workspace too old to return one just files as it always did.
      if (copied) {
        msg.innerHTML = `Filed ${link} — prompt copied ✓`
      } else if (res.prompt) {
        msg.innerHTML = `Filed ${link} ✓ — clipboard blocked, use “Copy as prompt” there`
      } else {
        msg.innerHTML = `Filed ${link} ✓`
      }
      createBtn.textContent = "Done"
      stack = {captures: [], draft: {}}
      await saveStack()
      setTimeout(hidePanel, 2600)
    } else {
      submitting = false
      createBtn.disabled = false
      msg.className = "msg err"
      msg.textContent = res?.error || "Could not file the issue."
    }
  }

  // Copy the stacked captures onto a mood board as clips — either an existing
  // board (selected by id) or a new/looked-up one (typed name). Mirrors
  // submitIssue, minus the title (a board doesn't need one).
  async function submitMoodBoard(panel) {
    if (!isConfigured()) return
    if (submitting) return
    stopTranscription() // release the mic before the board write takes over
    const boardSelect = panel.querySelector("#sci-board")
    const boardNameInput = panel.querySelector("#sci-board-name")
    const msg = panel.querySelector("#sci-msg")
    const boardBtn = panel.querySelector('[data-act="board"]')
    if (!msg || !boardBtn) return

    if (!stack.captures.length) {
      msg.className = "msg err"
      msg.textContent = "Shift-click at least one element first."
      return
    }

    const selected = boardSelect ? boardSelect.value : "__new__"
    const useNew = selected === "__new__"
    const boardId = useNew ? "" : selected
    const boardName = useNew ? (boardNameInput ? boardNameInput.value.trim() : "") : ""
    if (useNew && !boardName) {
      msg.className = "msg err"
      msg.textContent = "Name the mood board first."
      boardNameInput?.focus()
      return
    }
    // The picker now defaults to "No board", so a target must be chosen before
    // the captures have anywhere to land.
    if (!useNew && !boardId) {
      msg.className = "msg err"
      msg.textContent = "Choose a mood board first."
      boardSelect?.focus()
      return
    }

    submitting = true
    boardBtn.disabled = true
    msg.className = "msg"
    msg.textContent = "Adding…"

    const res = await sendMessage({
      type: "ADD_TO_MOODBOARD",
      payload: {
        boardId: boardId || null,
        boardName: boardName || null,
        captures: stack.captures.map((c) => ({
          body: c.body,
          url: c.url,
          image: c.image,
          caption: (stack.draft.captions && stack.draft.captions[c.id]) || ""
        }))
      }
    })

    if (res?.ok) {
      const name = (res.moodBoard && res.moodBoard.name) || "mood board"
      const n = res.added != null ? res.added : stack.captures.length
      msg.className = "msg ok"
      msg.innerHTML = `Added ${escapeHtml(String(n))} to <a href="${escapeAttr(res.url)}" target="_blank" rel="noopener">${escapeHtml(name)}</a> ✓`
      boardBtn.textContent = "Added"
      stack = {captures: [], draft: {}}
      await saveStack()
      setTimeout(hidePanel, 2600)
    } else {
      submitting = false
      boardBtn.disabled = false
      msg.className = "msg err"
      msg.textContent = res?.error || "Could not add to the mood board."
    }
  }

  // ── API for the other content scripts ───────────────────────────────
  //
  // The review bar hands finished captures (an annotated page, say) to the
  // composer through this, so a mark-up can become a reference on the issue
  // you're already assembling. Both scripts share one isolated world, so a
  // plain global is the whole bridge — no messaging, no storage round-trip.
  //
  // Writing straight to chrome.storage.local would add the capture but leave
  // the panel shut, because the storage listener deliberately refuses to
  // reopen a panel the user dismissed. Going through here opens it.
  // Would the composer take another capture right now? Callers ask before doing
  // expensive work (a screenshot), and addExternalCapture asks again after it.
  async function canAcceptCapture() {
    // A click can land before boot() has read config and the stored stack;
    // answering from an unloaded stack would be a guess.
    await booted
    if (!isConfigured()) {
      return {ok: false, error: "Connect the extension to your workspace first."}
    }
    if (stack.captures.length >= MAX_CAPTURES) {
      return {ok: false, error: `You can stack up to ${MAX_CAPTURES} references — file this issue first.`}
    }
    return {ok: true}
  }

  async function addExternalCapture({body, label, image, url, host, path, source}) {
    const room = await canAcceptCapture()
    if (!room.ok) return room

    const capture = {id: newCaptureId(), body, label, image: image || null, url, host, path, source}
    stack.captures.push(capture)
    if (!stack.draft.team) stack.draft.team = config.team || ""

    if (!(await saveStack())) {
      // Quota, most likely a screenshot too big to store. Don't leave a capture
      // in memory that isn't on disk — the next tab to sync would drop it anyway.
      stack.captures = stack.captures.filter((c) => c.id !== capture.id)
      return {ok: false, error: "Could not save that capture — the screenshot may be too large."}
    }

    panelVisible = true
    focusNote = true
    renderPanel()
    return {ok: true, count: stack.captures.length}
  }

  window.__sciFiler = {addCapture: addExternalCapture, canAddCapture: canAcceptCapture}

  // ── Event handlers ──────────────────────────────────────────────────
  // Clicks inside our own panel carry IGNORE_ATTR, so capturing stays armed
  // while the panel is open — that's how you stack elements across a page.
  function onMouseMove(event) {
    if (!config.enabled || !isConfigured() || !event.shiftKey) {
      clearHighlight()
      hideHint()
      return
    }
    const el = event.target
    if (!(el instanceof Element) || el.hasAttribute(IGNORE_ATTR) || el.closest(`[${IGNORE_ATTR}]`)) return
    ensurePageStyles()
    showHint()
    if (el === hovered) return
    clearHighlight()
    hovered = el
    el.classList.add(OUTLINE_CLASS)
  }

  function onKeyUp(event) {
    if (event.key === "Shift") {
      clearHighlight()
      hideHint()
    }
  }

  async function onClickCapture(event) {
    // Only hijack the shift-click once the extension is connected to a workspace,
    // so an installed-but-unconfigured extension never swallows the browser's own
    // shift-click (open-in-new-window) gesture on arbitrary sites.
    if (!config.enabled || !isConfigured() || !event.shiftKey) return
    const el = event.target
    if (!(el instanceof Element) || el.hasAttribute(IGNORE_ATTR) || el.closest(`[${IGNORE_ATTR}]`)) return

    // This shift-click is ours — don't let it navigate, select, or fire any
    // Stimulus/Turbo action bound to the element.
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    await addCapture(el)
  }

  // ── Boot ────────────────────────────────────────────────────────────
  // Resolves once config and the stored stack are in memory. addExternalCapture
  // waits on it so a review-bar click can never race the load.
  let markBooted
  const booted = new Promise((resolve) => {
    markBooted = resolve
  })

  async function boot() {
    await loadConfig()
    stack = await loadStack()
    // Resume an in-progress collection when landing on a new page.
    panelVisible = stack.captures.length > 0
    markBooted()

    document.addEventListener("click", onClickCapture, true)
    document.addEventListener("mousemove", onMouseMove, true)
    document.addEventListener("keyup", onKeyUp, true)

    // Turbo swaps <body>; drop our (sibling) panel before the snapshot is cached
    // and rebuild it after the new page renders so the stack visibly follows you.
    document.addEventListener("turbo:before-cache", () => {
      clearHighlight()
      hideHint()
      removeHost()
    })
    document.addEventListener("turbo:load", async () => {
      stack = await loadStack()
      if (panelVisible || stack.captures.length) {
        panelVisible = panelVisible || stack.captures.length > 0
        renderPanel()
      } else {
        removeHost()
      }
    })

    if (panelVisible) renderPanel()
  }

  boot()
})()
