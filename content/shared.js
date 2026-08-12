// Shared capture helpers — loaded before the feature content scripts (see
// manifest.json content_scripts order).
//
// Both the shift-click issue filer (content/inspector.js) and the review bar
// (content/review_bar.js) capture elements the same way: a Markdown report of
// the element, its DOM path, key computed styles, the Rails view/partial chain
// and controller (when the page_inspector engine annotates the page), plus a
// cropped screenshot. Keeping that machinery here — a single namespaced global
// on `window.__sciShared` — means the two features can never drift apart on
// capture format.
//
// Content scripts of the same extension share one isolated world per page, so
// a plain window global is visible to every script listed after this one.

(() => {
  if (window.__sciShared) return

  const IGNORE_ATTR = "data-sci-ignore" // our own overlay nodes opt out of capture
  // Tool chrome — panels and bars that must not appear in a screenshot of the
  // page. The annotation overlays (mark-up canvas, comment pins) omit it.
  const CHROME_ATTR = "data-sci-chrome"
  const MIN_CAPTURE_SCALE = 2 // floor screenshots at @2x so mood-board clips stay retina-crisp
  const MAX_CAPTURE_PIXELS = 8_000_000 // ceiling on the upscaled crop so a big element on a 1x screen can't balloon past the server's per-image size cap
  const MAX_DESKTOP_CAPTURE_BYTES = 14_000_000 // mirror the extension/server data URL budget for one screenshot

  // ── Annotation parsing (view/partial chain) ─────────────────────────
  const ANNOTATION = /^(BEGIN|END)\s+(.+\.\w+)\s*$/

  function partialChain(target) {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT
    )
    const stack = []
    let node
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.COMMENT_NODE) {
        const match = node.nodeValue.trim().match(ANNOTATION)
        if (!match) continue
        const [, kind, path] = match
        if (kind === "BEGIN") {
          stack.push(path)
        } else {
          const i = stack.lastIndexOf(path)
          if (i !== -1) stack.splice(i, 1)
        }
      } else if (node === target) {
        return stack.slice()
      }
    }
    return stack.slice()
  }

  // ── CSS path ────────────────────────────────────────────────────────
  function nthOfType(el) {
    let n = 1
    let sib = el.previousElementSibling
    while (sib) {
      if (sib.tagName === el.tagName) n++
      sib = sib.previousElementSibling
    }
    return n
  }

  function selectorFor(el) {
    const tag = el.tagName.toLowerCase()
    if (el.id) return `${tag}#${CSS.escape(el.id)}`

    let selector = tag
    const cls = Array.from(el.classList).find(
      (c) => !c.startsWith("hs-") && !c.startsWith("sci-") && c.length
    )
    if (cls) selector += `.${CSS.escape(cls)}`

    const parent = el.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName)
      if (sameTag.length > 1) selector += `:nth-of-type(${nthOfType(el)})`
    }
    return selector
  }

  function cssPathParts(el) {
    const parts = []
    let node = el
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      parts.unshift(selectorFor(node))
      if (node.id) break
      node = node.parentElement
    }
    return parts
  }

  // ── Key computed styles ─────────────────────────────────────────────
  // Properties worth carrying so an LLM can recreate the element's look. Kept
  // to the visual essentials (type, colour, box, spacing) rather than the full
  // ~350-property computed cascade, which would bury the signal.
  const KEY_STYLE_PROPS = [
    "display", "box-sizing", "width", "height",
    "padding", "margin",
    "color", "background-color", "background-image",
    "font-family", "font-size", "font-weight", "font-style",
    "line-height", "letter-spacing", "text-align", "text-transform", "text-decoration-line",
    "border-radius", "box-shadow", "opacity", "cursor",
  ]
  // Flex/grid children only matter when the element is actually a flex/grid
  // container, so add these conditionally.
  const LAYOUT_STYLE_PROPS = ["flex-direction", "flex-wrap", "justify-content", "align-items", "gap"]
  const BORDER_SIDES = ["top", "right", "bottom", "left"]
  // Resolved values that say nothing about how to recreate the look — drop them
  // so the block stays short and readable.
  const NOISE_STYLE_VALUES = new Set([
    "", "none", "auto", "normal", "0px", "static", "visible",
    "rgba(0, 0, 0, 0)", "transparent",
  ])

  // Per-side border declarations for the sides that are actually visible.
  // Reading the sides individually (rather than the `border` shorthand) is what
  // captures common one-sided dividers like `border-bottom` — the shorthand only
  // serializes when all four sides match, and `border-width` alone leads with the
  // top side, so a bottom-only border reads as "0px …" and would be missed.
  // Collapses to a single `border:` when all four sides are present and identical.
  function borderLines(cs) {
    const sides = {}
    for (const side of BORDER_SIDES) {
      const width = cs.getPropertyValue(`border-${side}-width`)
      const style = cs.getPropertyValue(`border-${side}-style`)
      if (parseFloat(width) > 0 && style && style !== "none") {
        sides[side] = `${width} ${style} ${cs.getPropertyValue(`border-${side}-color`)}`.trim()
      }
    }
    const present = BORDER_SIDES.filter((side) => sides[side])
    if (!present.length) return []
    if (present.length === 4 && present.every((side) => sides[side] === sides.top)) {
      return [`  border: ${sides.top};`]
    }
    return present.map((side) => `  border-${side}: ${sides[side]};`)
  }

  // A `prop: value;` list of the element's key computed styles, skipping noise.
  function keyStyles(el) {
    const cs = window.getComputedStyle(el)
    const props = KEY_STYLE_PROPS.slice()
    if (/(flex|grid)/.test(cs.display)) props.push(...LAYOUT_STYLE_PROPS)

    const lines = []
    for (const prop of props) {
      const value = cs.getPropertyValue(prop).trim()
      if (!value || NOISE_STYLE_VALUES.has(value)) continue
      lines.push(`  ${prop}: ${value};`)
    }
    return lines.concat(borderLines(cs))
  }

  // ── Element + controller description ────────────────────────────────
  function describeElement(el) {
    let desc = el.tagName.toLowerCase()
    if (el.id) desc += `#${el.id}`
    const cls = Array.from(el.classList)
      .filter((c) => !c.startsWith("sci-"))
      .slice(0, 3)
      .join(".")
    if (cls) desc += `.${cls}`

    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60)
    return text ? `<${desc}> "${text}"` : `<${desc}>`
  }

  function meta(name) {
    return document.querySelector(`meta[name="${name}"]`)?.content || null
  }

  function controllerInfo() {
    return {action: meta("dev-controller"), file: meta("dev-controller-file"), app: meta("dev-app-name")}
  }

  // ── Report assembly (matches the dev-inspector Markdown format) ──────
  function buildReport(el) {
    const chain = partialChain(el)
    const {action, file, app} = controllerInfo()

    // Each field is its own block, separated by a blank line, so the Markdown
    // renderer puts them on their own paragraphs instead of running them
    // together into one.
    const blocks = []
    blocks.push(`**Element:** \`${describeElement(el)}\``)
    // The DOM path can be very deep. Render it as a fenced code block with one
    // selector per line so it stays readable and never overflows horizontally
    // (a single long inline-code line would run off the page).
    blocks.push("**DOM path:**\n```\n" + cssPathParts(el).join("\n> ") + "\n```")

    // The element's key computed styles, as a CSS rule an LLM can lift wholesale
    // to recreate the look. Rendered as a fenced css block so it stays readable.
    const styles = keyStyles(el)
    if (styles.length) {
      blocks.push("**Key styles:**\n```css\n" + selectorFor(el) + " {\n" + styles.join("\n") + "\n}\n```")
    }

    if (chain.length) {
      // Label + its nested list stay in one block (single newlines) so the list
      // renders directly under the heading.
      blocks.push(["**View / partials:**", ...chain.map((path, i) => `${"  ".repeat(i)}- ${path}`)].join("\n"))
    } else {
      blocks.push("**View / partials:** _(no annotations found)_")
    }

    if (action) blocks.push(`**Controller:** ${action}${file ? ` (${file})` : ""}`)
    // Which app the page belongs to — matters when it was reached through a
    // tunnel or localhost URL that names no one (see page_inspector's
    // dev-app-name meta tag).
    if (app) blocks.push(`**App:** ${app}`)
    blocks.push(`**URL:** ${window.location.href}`)

    return blocks.join("\n\n")
  }

  function buildChromeConsoleReport() {
    return [
      "**Chrome console capture:** Selected from a Chrome window or screen screenshot.",
      `**Page URL:** ${window.location.href}`,
      "**DOM metadata:** _Not available; Chrome DevTools is outside the inspected page DOM._"
    ].join("\n\n")
  }

  // The report for a whole annotated page, rather than one element: there is no
  // single node to describe, so the drawing itself carries the meaning and this
  // supplies the page context around it.
  function buildAnnotationReport({strokes = 0, comments = 0} = {}) {
    const {action, file, app} = controllerInfo()
    const drawn = []
    if (strokes) drawn.push(`${strokes} mark-up stroke${strokes === 1 ? "" : "s"}`)
    if (comments) drawn.push(`${comments} comment pin${comments === 1 ? "" : "s"}`)

    const blocks = ["**Page annotation:** A screenshot of this page with the review mark-up drawn on it."]
    if (drawn.length) blocks.push(`**Annotations:** ${drawn.join(" · ")}`)
    if (action) blocks.push(`**Controller:** ${action}${file ? ` (${file})` : ""}`)
    if (app) blocks.push(`**App:** ${app}`)
    blocks.push(`**URL:** ${window.location.href}`)
    return blocks.join("\n\n")
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  // ── Screenshot: photograph the visible tab, minus our own UI ─────────
  //
  // captureVisibleTab photographs whatever is on screen, and that includes the
  // composer panel, the review bar and its send panel. Anything carrying
  // CHROME_ATTR is tool chrome and is hidden for the one frame the shot is
  // taken. The annotation overlays (mark-up canvas, comment pins) deliberately
  // do NOT carry it — they are the thing being captured.
  //
  // visibility:hidden, not display:none, so nothing reflows under the shot.
  //
  // Serialised, because two overlapping captures would each save the other's
  // "hidden" as the visibility to restore, and the panels would never come back
  // — the debounced mark-up snapshot really can fire while a capture is in
  // flight. captureVisibleTab is rate-limited by Chrome anyway, so queueing is
  // the right shape regardless.
  let captureQueue = Promise.resolve()

  function captureTab() {
    const run = captureQueue.then(captureTabNow, captureTabNow)
    captureQueue = run.then(
      () => {},
      () => {}
    )
    return run
  }

  async function captureTabNow() {
    const chromeEls = Array.from(document.querySelectorAll(`[${CHROME_ATTR}]`))
    const restore = chromeEls.map((el) => el.style.visibility)
    chromeEls.forEach((el) => {
      el.style.visibility = "hidden"
    })
    try {
      if (chromeEls.length) await nextFrame()
      return await sendMessage({type: "CAPTURE_TAB"})
    } finally {
      chromeEls.forEach((el, i) => {
        el.style.visibility = restore[i]
      })
    }
  }

  // ── Screenshot: crop the visible-tab capture to the element ──────────
  async function captureElement(el) {
    const response = await captureTab()
    if (!response?.ok) return null
    const dataUrl = response.dataUrl

    const rect = el.getBoundingClientRect()
    const pad = 16

    let img
    try {
      img = await loadImage(dataUrl)
    } catch (_e) {
      return null
    }
    // The capture already carries the display's device-pixel density (a retina
    // screen gives scaleX ≈ 2, a standard monitor ≈ 1).
    const scaleX = img.naturalWidth / window.innerWidth
    const scaleY = img.naturalHeight / window.innerHeight

    const sx = Math.max(0, (rect.left - pad) * scaleX)
    const sy = Math.max(0, (rect.top - pad) * scaleY)
    const sw = Math.min(img.naturalWidth - sx, (rect.width + pad * 2) * scaleX)
    const sh = Math.min(img.naturalHeight - sy, (rect.height + pad * 2) * scaleY)
    if (sw <= 0 || sh <= 0) return dataUrl // element offscreen — fall back to full capture

    // Floor the stored screenshot at @2x density: on a standard (1x) monitor the
    // visible-tab capture is only 1x, so scale the crop up to MIN_CAPTURE_SCALE.
    // On a retina display the capture is already ≥2x, so the native density wins
    // and the crop is copied 1:1 (no upscaling, no extra bytes). A pixel budget
    // caps the upscale so a huge element on a 1x screen can't 4x its bytes past
    // the server's per-image cap and get silently dropped — such crops fall back
    // toward native density instead of a full 2x.
    const cssArea = (sw / scaleX) * (sh / scaleY)
    const budgetScale = Math.sqrt(MAX_CAPTURE_PIXELS / cssArea)
    const outScale = Math.max(scaleX, scaleY, Math.min(MIN_CAPTURE_SCALE, budgetScale))
    const upscaleX = outScale / scaleX
    const upscaleY = outScale / scaleY

    const canvas = document.createElement("canvas")
    canvas.width = Math.round(sw * upscaleX)
    canvas.height = Math.round(sh * upscaleY)
    const ctx = canvas.getContext("2d")
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)

    // Outline the element within the crop so the capture reads clearly.
    ctx.strokeStyle = "#f59e0b"
    ctx.lineWidth = Math.max(2, Math.round(2 * outScale))
    ctx.strokeRect(
      (rect.left * scaleX - sx) * upscaleX,
      (rect.top * scaleY - sy) * upscaleY,
      rect.width * scaleX * upscaleX,
      rect.height * scaleY * upscaleY
    )

    try {
      return canvas.toDataURL("image/png")
    } catch (_e) {
      return dataUrl
    }
  }

  // DevTools/Console lives in Chrome UI, outside the page DOM. This asks the
  // background worker to open Chrome's native screen/window picker, captures one
  // frame from the selected source, then lets the user crop the console area
  // inside a page-hosted preview before it is attached to an issue/review.
  async function captureDesktopArea(options = {}) {
    const frame = await captureDesktopFrame()
    if (!frame.ok) return frame

    let img
    try {
      img = await loadImage(frame.dataUrl)
    } catch (_e) {
      return {ok: false, error: "Could not read the captured window."}
    }

    const crop = await selectImageCrop(img, options)
    if (!crop) return {ok: false, canceled: true, error: "Capture canceled."}
    return {ok: true, dataUrl: crop}
  }

  async function captureDesktopFrame() {
    const chosen = await sendMessage({type: "CHOOSE_DESKTOP_MEDIA"})
    if (!chosen?.ok) return {ok: false, error: chosen?.error || "Could not start Chrome window capture."}
    if (!navigator.mediaDevices?.getUserMedia) {
      return {
        ok: false,
        error: "This page cannot read Chrome's desktop capture stream. Try again from an HTTPS or localhost page."
      }
    }

    let stream = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: chosen.streamId,
            maxWidth: 10000,
            maxHeight: 10000
          }
        }
      })
      const dataUrl = await captureFrameFromStream(stream)
      return {ok: true, dataUrl}
    } catch (e) {
      return {ok: false, error: e.message || "Could not capture the selected window."}
    } finally {
      if (stream) stream.getTracks().forEach((track) => track.stop())
    }
  }

  function captureFrameFromStream(stream) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video")
      video.muted = true
      video.playsInline = true
      video.srcObject = stream

      const failTimer = setTimeout(() => reject(new Error("Timed out waiting for the selected window.")), 5000)
      video.onloadedmetadata = async () => {
        try {
          await video.play()
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
          const width = video.videoWidth
          const height = video.videoHeight
          if (!width || !height) throw new Error("The selected window did not provide a video frame.")

          const canvas = document.createElement("canvas")
          canvas.width = width
          canvas.height = height
          canvas.getContext("2d").drawImage(video, 0, 0, width, height)
          clearTimeout(failTimer)
          resolve(canvas.toDataURL("image/png"))
        } catch (e) {
          clearTimeout(failTimer)
          reject(e)
        }
      }
      video.onerror = () => {
        clearTimeout(failTimer)
        reject(new Error("Could not read the selected window."))
      }
    })
  }

  function selectImageCrop(img, options = {}) {
    return new Promise((resolve) => {
      const title = options.title || "Capture console area"
      const detail = options.detail || "Drag over the Chrome console area in the screenshot."
      const action = options.action || "Add capture"

      const host = document.createElement("div")
      host.setAttribute(IGNORE_ATTR, "")
      const shadow = host.attachShadow({mode: "open"})
      const style = document.createElement("style")
      // Same tokens and controls as the composer and the review bar's send panel:
      // this crop dialog is the third face of the same extension.
      style.textContent = `
        ${OVERLAY_TOKENS}
        ${OVERLAY_CONTROLS}
        .backdrop {
          position: fixed; inset: 0; z-index: 2147483647;
          display: flex; align-items: center; justify-content: center; padding: 18px;
          background: rgba(0,0,0,.72);
          font: 13px/1.5 var(--font); color: var(--c-text); -webkit-font-smoothing: antialiased;
        }
        .panel {
          width: min(980px, calc(100vw - 36px)); max-height: calc(100vh - 36px); overflow: auto;
          background: var(--c-panel); color: var(--c-text); color-scheme: dark;
          border: 1px solid var(--c-border); border-radius: 8px;
          box-shadow: 0 16px 48px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.04);
        }
        .head {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 10px 9px 12px; border-bottom: 1px solid var(--c-border-soft);
        }
        .head b { font-size: 12px; font-weight: 600; color: var(--c-text); }
        .sp { flex: 1; }
        .body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
        .help { margin: 0; color: var(--c-sec); font-size: 12px; }
        .stage {
          position: relative; overflow: auto; max-height: calc(100vh - 210px); min-height: 240px;
          background: var(--c-inset); border: 1px solid var(--c-border); border-radius: 8px;
        }
        img { display: block; max-width: 100%; max-height: calc(100vh - 230px); margin: 0 auto; user-select: none; cursor: crosshair; }
        /* Amber matches the shift-click hover outline — "this is what you're grabbing". */
        .sel { position: absolute; display: none; pointer-events: none; border: 2px solid #f59e0b; background: rgba(245,158,11,.16); box-shadow: 0 0 0 9999px rgba(0,0,0,.28); }
        .actions { display: flex; align-items: center; gap: 8px; }
      `
      shadow.appendChild(style)
      const wrap = document.createElement("div")
      wrap.className = "backdrop"
      wrap.innerHTML = `
        <div class="panel" role="dialog" aria-modal="true">
          <div class="head"><b>${escapeHtml(title)}</b><span class="sp"></span><button class="x" type="button" data-act="cancel" title="Cancel" aria-label="Cancel">${OVERLAY_ICONS.close}</button></div>
          <div class="body">
            <p class="help">${escapeHtml(detail)}</p>
            <div class="stage"><div class="sel"></div></div>
            <div class="actions">
              <button class="ghost" type="button" data-act="full">Use full image</button>
              <span class="sp"></span>
              <button class="ghost" type="button" data-act="cancel">Cancel</button>
              <button class="primary" type="button" data-act="add">${escapeHtml(action)}</button>
            </div>
          </div>
        </div>
      `
      shadow.appendChild(wrap)

      const stage = wrap.querySelector(".stage")
      const sel = wrap.querySelector(".sel")
      const preview = new Image()
      preview.src = img.src
      preview.alt = ""
      preview.draggable = false
      preview.onload = () => requestAnimationFrame(defaultSelection)
      stage.insertBefore(preview, sel)
      document.documentElement.appendChild(host)

      let selection = null
      let dragging = false
      let start = null

      const cleanup = (value) => {
        host.remove()
        resolve(value)
      }

      const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
      const imagePoint = (event) => {
        const rect = preview.getBoundingClientRect()
        return {
          x: clamp(event.clientX - rect.left, 0, rect.width),
          y: clamp(event.clientY - rect.top, 0, rect.height)
        }
      }
      const setSelection = (a, b) => {
        selection = {
          x: Math.min(a.x, b.x),
          y: Math.min(a.y, b.y),
          width: Math.abs(b.x - a.x),
          height: Math.abs(b.y - a.y)
        }
        renderSelection()
      }
      const renderSelection = () => {
        const rect = preview.getBoundingClientRect()
        const stageRect = stage.getBoundingClientRect()
        const current = normalizedSelection()
        if (!current) {
          sel.style.display = "none"
          return
        }
        sel.style.display = "block"
        sel.style.left = `${rect.left - stageRect.left + stage.scrollLeft + current.x}px`
        sel.style.top = `${rect.top - stageRect.top + stage.scrollTop + current.y}px`
        sel.style.width = `${current.width}px`
        sel.style.height = `${current.height}px`
      }
      const normalizedSelection = () => {
        const rect = preview.getBoundingClientRect()
        if (!selection || selection.width < 8 || selection.height < 8) {
          return {x: 0, y: 0, width: rect.width, height: rect.height}
        }
        return selection
      }
      const defaultSelection = () => {
        const rect = preview.getBoundingClientRect()
        if (!rect.width || !rect.height) return
        selection = {x: 0, y: Math.round(rect.height * 0.58), width: rect.width, height: Math.round(rect.height * 0.42)}
        renderSelection()
      }

      stage.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        dragging = true
        start = imagePoint(event)
        setSelection(start, start)
        stage.setPointerCapture?.(event.pointerId)
      })
      stage.addEventListener("pointermove", (event) => {
        if (!dragging) return
        event.preventDefault()
        setSelection(start, imagePoint(event))
      })
      const stopDrag = (event) => {
        if (!dragging) return
        event.preventDefault()
        dragging = false
        setSelection(start, imagePoint(event))
      }
      stage.addEventListener("pointerup", stopDrag)
      stage.addEventListener("pointercancel", stopDrag)
      stage.addEventListener("scroll", renderSelection, {passive: true})

      shadow.querySelectorAll('[data-act="cancel"]').forEach((btn) => {
        btn.onclick = () => cleanup(null)
      })
      shadow.querySelector('[data-act="full"]').onclick = () => {
        const rect = preview.getBoundingClientRect()
        selection = {x: 0, y: 0, width: rect.width, height: rect.height}
        renderSelection()
      }
      shadow.querySelector('[data-act="add"]').onclick = () => {
        cleanup(cropImage(img, preview, normalizedSelection()))
      }

      wrap.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          cleanup(null)
        }
      })
      wrap.tabIndex = -1
      wrap.focus()
      requestAnimationFrame(defaultSelection)
    })
  }

  function cropImage(source, preview, rect) {
    const previewRect = preview.getBoundingClientRect()
    if (!previewRect.width || !previewRect.height) return source.src
    const scaleX = source.naturalWidth / previewRect.width
    const scaleY = source.naturalHeight / previewRect.height
    const sx = Math.max(0, Math.round(rect.x * scaleX))
    const sy = Math.max(0, Math.round(rect.y * scaleY))
    const sw = Math.min(source.naturalWidth - sx, Math.round(rect.width * scaleX))
    const sh = Math.min(source.naturalHeight - sy, Math.round(rect.height * scaleY))

    const outScale = Math.min(1, Math.sqrt(MAX_CAPTURE_PIXELS / Math.max(1, sw * sh)))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(sw * outScale))
    canvas.height = Math.max(1, Math.round(sh * outScale))
    const ctx = canvas.getContext("2d")
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    return canvasDataUrlWithinBudget(canvas)
  }

  function canvasDataUrlWithinBudget(canvas) {
    let current = canvas
    let dataUrl = current.toDataURL("image/png")
    if (dataUrl.length <= MAX_DESKTOP_CAPTURE_BYTES) return dataUrl

    dataUrl = current.toDataURL("image/jpeg", 0.92)
    let attempts = 0
    while (dataUrl.length > MAX_DESKTOP_CAPTURE_BYTES && attempts < 4) {
      const scale = 0.78
      const next = document.createElement("canvas")
      next.width = Math.max(1, Math.round(current.width * scale))
      next.height = Math.max(1, Math.round(current.height * scale))
      const ctx = next.getContext("2d")
      ctx.imageSmoothingQuality = "high"
      ctx.drawImage(current, 0, 0, next.width, next.height)
      current = next
      dataUrl = current.toDataURL("image/jpeg", 0.88)
      attempts++
    }
    return dataUrl
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = src
    })
  }

  // After the extension is reloaded/updated, this page keeps running the old
  // content script but its bridge to the extension is severed: `chrome.runtime`
  // becomes undefined. `chrome.runtime.id` is the cheap liveness check — present
  // while the context is valid, gone once it's orphaned.
  function extensionAlive() {
    try {
      return Boolean(chrome?.runtime?.id)
    } catch (_e) {
      return false
    }
  }

  const CONTEXT_LOST_MSG = "Extension was updated — reload this page to keep filing."

  function sendMessage(message) {
    return new Promise((resolve) => {
      // Guard before touching chrome.runtime.sendMessage: on an orphaned context
      // that access throws "Cannot read properties of undefined (reading
      // 'sendMessage')", which used to surface verbatim in the composer.
      if (!extensionAlive()) {
        resolve({ok: false, error: CONTEXT_LOST_MSG, contextLost: true})
        return
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          // The context can die between the call and this callback, so read
          // lastError defensively and translate the invalidation into guidance.
          const lastError = chrome.runtime?.lastError
          if (lastError) {
            const lost = !extensionAlive() || /context invalidated|receiving end does not exist/i.test(lastError.message || "")
            resolve({ok: false, error: lost ? CONTEXT_LOST_MSG : lastError.message, contextLost: lost})
          } else {
            resolve(response)
          }
        })
      } catch (e) {
        const lost = !extensionAlive()
        resolve({ok: false, error: lost ? CONTEXT_LOST_MSG : e.message, contextLost: lost})
      }
    })
  }

  // ── Clipboard & sound ───────────────────────────────────────────────
  //
  // Filing an issue or a review hands back the rendered Claude Code prompt; both
  // overlays put it on the clipboard and chime, so the next stop is a paste
  // rather than the issue page.

  // navigator.clipboard needs a secure context (and the manifest's
  // clipboardWrite, since the write lands after an awaited network round trip
  // rather than inside the click); the textarea/execCommand fallback covers
  // plain-http dev hosts.
  async function copyTextToClipboard(text) {
    if (!text) return false
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (_e) {
      /* fall through */
    }
    try {
      const scratch = document.createElement("textarea")
      scratch.value = text
      scratch.setAttribute(IGNORE_ATTR, "")
      scratch.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0;"
      document.documentElement.appendChild(scratch)
      scratch.focus()
      scratch.select()
      const ok = document.execCommand("copy")
      scratch.remove()
      return ok
    } catch (_e) {
      return false
    }
  }

  // Play a bundled sound effect. The bytes come from the background worker and
  // are decoded into a Web Audio buffer here, so nothing is loaded by URL in
  // page context: no web_accessible_resources entry to leak the extension id to
  // every page, and a host page's `media-src` CSP can't silence us. The decoded
  // buffer is cached, so repeat plays are instant.
  //
  // Best-effort by design — a muted tab, a suspended AudioContext or a missing
  // file must never take down the copy it is announcing.
  let audioCtx = null
  const audioBuffers = new Map()

  async function playSound(name) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return false
      if (!audioCtx) audioCtx = new Ctx()
      if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {})

      let buffer = audioBuffers.get(name)
      if (!buffer) {
        const res = await sendMessage({type: "FETCH_SOUND", payload: {name}})
        if (!res?.ok || !res.data) return false
        buffer = await audioCtx.decodeAudioData(base64ToArrayBuffer(res.data))
        audioBuffers.set(name, buffer)
      }

      const source = audioCtx.createBufferSource()
      const gain = audioCtx.createGain()
      gain.gain.value = 0.5 // a confirmation, not an announcement
      source.buffer = buffer
      source.connect(gain).connect(audioCtx.destination)
      source.start()
      return true
    } catch (_e) {
      return false
    }
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]))
  }
  function escapeAttr(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]))
  }

  // ── Shared overlay design system ────────────────────────────────────
  //
  // Both overlays (the shift-click composer and the review bar) float over
  // arbitrary pages in their own shadow roots, but they belong to the same
  // product and must read as one. These strings are the single source of that
  // look, so the two can't drift apart the way they had.
  //
  // The palette is the workspace app's dark theme, transcribed from
  // app/assets/tailwind/components/workspace.css. Dark-only on purpose: the
  // backdrop is an unknown third-party page, and one opaque high-contrast
  // surface is more reliably legible than one that tracks the host page's theme.
  //
  // Surface layering matches the app: the panel is the lightest surface, inputs
  // and cards sit a hair darker as a recessed well, and --c-inset is the deepest
  // fill. (The overlays used to invert this, recessing inputs to near-black.)
  //
  // `all: initial` does not reset custom properties, so tokens declared in the
  // same rule survive it and inherit through the whole shadow tree.
  const OVERLAY_TOKENS = `
    :host {
      all: initial;
      --c-onaccent: #ffffff;
      --c-accent: #5e6ad2; --c-accent-hover: #5763c9; --c-accent-text: #7c87e0;
      --c-panel: #1a1b1e;       /* floating popover surface */
      --c-card: #17181b;        /* recessed card / input surface */
      --c-inset: #0e0f11;       /* deepest fill: thumbnails, pills, icon buttons */
      --c-active: #212226;
      --c-border: #2a2c30;      /* input / menu border */
      --c-border-soft: #1f2023; /* card / divider border */
      --c-hover: #17181b;
      --c-text: #e6e6e8;
      --c-text2: #c4c5cb;
      --c-sec: #9a9ba0;
      --c-muted: #8a8b91;
      --c-faint: #6b6d75;
      --c-danger: #c9667a; --c-danger-bg: #2a1d1f;
      --c-ok: #7ee787;          /* workspace.css --hl-inserted-fg */
      --font: InterVariable, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
  `

  // Form controls, buttons and the status line, styled exactly as the app styles
  // them (see app/views/issues/_session_launcher.html.erb): sentence-case labels,
  // 32px controls, 6px radii, borderless secondary buttons.
  const OVERLAY_CONTROLS = `
    label, .lbl { font-size: 11px; font-weight: 500; color: var(--c-muted); }
    .opt { font-size: 11px; font-weight: 400; color: var(--c-faint); margin-left: 2px; }

    input[type=text], select, textarea {
      width: 100%; height: 32px; padding: 0 8px; font: inherit; font-size: 13px;
      color: var(--c-text); background: var(--c-card);
      border: 1px solid var(--c-border); border-radius: 6px;
    }
    /* A native select can't be trusted to honour a 32px box across host pages, so
       the control is drawn here and the chevron is a background image. */
    select {
      appearance: none; -webkit-appearance: none; padding-right: 26px; cursor: pointer;
      text-overflow: ellipsis; color-scheme: dark;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%238a8b91' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'><path d='M3 4.5 6 7.5 9 4.5'/></svg>");
      background-repeat: no-repeat; background-position: right 8px center;
    }
    option { background: var(--c-panel); color: var(--c-text); }
    textarea { height: auto; padding: 7px 8px; line-height: 1.5; resize: vertical; }
    input::placeholder, textarea::placeholder { color: var(--c-faint); }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--c-accent); }

    /* Close / icon button — the app's .ws-iconbtn. */
    .x {
      flex: none; display: inline-flex; align-items: center; justify-content: center;
      width: 30px; height: 30px; border-radius: 999px;
      border: 1px solid var(--c-border); background: var(--c-inset);
      color: var(--c-sec); cursor: pointer; transition: background .12s, color .12s;
    }
    .x:hover { background: var(--c-hover); color: var(--c-text); }
    .x:active { background: var(--c-active); transform: scale(.96); }

    /* Secondary buttons are borderless text buttons, as in the app. */
    button.ghost {
      height: 32px; padding: 0 12px; border: 0; border-radius: 6px; background: none;
      color: var(--c-sec); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
    }
    button.ghost:hover { background: var(--c-hover); color: var(--c-text); }
    button.ghost.danger:hover { background: var(--c-danger-bg); color: var(--c-danger); }
    button.ghost:disabled { opacity: .5; cursor: default; }
    button.ghost:disabled:hover { background: none; color: var(--c-sec); }

    button.primary {
      display: inline-flex; align-items: center; gap: 7px;
      height: 32px; padding: 0 14px; border: 0; border-radius: 6px;
      background: var(--c-accent); color: var(--c-onaccent);
      font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
    }
    button.primary:hover { background: var(--c-accent-hover); }
    button.primary:disabled { opacity: .55; cursor: default; }
    button.primary:disabled:hover { background: var(--c-accent); }
    .kbd { font: inherit; font-size: 11px; color: rgba(255,255,255,.65); font-variant-numeric: tabular-nums; }

    /* Hidden when empty — emit the status line with no inner whitespace. */
    .msg { font-size: 12px; line-height: 1.4; color: var(--c-sec); word-break: break-word; }
    .msg:empty { display: none; }
    .msg.err { color: var(--c-danger); }
    .msg.ok { color: var(--c-ok); }
    .msg a { color: var(--c-accent-text); text-decoration: none; }
    .msg a:hover { text-decoration: underline; }

    .cfg { font-size: 12px; line-height: 1.55; color: var(--c-sec); margin: 0; }

    .x:focus-visible, button.ghost:focus-visible, button.primary:focus-visible {
      outline: 2px solid var(--c-accent); outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
      .x:active { transform: none; }
    }
  `

  // Inline SVG so the overlays need no external assets and no glyph fonts.
  const OVERLAY_ICONS = {
    grip: `<svg class="grip" width="8" height="13" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="4" r="1"/><circle cx="7" cy="4" r="1"/><circle cx="3" cy="8" r="1"/><circle cx="7" cy="8" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="7" cy="12" r="1"/></svg>`,
    close: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
    remove: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`,
    console: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5l2 1.75L5 10M8.75 10h2.5"/></svg>`,
    chev: `<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 3 7.5 6 4.5 9"/></svg>`,
    mic: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5"/></svg>`,
    stop: `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>`
  }

  // Cmd on Apple hardware, Ctrl everywhere else — shown on the submit button so
  // the shortcut isn't a secret.
  const SUBMIT_KEYS = /Mac|iPod|iPhone|iPad/.test(navigator.platform || "") ? "⌘↵" : "Ctrl ↵"

  // ── Keystroke containment ───────────────────────────────────────────
  // Every tool surface (composer, review bar, comment popover, tagger) mounts
  // its inputs inside an open shadow root. Key events dispatched in a shadow
  // tree are retargeted as they cross the boundary, so by the time they reach
  // the host page `event.target`/`document.activeElement` is our shadow host —
  // a plain <div>. A page's global shortcuts (Amplifier's j/k/c/// v, or any
  // site's) can't tell we're typing, and swallow the keystroke.
  //
  // Fix: stop key events at the shadow boundary whenever they originate from one
  // of our own editable fields. Bound on the shadow ROOT (bubble phase), so the
  // panel's own handlers — Escape to close, ⌘/Ctrl+↵ to submit — run first (they
  // sit on a descendant), and only then is the event kept from leaving the tree.
  // keydown/keyup/keypress are all covered because shortcut handlers can listen
  // on any of them. Scoped to fields (not the whole panel) so non-typing keys
  // pressed on a button still behave normally.
  function isEditableTarget(node) {
    if (!node) return false
    // `isContentEditable` is the truth in a real browser (it's also true for a
    // node nested inside an editable host); the attribute check is the fallback.
    if (node.isContentEditable) return true
    if (typeof node.closest !== "function") return false
    const field = node.closest("input, textarea, select, [contenteditable]")
    // A [contenteditable="false"] island (e.g. a mention chip) isn't typable.
    return Boolean(field) && field.getAttribute("contenteditable") !== "false"
  }

  function guardFieldKeystrokes(root) {
    if (!root || root.__sciKeyGuarded) return
    root.__sciKeyGuarded = true
    const stop = (event) => {
      if (isEditableTarget(event.target)) event.stopPropagation()
    }
    for (const type of ["keydown", "keyup", "keypress"]) {
      root.addEventListener(type, stop)
    }
  }

  window.__sciShared = {
    IGNORE_ATTR,
    CHROME_ATTR,
    partialChain,
    selectorFor,
    cssPathParts,
    keyStyles,
    describeElement,
    meta,
    controllerInfo,
    buildReport,
    buildChromeConsoleReport,
    buildAnnotationReport,
    captureTab,
    captureElement,
    captureDesktopArea,
    loadImage,
    extensionAlive,
    sendMessage,
    copyTextToClipboard,
    playSound,
    escapeHtml,
    escapeAttr,
    OVERLAY_TOKENS,
    OVERLAY_CONTROLS,
    OVERLAY_ICONS,
    SUBMIT_KEYS,
    guardFieldKeystrokes,
  }
})()
