// Talking to the workspace: where a URL the user typed gets turned into an
// endpoint, and the ONE place a response gets turned into JSON.
//
// Loaded as a plain script by both the options page (<script src="api.js">)
// and the background service worker (importScripts) — globals, not modules,
// because the worker is a classic script.
//
// Why it exists: "Workspace URL" is a free-text field and the thing answering
// on the other end isn't always the workspace. A local dev server hands back
// its index.html for every path, a tunnel shows an interstitial, a proxy shows
// a sign-in page — all of them 200 OK with `<!DOCTYPE html>`. Calling
// res.json() on that throws `Unexpected token '<'`, which is what the user
// used to get: an uncaught error in the console and a settings page that just
// sat there. Everything here returns a sentence instead of throwing.

// Hosts that only ever speak http in practice — prefixing them with https
// would fail the handshake rather than teach anyone anything.
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:$|\/)/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

// Normalize what was pasted into the base URL the /inspector/* routes hang off:
// supply the scheme when it's missing (a bare `amplifier.app` otherwise
// resolves against the extension's own origin), drop trailing slashes, and drop
// our own route if the whole endpoint was pasted. Returns "" for anything that
// isn't an http(s) URL, so callers can say so plainly.
function normalizeBaseUrl(input) {
  const raw = String(input || "").trim()
  if (!raw) return ""

  const candidate = HAS_SCHEME.test(raw) ? raw : (LOCAL_HOST.test(raw) ? "http://" : "https://") + raw
  let url
  try {
    url = new URL(candidate)
  } catch (_e) {
    return ""
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return ""

  const path = url.pathname.replace(/\/inspector(?:\/.*)?$/, "").replace(/\/+$/, "")
  return url.origin + path
}

// Build an /inspector/* endpoint from stored config. Requests without a
// selected account let the server fall back to the token's default account.
function endpointFor(baseUrl, path, accountId, query) {
  const base = normalizeBaseUrl(baseUrl)
  const params = new URLSearchParams(query || {})
  if (accountId) params.set("account_id", String(accountId))
  const search = params.toString()
  return base + path + (search ? "?" + search : "")
}

// Describe a response that wasn't the JSON we asked for, in terms of what the
// user can do about it.
function describeNonJson(res, body) {
  const type = (res.headers?.get?.("content-type") || "").split(";")[0].trim()
  const where = res.url || "That URL"
  if (!body.trim()) {
    return `${where} answered with an empty body (HTTP ${res.status}), not JSON. Check the workspace URL.`
  }
  const isPage = /html/i.test(type) || /^\s*<(?:!doctype|html)/i.test(body)
  if (isPage) {
    return (
      `${where} answered with a web page (HTTP ${res.status}), not the workspace API. ` +
      "Check the workspace URL points at the app that owns your issues — not the site you're inspecting."
    )
  }
  return `${where} answered with ${type || "an unreadable response"} (HTTP ${res.status}), not JSON. Check the workspace URL.`
}

// Fetch and parse in one go. Never throws and never rejects: returns
// {status, data, error}, where `error` is a ready-to-show sentence for the
// failures that aren't the API talking (unreachable host, a page instead of
// JSON) and `data` is the parsed object when it is. HTTP status is left to the
// caller — a 401 carrying a JSON body is the server answering, not a fault.
async function requestJson(url, init) {
  let res
  try {
    res = await fetch(url, init)
  } catch (e) {
    return {status: 0, data: {}, error: `Could not reach ${url}: ${e.message}`}
  }

  let body = ""
  try {
    body = await res.text()
  } catch (e) {
    return {status: res.status, data: {}, error: `Could not read the response from ${url}: ${e.message}`}
  }

  let data = null
  try {
    data = JSON.parse(body)
  } catch (_e) {
    /* handled below — the body wasn't JSON at all */
  }
  if (data === null || typeof data !== "object") {
    return {status: res.status, data: {}, error: describeNonJson(res, body)}
  }
  return {status: res.status, data, error: null}
}

// The shape every background-worker handler wants: {ok: true, data} when the
// workspace answered successfully, {ok: false, error} — with a sentence worth
// showing — when it didn't.
async function apiCall(url, init) {
  const {status, data, error} = await requestJson(url, init)
  if (error) return {ok: false, error}
  if (status >= 200 && status < 300 && data.ok) return {ok: true, data}
  return {ok: false, error: data.error || `Request failed (HTTP ${status})`}
}

// ── Storage layout: settings sync, workspace lists don't ─────────────
//
// chrome.storage.sync caps EACH item at 8KB (QUOTA_BYTES_PER_ITEM) and a set()
// that breaches it rejects with "Resource::kQuotaBytesPerItem quota exceeded".
// Switching accounts used to do exactly that: it cached the workspace's
// project, label, mood-board and account lists into sync, and any workspace
// with real content outgrows 8KB of JSON. The switch then half-applied — the
// new accountId landed, the pickers stayed empty — and the failure only existed
// as an uncaught promise in the console.
//
// So the two kinds of data live in the area that suits them:
//
//   sync  — the settings. A handful of short strings the user chose, worth
//           carrying to their other machines.
//   local — the workspace lists. A cache of what the server just said, tied to
//           this machine's selected account, refetched whenever a panel opens.
//           Nothing about them wants syncing, and local has room (the manifest
//           also asks for `unlimitedStorage`).
// Where issues are filed unless the user points the extension somewhere else in
// Settings. Amplifier's hosted workspace is the default so a fresh install only
// has to paste a token; self-hosters overwrite it with their own base URL. It
// lives here because every context that reads a base URL already loads api.js.
const DEFAULT_BASE_URL = "https://amplifier.app"

const SETTING_DEFAULTS = {
  enabled: true,
  baseUrl: DEFAULT_BASE_URL,
  token: "",
  accountId: "",
  team: "",
  lastProject: "",
  lastLabel: "",
  lastUsed: {}
}

const WORKSPACE_CACHE_DEFAULTS = {
  accounts: [],
  teams: [],
  projects: [],
  labels: [],
  moodBoards: []
}

const WORKSPACE_CACHE_KEYS = Object.keys(WORKSPACE_CACHE_DEFAULTS)

// Write the cached lists. Never rejects: a cache that can't be written is worth
// a warning, not a failed account switch — every panel refetches these anyway.
async function saveWorkspaceCache(values) {
  try {
    await chrome.storage.local.set(values)
    return {ok: true}
  } catch (e) {
    return {ok: false, error: `Could not cache the workspace lists: ${e.message}`}
  }
}

// Read the settings and the cached lists as one object, the way every panel
// wants them. Pass narrower defaults to read a subset.
async function loadConfig(settingDefaults = SETTING_DEFAULTS, cacheDefaults = WORKSPACE_CACHE_DEFAULTS) {
  const [settings, cache] = await Promise.all([
    chrome.storage.sync.get(settingDefaults),
    chrome.storage.local.get(cacheDefaults)
  ])
  return {...settings, ...cache}
}

// Move any lists left in sync by an older version (<= 1.9.2) over to local and
// clear them out of sync — both to stop the quota error and to give back the
// sync space they were occupying. Idempotent, and it never clobbers a fresher
// local cache: a key already in local wins.
async function migrateWorkspaceCache() {
  try {
    const stale = await chrome.storage.sync.get(WORKSPACE_CACHE_KEYS)
    const present = Object.keys(stale)
    if (!present.length) return

    const local = await chrome.storage.local.get(WORKSPACE_CACHE_KEYS)
    const adopt = {}
    for (const key of present) {
      if (local[key] === undefined) adopt[key] = stale[key]
    }
    if (Object.keys(adopt).length) await chrome.storage.local.set(adopt)
    await chrome.storage.sync.remove(present)
  } catch (_e) {
    /* best effort — the lists refetch regardless */
  }
}

// The options page and the popup load this file with a <script> tag (globals);
// the service worker loads it with importScripts (also globals). The content
// scripts get their own copy of the split (they run in the page's isolated
// world, where these bindings aren't visible) — keep the two in step.
