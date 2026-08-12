// Shift-click issue filer — background service worker (MV3).
//
// Jobs the content script can't do itself:
//   1. CAPTURE_TAB       — screenshot the visible tab (needs the tabs API).
//   2. CHOOSE_DESKTOP_MEDIA — ask Chrome for a screen/window stream id.
//   3. CREATE_ISSUE      — POST captures to the workspace as an issue.
//   4. LIST_PROJECTS     — GET the account's projects to refresh the picker.
//   5. LIST_LABELS       — GET the account's labels to refresh the picker.
//   6. LIST_MOODBOARDS   — GET the account's mood boards for the picker.
//   7. ADD_TO_MOODBOARD  — POST captures onto a mood board as clips.
//   8. MINT_REALTIME_TOKEN — GET an OpenAI Realtime ephemeral secret (for the
//                            composer's "Dictate" mic) from the workspace.
//   9. REALTIME_SDP_EXCHANGE — POST the WebRTC SDP offer to OpenAI and return its
//                            answer, on the content script's behalf.
//  10. SWITCH_ACCOUNT       — select another of the user's workspace accounts;
//                            every call above is then scoped to it (account_id).
//  11. FETCH_SOUND          — read a bundled sound effect off disk and hand the
//                            bytes to the content script to play.
// The authenticated calls run here so the token never touches page context and
// requests aren't subject to the page's CORS (the extension holds
// host_permissions for the target).
//
// Config lives in chrome.storage.sync. The API token is user-level, so ONE
// connection (baseUrl + token) reaches every workspace account the user
// belongs to: `accounts` is the server-reported list (from /inspector/ping)
// and `accountId` is the one currently selected — sent as account_id on every
// request. The flat keys — team, the cached picker lists
// (teams/projects/labels/moodBoards) and the last-used picks
// (lastProject/lastLabel) — are the SELECTED account's working set, refreshed
// on every switch; `lastUsed` keeps each account's picks so switching back
// restores them.
//
// { enabled, baseUrl, token, accountId, accounts, team, teams, labels,
//   lastProject, lastLabel, lastUsed }.

// Where issues are filed unless the user points the extension somewhere else in
// Settings. Amplifier's hosted workspace is the default so a fresh install only
// has to paste a token; self-hosters overwrite it with their own base URL.
const DEFAULT_BASE_URL = "https://amplifier.app"

const DEFAULTS = {
  enabled: true,
  baseUrl: DEFAULT_BASE_URL,
  token: "",
  accountId: "",
  accounts: [],
  team: "",
  teams: [],
  labels: [],
  lastProject: "",
  lastLabel: "",
  lastUsed: {}
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get({...DEFAULTS, activeAccountId: ""})
  const merged = {...DEFAULTS, ...current}
  // Migrate the short-lived per-account-token shape (1.7.0), where each
  // accounts entry carried its own connection: adopt the active entry's
  // connection and let the server rebuild the account list from the token.
  const manual = (merged.accounts || []).filter((a) => a && a.token)
  if (manual.length) {
    const active = manual.find((a) => a.id === current.activeAccountId) || manual[0]
    Object.assign(merged, {
      baseUrl: active.baseUrl,
      token: active.token,
      team: active.team || "",
      lastProject: active.lastProject || "",
      lastLabel: active.lastLabel || "",
      accounts: [],
      accountId: ""
    })
  }
  delete merged.activeAccountId
  await chrome.storage.sync.set(merged)
  await chrome.storage.sync.remove("activeAccountId")
  refreshBadge()
  // A configured extension that predates the account picker has no account
  // list yet — fetch it so the pickers can offer it straight away.
  if (merged.baseUrl && merged.token && !merged.accounts.length) {
    await switchAccount({id: merged.accountId})
  }
})

chrome.runtime.onStartup?.addListener(refreshBadge)

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.enabled) refreshBadge()
})

// Keyboard shortcuts (see manifest "commands"): toggle the shift-click
// inspector, and toggle the review bar (content scripts react to the flag).
chrome.commands?.onCommand.addListener(async (command) => {
  if (command === "toggle-inspector") {
    const {enabled} = await chrome.storage.sync.get({enabled: true})
    await chrome.storage.sync.set({enabled: !enabled})
  } else if (command === "toggle-review-bar") {
    const {reviewActive} = await chrome.storage.local.get({reviewActive: false})
    await chrome.storage.local.set({reviewActive: !reviewActive})
  } else if (command === "toggle-tagger") {
    // The tagger arms per-page rather than per-workspace: it fetches the catalog
    // when armed, so a flag in storage would leave stale variants on screen.
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true})
    if (tab?.id) chrome.tabs.sendMessage(tab.id, {type: "TOGGLE_TAGGER"}).catch(() => {})
  }
})

async function refreshBadge() {
  try {
    const {enabled} = await chrome.storage.sync.get({enabled: true})
    await chrome.action.setBadgeBackgroundColor({color: enabled ? "#5e6ad2" : "#4a4c52"})
    await chrome.action.setBadgeText({text: enabled ? "ON" : "off"})
  } catch (_e) {
    /* action may be unavailable in some contexts */
  }
}
refreshBadge()

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "CAPTURE_TAB":
      captureTab(sender).then(sendResponse)
      return true // async response
    case "CHOOSE_DESKTOP_MEDIA":
      chooseDesktopMedia(sender).then(sendResponse)
      return true
    case "CREATE_ISSUE":
      createIssue(message.payload).then(sendResponse)
      return true
    case "LIST_PROJECTS":
      listProjects().then(sendResponse)
      return true
    case "LIST_LABELS":
      listLabels().then(sendResponse)
      return true
    case "LIST_COMPONENTS":
      listComponents(message.payload).then(sendResponse)
      return true
    case "TAG_ELEMENT":
      tagElement(message.payload).then(sendResponse)
      return true
    case "CAPTURE_COMPONENT":
      captureComponent(message.payload).then(sendResponse)
      return true
    case "LIST_MOODBOARDS":
      listMoodBoards().then(sendResponse)
      return true
    case "ADD_TO_MOODBOARD":
      addToMoodBoard(message.payload).then(sendResponse)
      return true
    case "SEND_REVIEW":
      sendReview(message.payload).then(sendResponse)
      return true
    case "MINT_REALTIME_TOKEN":
      mintRealtimeToken().then(sendResponse)
      return true
    case "REALTIME_SDP_EXCHANGE":
      realtimeSdpExchange(message.payload).then(sendResponse)
      return true
    case "SWITCH_ACCOUNT":
      switchAccount(message.payload).then(sendResponse)
      return true
    case "FETCH_SOUND":
      fetchSound(message.payload).then(sendResponse)
      return true
    case "OPEN_OPTIONS":
      chrome.runtime.openOptionsPage()
      sendResponse({ok: true})
      return false
    default:
      return false
  }
})

// Append the selected account to an endpoint URL. Requests without a selection
// let the server fall back to the token's default account.
function withAccount(endpoint, accountId) {
  if (!accountId) return endpoint
  return endpoint + (endpoint.includes("?") ? "&" : "?") + "account_id=" + encodeURIComponent(accountId)
}

// Select another of the user's workspace accounts (same connection, same
// token): restore that account's remembered last-used picks, drop the previous
// account's cached picker lists, then re-ping the workspace scoped to it to
// repopulate them (and refresh the account list itself). A failed ping still
// switches — the composer refetches the lists when it next opens.
async function switchAccount(payload) {
  const id = payload?.id != null ? String(payload.id) : ""
  const {baseUrl, token, lastUsed} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", lastUsed: {}})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const last = (lastUsed || {})[id] || {}
  await chrome.storage.sync.set({
    accountId: id,
    team: last.team || "",
    lastProject: last.project || "",
    lastLabel: last.label || "",
    teams: [],
    projects: [],
    labels: [],
    moodBoards: []
  })

  const ping = await pingWorkspace(baseUrl, token, id)
  if (!ping.ok) return {ok: true, warning: ping.error}

  await chrome.storage.sync.set({
    accountId: ping.data.account_id != null ? String(ping.data.account_id) : id,
    accounts: ping.data.accounts || [],
    teams: ping.data.teams || [],
    projects: ping.data.projects || [],
    labels: ping.data.labels || [],
    moodBoards: ping.data.mood_boards || []
  })
  return {ok: true, account: ping.data.account, user: ping.data.user}
}

async function pingWorkspace(baseUrl, token, accountId) {
  const endpoint = withAccount(baseUrl.replace(/\/+$/, "") + "/inspector/ping", accountId)
  try {
    const res = await fetch(endpoint, {
      headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}
    })
    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }
    if (res.ok && data.ok) return {ok: true, data}
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// Remember the team, project and label an issue/review was just filed with, so
// the composer preselects the same picks next time — flat for the current
// account, and keyed into `lastUsed` so they survive switching away and back.
async function rememberLastUsed({team, project, label}) {
  try {
    const {accountId, lastUsed} = await chrome.storage.sync.get({accountId: "", lastUsed: {}})
    const updates = {lastProject: project || "", lastLabel: label || ""}
    if (team) updates.team = team
    if (accountId) {
      const map = lastUsed || {}
      map[accountId] = {team: team || (map[accountId] || {}).team || "", project: project || "", label: label || ""}
      updates.lastUsed = map
    }
    await chrome.storage.sync.set(updates)
  } catch (_e) {
    /* best effort */
  }
}

async function captureTab(sender) {
  try {
    const windowId = sender?.tab?.windowId
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {format: "png"})
    return {ok: true, dataUrl}
  } catch (e) {
    return {ok: false, error: e.message}
  }
}

async function chooseDesktopMedia(sender) {
  if (!chrome.desktopCapture?.chooseDesktopMedia) {
    return {ok: false, error: "Chrome desktop capture is not available."}
  }

  return new Promise((resolve) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(["screen", "window"], sender?.tab, (streamId) => {
        const lastError = chrome.runtime?.lastError
        if (lastError) {
          resolve({ok: false, error: lastError.message})
        } else if (!streamId) {
          resolve({ok: false, error: "Screen capture was canceled."})
        } else {
          resolve({ok: true, streamId})
        }
      })
    } catch (e) {
      resolve({ok: false, error: e.message})
    }
  })
}

async function createIssue(payload) {
  const {baseUrl, token, team, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", team: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const endpoint = baseUrl.replace(/\/+$/, "") + "/inspector/issues"
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        account_id: accountId || null,
        title: payload.title,
        note: payload.note || null, // the user's free-text instruction for the AI
        team: payload.team || team || "",
        project: payload.project || null,
        label: payload.label || null,
        // Ask for the filed issue rendered as a prompt, so the composer can put
        // it on the clipboard instead of sending the user to the issue page.
        include_prompt: payload.includePrompt === true,
        // The stacked-capture shape. Legacy single-capture fields are still sent
        // as a fallback for older callers / the curl example.
        captures: payload.captures || null,
        body: payload.body || null,
        url: payload.url || null,
        image: payload.image || null
      })
    })

    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }

    if (res.ok && data.ok) {
      // Remember where this issue was filed — team, project and label — so the
      // composer preselects the same next time (including an explicit
      // "No project" / "No label").
      await rememberLastUsed({team: payload.team || team, project: payload.project, label: payload.label})
      return {ok: true, identifier: data.identifier, url: data.url, prompt: data.prompt || null}
    }
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// POST a review-bar session to the workspace: files one issue from the
// gathered annotations and (unless opted out) dispatches it into the
// connected Claude Code session via the channel. The response's `sent` flag
// tells the bar whether a channel actually received it.
async function sendReview(payload) {
  const {baseUrl, token, team, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", team: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const endpoint = baseUrl.replace(/\/+$/, "") + "/inspector/reviews"
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        account_id: accountId || null,
        title: payload.title || null,
        note: payload.note || null,
        team: payload.team || team || "",
        project: payload.project || null,
        label: payload.label || null,
        send_to_claude: payload.sendToClaude !== false,
        // "Copy for Claude Code" asks for the rendered prompt back so the
        // content script can put it (with hosted image URLs) on the clipboard.
        include_prompt: payload.includePrompt === true,
        items: payload.items || []
      })
    })

    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }

    if (res.ok && data.ok) {
      // Remember the team/project/label for next time, like the issue composer.
      await rememberLastUsed({team: payload.team || team, project: payload.project, label: payload.label})
      return {ok: true, identifier: data.identifier, url: data.url, sent: Boolean(data.sent), prompt: data.prompt || null}
    }
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// Mint an OpenAI Realtime ephemeral secret from the workspace so the composer's
// "Dictate" mic can open a WebRTC transcription session. The workspace holds the
// standard OpenAI key and authenticates the user by the same API token as every
// other call here; we only ever receive the short-lived ephemeral secret.
async function mintRealtimeToken() {
  const {baseUrl, token, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const endpoint = withAccount(baseUrl.replace(/\/+$/, "") + "/inspector/realtime_token", accountId)
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}
    })
    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }
    if (res.ok && data.ok) return {ok: true, token: data.token}
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// Complete the WebRTC handshake with OpenAI on the content script's behalf: POST
// its SDP offer to the Realtime calls endpoint (Bearer = the ephemeral secret)
// and hand back OpenAI's SDP answer. Done here, not in the page, so it isn't
// subject to the page's CORS — the same reason every other network call lives in
// this worker. The ephemeral secret is short-lived and scoped to one session.
async function realtimeSdpExchange(payload) {
  const key = payload?.key
  const sdp = payload?.sdp
  if (!key || !sdp) return {ok: false, error: "Missing SDP offer or ephemeral key."}

  const endpoint = "https://api.openai.com/v1/realtime/calls"
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {Authorization: `Bearer ${key}`, "Content-Type": "application/sdp"},
      body: sdp
    })
    const answer = await res.text()
    if (res.ok) return {ok: true, sdp: answer}
    return {ok: false, error: `OpenAI handshake failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach OpenAI: ${e.message}`}
  }
}

// GET the account's active projects so the composer can keep its picker current
// (and show each project's emoji). Caches the list into chrome.storage.sync so
// it's available immediately next time, mirroring listMoodBoards.
async function listProjects() {
  const {baseUrl, token, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const endpoint = withAccount(baseUrl.replace(/\/+$/, "") + "/inspector/projects", accountId)
  try {
    const res = await fetch(endpoint, {
      headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}
    })
    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }
    if (res.ok && data.ok) {
      const projects = data.projects || []
      try {
        await chrome.storage.sync.set({projects})
      } catch (_e) {
        /* best effort cache */
      }
      return {ok: true, projects}
    }
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// GET the project's component catalog so the element tagger can offer a
// component and a variant. Not cached: a catalog moves whenever the repo does,
// and tagging a spot to a variant that was withdrawn an hour ago is exactly the
// drift the registry exists to prevent.
async function listComponents(payload) {
  const {baseUrl, token, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const query = payload?.project ? `?project=${encodeURIComponent(payload.project)}` : ""
  const endpoint = withAccount(baseUrl.replace(/\/+$/, "") + "/inspector/components" + query, accountId)
  try {
    const res = await fetch(endpoint, {
      headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}
    })
    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }
    if (res.ok && data.ok) return {ok: true, project: data.project, components: data.components || []}
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// POST the tag: bind this GUI spot to the component@variant it must render.
// Whether the spot was already bound, whether the variant still exists and
// whether the component is being retired are all decided server-side.
async function tagElement(payload) {
  const {baseUrl, token, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const endpoint = baseUrl.replace(/\/+$/, "") + "/inspector/component_instances"
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        account_id: accountId || null,
        project: payload.project || null,
        component: payload.component,
        variant: payload.variant || null,
        location: payload.location,
        url: payload.url || null
      })
    })
    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }
    if (res.ok && data.ok) return {ok: true, message: data.message, drift: data.drift, instance: data.instance}
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// POST an element from the running page as a component: its markup, its computed
// styles, and the view/partial it was rendered from. The catalog is built from
// what actually ships, rather than from what a repo last exported.
async function captureComponent(payload) {
  const {baseUrl, token, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const endpoint = baseUrl.replace(/\/+$/, "") + "/inspector/components"
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        account_id: accountId || null,
        project: payload.project || null,
        name: payload.name,
        markup: payload.markup,
        styles: payload.styles || {},
        location: payload.location || null,
        url: payload.url || null,
        template_path: payload.templatePath || null,
        code_path: payload.codePath || null
      })
    })
    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }
    if (res.ok && data.ok) return {ok: true, message: data.message, created: data.created, component: data.component}
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// GET the account's labels so the composer can keep its picker current. Caches
// the list into chrome.storage.sync so it's available immediately next time.
async function listLabels() {
  const {baseUrl, token, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const endpoint = withAccount(baseUrl.replace(/\/+$/, "") + "/inspector/labels", accountId)
  try {
    const res = await fetch(endpoint, {
      headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}
    })
    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }
    if (res.ok && data.ok) {
      const labels = data.labels || []
      try {
        await chrome.storage.sync.set({labels})
      } catch (_e) {
        /* best effort cache */
      }
      return {ok: true, labels}
    }
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// GET the account's mood boards so the composer can offer a picker. Caches the
// list into chrome.storage.sync so it's available immediately next time.
async function listMoodBoards() {
  const {baseUrl, token, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const endpoint = withAccount(baseUrl.replace(/\/+$/, "") + "/inspector/mood_boards", accountId)
  try {
    const res = await fetch(endpoint, {
      headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}
    })
    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }
    if (res.ok && data.ok) {
      const boards = data.mood_boards || []
      try {
        await chrome.storage.sync.set({moodBoards: boards})
      } catch (_e) {
        /* best effort cache */
      }
      return {ok: true, moodBoards: boards}
    }
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}

// Read a bundled sound effect (sounds/*.mp3) and hand its bytes back base64'd.
// The worker reads it because it can: fetching an extension file from here needs
// no web_accessible_resources entry — so the sounds stay invisible to the pages
// we inject into, and playback in the content script (Web Audio, from these
// bytes) is never at the mercy of the host page's CSP. Cached for the worker's
// lifetime; a ~20KB file is cheap to re-read if Chrome recycles it.
const SOUNDS = {copied: "sounds/copied.mp3"}
const soundCache = {}

async function fetchSound(payload) {
  const name = payload?.name
  const path = SOUNDS[name]
  if (!path) return {ok: false, error: `Unknown sound "${name}"`}
  if (soundCache[name]) return {ok: true, data: soundCache[name]}

  try {
    const res = await fetch(chrome.runtime.getURL(path))
    if (!res.ok) return {ok: false, error: `Could not read ${path} (HTTP ${res.status})`}
    const bytes = new Uint8Array(await res.arrayBuffer())
    // btoa in chunks — spreading 20K bytes into String.fromCharCode at once
    // risks blowing the argument limit.
    let binary = ""
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
    }
    soundCache[name] = btoa(binary)
    return {ok: true, data: soundCache[name]}
  } catch (e) {
    return {ok: false, error: e.message}
  }
}

// POST the stacked captures onto a mood board — either an existing board
// (boardId) or a new/looked-up one (boardName). Each capture becomes a clip.
async function addToMoodBoard(payload) {
  const {baseUrl, token, accountId} = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  if (!baseUrl || !token) {
    return {ok: false, error: "Extension not configured — set the app URL and API token in settings."}
  }

  const endpoint = baseUrl.replace(/\/+$/, "") + "/inspector/mood_boards"
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        account_id: accountId || null,
        board_id: payload.boardId || null,
        board_name: payload.boardName || null,
        captures: payload.captures || null
      })
    })

    let data = {}
    try {
      data = await res.json()
    } catch (_e) {
      /* non-JSON error body */
    }

    if (res.ok && data.ok) {
      return {ok: true, moodBoard: data.mood_board, added: data.added, url: data.url}
    }
    return {ok: false, error: data.error || `Request failed (HTTP ${res.status})`}
  } catch (e) {
    return {ok: false, error: `Could not reach ${endpoint}: ${e.message}`}
  }
}
