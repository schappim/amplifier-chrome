// Element tagger — bind a live GUI spot to the component it must render.
//
// Alt+Shift+C arms it. Hover highlights, click opens a picker: choose the
// component and variant this element *is*, and the workspace records an instance
// — the assertion `audit_components` then checks, and the list
// `set_component_status` hands back when a component is retired.
//
// The other path matters just as much. If nothing in the catalog fits, "Not a
// component yet" files a `design` issue with the element's report, its location
// and a screenshot, so the gap becomes work rather than another hand-rolled
// button.
//
// The panel never guesses. If the element already carries a catalogued class the
// picker preselects it; otherwise the user chooses, and the server decides
// whether the choice is legal.
;(() => {
  if (window.__sciTagger) return
  window.__sciTagger = true

  const S = window.__sciShared
  if (!S) return

  const HOST_ID = "sci-tagger-host"
  const ARMED_ATTR = "data-sci-tagger-armed"

  let armed = false
  let hovered = null
  let host = null
  let shadow = null
  let catalog = {project: null, components: []}
  let target = null

  // ── Location ────────────────────────────────────────────────────────
  // A spot has to be findable again after the DOM around it changes. A stable
  // anchor (an id, a Stimulus controller, a test id) beats a long path of
  // nth-of-type selectors, so we hang the location off the nearest one we find
  // and only fall back to the full path when there is none.
  const ANCHOR_ATTRS = ["data-testid", "data-test-id", "data-controller", "id"]

  function anchorFor(el) {
    let node = el
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      for (const attr of ANCHOR_ATTRS) {
        const value = node.getAttribute?.(attr)
        if (value) return {node, selector: attr === "id" ? `#${CSS.escape(value)}` : `[${attr}="${value}"]`}
      }
      node = node.parentElement
    }
    return null
  }

  function relativePath(from, to) {
    const parts = []
    let node = to
    while (node && node !== from && node.nodeType === Node.ELEMENT_NODE) {
      parts.unshift(S.selectorFor(node))
      node = node.parentElement
    }
    return parts.join(" > ")
  }

  function locationFor(el) {
    const route = window.location.pathname || "/"
    const anchor = anchorFor(el)

    if (anchor && anchor.node !== el) {
      const rest = relativePath(anchor.node, el)
      return `${route} ${anchor.selector}${rest ? " > " + rest : ""}`
    }
    if (anchor) return `${route} ${anchor.selector}`

    return `${route} ${S.cssPathParts(el).join(" > ")}`
  }

  // The catalog knows its own classes, so an element already using a component
  // announces which one it is. Longest base class wins, so `ws-iconbtn` isn't
  // read as `ws-icon`.
  function detectComponent(el) {
    const classes = new Set(Array.from(el.classList))
    const matches = catalog.components.filter((c) => c.base_class && classes.has(c.base_class))
    const component = matches.sort((a, b) => b.base_class.length - a.base_class.length)[0]
    if (!component) return {component: null, variant: null}

    const variant = (component.variants || []).find((v) => v !== "default" && classes.has(v)) || null
    return {component, variant}
  }

  // ── Highlight ───────────────────────────────────────────────────────

  function ensureStyles() {
    if (document.getElementById("sci-tagger-styles")) return
    const style = document.createElement("style")
    style.id = "sci-tagger-styles"
    style.textContent = `
      [${ARMED_ATTR}] * { cursor: crosshair !important; }
      .sci-tagger-hover { outline: 2px solid #5e6ad2 !important; outline-offset: 1px !important; }
    `
    document.documentElement.appendChild(style)
  }

  function highlight(el) {
    clearHighlight()
    if (!el) return
    hovered = el
    el.classList.add("sci-tagger-hover")
  }

  function clearHighlight() {
    if (hovered) hovered.classList.remove("sci-tagger-hover")
    hovered = null
  }

  // ── Panel ───────────────────────────────────────────────────────────

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return
    host = document.createElement("div")
    host.id = HOST_ID
    host.setAttribute(S.IGNORE_ATTR, "")
    shadow = host.attachShadow({mode: "open"})
    // The "name it" field lives in this shadow root — keep its keystrokes from
    // leaking to the host page's shortcuts (see shared.guardFieldKeystrokes).
    S.guardFieldKeystrokes(shadow)
    document.documentElement.appendChild(host)
  }

  function removeHost() {
    host?.remove()
    host = null
    shadow = null
    target = null
  }

  function variantOptions(component, selected) {
    const variants = component?.variants || []
    return variants
      .map((v) => {
        const label = v === "default" ? "default (no modifier)" : v
        const proposed = (component.proposed_variants || []).includes(v) ? " — proposed, not built yet" : ""
        const isSelected = v === selected ? " selected" : ""
        return `<option value="${S.escapeAttr(v)}"${isSelected}>${S.escapeHtml(label + proposed)}</option>`
      })
      .join("")
  }

  function componentOptions(selected) {
    return catalog.components
      .map((c) => {
        const retiring = c.status === "deprecated" ? " — deprecated" : ""
        const draft = c.status === "draft" ? " — draft" : ""
        const isSelected = c.key === selected?.key ? " selected" : ""
        return `<option value="${S.escapeAttr(c.key)}"${isSelected}>${S.escapeHtml(c.name + retiring + draft)}</option>`
      })
      .join("")
  }

  function renderPanel(detected, message = "", kind = "") {
    ensureHost()
    const component = detected.component
    const location = locationFor(target)

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          width: 380px; padding: 14px; border-radius: 10px;
          background: #17181b; color: #e6e6e8; border: 1px solid #2a2c30;
          box-shadow: 0 12px 32px rgba(0,0,0,.5);
          font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
        }
        h2 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
        code { background: #26272b; padding: 1px 4px; border-radius: 4px; font-size: 11px; word-break: break-all; }
        label { display: block; margin: 10px 0 4px; color: #9a9ba0; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
        select, button { font: inherit; }
        select, input { width: 100%; padding: 6px; border-radius: 6px; background: #0f1012; color: #e6e6e8; border: 1px solid #2a2c30; font: inherit; }
        .divider { margin: 14px 0 4px; border-top: 1px solid #2a2c30; }
        em { color: #c4c5cb; font-style: normal; }
        .row { display: flex; gap: 8px; margin-top: 12px; }
        button { flex: 1; padding: 7px 10px; border-radius: 6px; cursor: pointer; border: 1px solid #2a2c30; background: #26272b; color: #e6e6e8; }
        button.primary { background: #5e6ad2; border-color: #5e6ad2; color: #fff; }
        button:disabled { opacity: .55; cursor: not-allowed; }
        .msg { margin-top: 10px; font-size: 12px; }
        .msg.ok { color: #57ab5a; }
        .msg.err { color: #e5757f; }
        .msg.warn { color: #e2a336; }
        .hint { margin-top: 10px; color: #8a8b91; font-size: 11px; }
      </style>
      <div class="panel">
        <h2>Tag this element</h2>
        <code>${S.escapeHtml(location)}</code>

        <label>Component</label>
        <select id="component">
          <option value="">— choose a component —</option>
          ${componentOptions(component)}
        </select>

        <label>Variant</label>
        <select id="variant" ${component ? "" : "disabled"}>
          ${component ? variantOptions(component, detected.variant) : "<option>—</option>"}
        </select>

        <div class="row">
          <button id="tag" class="primary" ${component ? "" : "disabled"}>Tag</button>
          <button id="cancel">Cancel</button>
        </div>

        <div class="divider"></div>

        <label>Not in the library yet?</label>
        <input id="name" type="text" placeholder="Name it, e.g. Primary Button" autocomplete="off" />
        <div class="row">
          <button id="capture" class="primary">Add to component library</button>
          <button id="propose">File a design issue</button>
        </div>

        ${message ? `<div class="msg ${kind}">${S.escapeHtml(message)}</div>` : ""}
        <div class="hint">
          A capture becomes a <em>draft</em> carrying this element's markup, its computed styles and the
          partial it came from. The repo wins once it ships a component with the same name.
        </div>
      </div>
    `

    const componentSelect = shadow.getElementById("component")
    const variantSelect = shadow.getElementById("variant")
    const tagButton = shadow.getElementById("tag")

    componentSelect.addEventListener("change", () => {
      const chosen = catalog.components.find((c) => c.key === componentSelect.value) || null
      variantSelect.innerHTML = chosen ? variantOptions(chosen, null) : "<option>—</option>"
      variantSelect.disabled = !chosen
      tagButton.disabled = !chosen
    })

    tagButton.addEventListener("click", () => submitTag(componentSelect.value, variantSelect.value, location))
    shadow.getElementById("capture").addEventListener("click", () =>
      captureComponent(shadow.getElementById("name").value, location))
    shadow.getElementById("propose").addEventListener("click", () => proposeComponent(location))
    shadow.getElementById("cancel").addEventListener("click", () => removeHost())
  }

  // ── Capture ─────────────────────────────────────────────────────────
  // The element as it renders: its markup, the computed styles that make it look
  // the way it does, and — the part no manifest can give us — the partial it was
  // rendered from. `keyStyles` returns "  prop: value;" lines; the server wants a
  // map, and would rather have nothing than a line it can't parse.
  function styleMap(el) {
    const map = {}
    for (const line of S.keyStyles(el)) {
      const at = line.indexOf(":")
      if (at === -1) continue
      const property = line.slice(0, at).trim()
      const value = line.slice(at + 1).replace(/;$/, "").trim()
      if (property && value) map[property] = value
    }
    return map
  }

  // The innermost partial is the one that rendered this element; the outer ones
  // are the pages that contain it.
  function templatePath(el) {
    const chain = S.partialChain(el)
    return chain.length ? chain[chain.length - 1] : null
  }

  async function captureComponent(name, location) {
    if (!name.trim()) {
      return renderPanel(detectComponent(target), "Give the component a name first.", "err")
    }

    const element = target
    const result = await S.sendMessage({
      type: "CAPTURE_COMPONENT",
      payload: {
        project: catalog.project?.name || null,
        name: name.trim(),
        markup: element.outerHTML,
        styles: styleMap(element),
        location,
        url: window.location.href,
        templatePath: templatePath(element),
        codePath: S.controllerInfo().file || null
      }
    })

    if (!result?.ok) return renderPanel(detectComponent(element), result?.error || "Could not reach the workspace.", "err")

    // The catalog just grew, so a second capture on this page sees the new
    // component in its picker rather than offering to create it again.
    const refreshed = await S.sendMessage({type: "LIST_COMPONENTS", payload: {}})
    if (refreshed?.ok) catalog = {project: refreshed.project, components: refreshed.components || []}

    renderPanel(detectComponent(element), result.message, "ok")
    setTimeout(() => removeHost(), 3500)
  }

  // ── Actions ─────────────────────────────────────────────────────────

  async function submitTag(component, variant, location) {
    if (!component) return

    const result = await S.sendMessage({
      type: "TAG_ELEMENT",
      payload: {
        project: catalog.project?.name || null,
        component,
        variant: variant === "default" ? null : variant,
        location,
        url: window.location.href
      }
    })

    if (!result?.ok) return renderPanel(detectComponent(target), result?.error || "Could not reach the workspace.", "err")

    // A drifted tag is still a tag — the spot is bound, and now it is also a
    // migration the audit will keep reporting until someone moves it.
    const kind = result.drift ? "warn" : "ok"
    renderPanel(detectComponent(target), result.message, kind)
    setTimeout(() => removeHost(), result.drift ? 6000 : 2000)
  }

  // Nothing in the catalog fits. That is a finding, not a licence to hand-roll:
  // file it as a design issue carrying the element, its location and a picture.
  async function proposeComponent(location) {
    const element = target
    const body = S.buildReport(element)
    removeHost()
    clearHighlight()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const image = await S.captureElement(element)

    const result = await S.sendMessage({
      type: "CREATE_ISSUE",
      payload: {
        title: `Should be a component: ${S.describeElement(element)}`,
        note:
          "Tagged with the element tagger. Nothing in the component catalog fits this spot.\n\n" +
          `**Location:** \`${location}\`\n\n` +
          "Propose a component for it (`find_component` first, then `save_component`), " +
          "or say why it should stay bespoke.",
        label: "design",
        captures: [{body, url: window.location.href, image: image || null}]
      }
    })

    ensureHost()
    target = element
    if (result?.ok) {
      renderPanel({component: null, variant: null}, `Filed ${result.identifier}.`, "ok")
      setTimeout(() => removeHost(), 2500)
    } else {
      renderPanel({component: null, variant: null}, result?.error || "Could not file the issue.", "err")
    }
  }

  // ── Arming ──────────────────────────────────────────────────────────

  function inPanel(el) {
    return Boolean(el?.closest?.(`#${HOST_ID}`)) || el === host
  }

  function onMove(event) {
    if (!armed || inPanel(event.target)) return
    highlight(event.target)
  }

  function onClick(event) {
    if (!armed || inPanel(event.target)) return
    event.preventDefault()
    event.stopPropagation()

    target = event.target
    disarm({keepPanel: true})
    renderPanel(detectComponent(target))
  }

  function onKey(event) {
    if (event.key === "Escape" && (armed || host)) {
      disarm()
      removeHost()
    }
  }

  // Says why the tagger can't arm, without hijacking the page with a modal.
  function renderNotice(text, kind = "err") {
    ensureHost()
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .notice {
          position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
          max-width: 360px; padding: 12px 14px; border-radius: 10px;
          background: #17181b; color: ${kind === "err" ? "#e5757f" : "#e6e6e8"};
          border: 1px solid #2a2c30; box-shadow: 0 12px 32px rgba(0,0,0,.5);
          font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
        }
      </style>
      <div class="notice">Element tagger: ${S.escapeHtml(text)}</div>
    `
    setTimeout(() => removeHost(), 4000)
  }

  async function arm() {
    const result = await S.sendMessage({type: "LIST_COMPONENTS", payload: {}})
    if (!result?.ok) {
      // Nothing to tag against; say so rather than arming a picker with no picks.
      renderNotice(result?.error || "no component catalog for this workspace.")
      return
    }

    catalog = {project: result.project, components: result.components || []}
    armed = true
    ensureStyles()
    document.documentElement.setAttribute(ARMED_ATTR, "")
    document.addEventListener("mousemove", onMove, true)
    document.addEventListener("click", onClick, true)
  }

  function disarm({keepPanel = false} = {}) {
    armed = false
    document.documentElement.removeAttribute(ARMED_ATTR)
    document.removeEventListener("mousemove", onMove, true)
    document.removeEventListener("click", onClick, true)
    clearHighlight()
    if (!keepPanel) removeHost()
  }

  document.addEventListener("keydown", onKey, true)

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "TOGGLE_TAGGER") return
    armed || host ? disarm() : arm()
  })
})()
