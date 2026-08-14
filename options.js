// Options page: configure the workspace URL and API token — ONE connection.
// The API token is user-level, so it reaches every workspace account the user
// belongs to; /inspector/ping reports that account list and the extension
// offers it as a picker in the popup and in the composer panels, not here.
// This is an extension page with host_permissions, so it can call the
// workspace's /inspector/ping directly to validate the token and load teams.
//
// URL handling and response parsing live in api.js (loaded first by
// options.html): the workspace URL is typed by hand here, so most of what
// answers a first "Connect" is something other than the workspace.

// Keep in sync with background.js — Amplifier's hosted workspace, prefilled so
// a fresh install only has to paste a token.
const DEFAULT_BASE_URL = "https://amplifier.app"

const DEFAULTS = {
  enabled: true,
  baseUrl: DEFAULT_BASE_URL,
  token: "",
  accountId: "",
  team: "",
  teams: [],
  projects: [],
  labels: [],
  moodBoards: []
}

const $ = (id) => document.getElementById(id)

function setStatus(text, kind = "") {
  const el = $("status")
  el.textContent = text
  el.className = "status" + (kind ? " " + kind : "")
}

function populateTeams(teams, selected) {
  const select = $("team")
  select.innerHTML = '<option value="">First team (default)</option>'
  for (const t of teams || []) {
    const opt = document.createElement("option")
    opt.value = t.key
    opt.textContent = `${t.key} — ${t.name}`
    if (t.key === selected) opt.selected = true
    select.appendChild(opt)
  }
}

async function restore() {
  const cfg = await chrome.storage.sync.get(DEFAULTS)
  $("enabled").checked = cfg.enabled
  $("baseUrl").value = cfg.baseUrl
  $("token").value = cfg.token
  populateTeams(cfg.teams, cfg.team)
}

function readForm() {
  return {
    enabled: $("enabled").checked,
    baseUrl: normalizeBaseUrl($("baseUrl").value),
    token: $("token").value.trim(),
    team: $("team").value
  }
}

async function saveOnly() {
  const form = readForm()
  if ($("baseUrl").value.trim() && !form.baseUrl) {
    setStatus("That workspace URL isn't a web address. It should look like https://amplifier.app.", "err")
    return
  }
  $("baseUrl").value = form.baseUrl
  await chrome.storage.sync.set(form)
  setStatus("Saved.", "ok")
}

function ping(baseUrl, token, accountId) {
  return requestJson(endpointFor(baseUrl, "/inspector/ping", accountId), {
    headers: {Authorization: `Bearer ${token}`, Accept: "application/json"}
  })
}

// Nothing that speaks the API answered: either we couldn't reach it at all, it
// replied with something that wasn't JSON, or there's no such route there.
const missedTheApi = (res) => Boolean(res.error) || res.status === 404

// The workspace, and only the workspace: a 401 or a 500 carrying JSON is some
// server talking, not proof that this is the one holding your issues.
const answeredAsWorkspace = (res) => !res.error && res.status >= 200 && res.status < 300 && res.data.ok

async function connectAndSave() {
  const form = readForm()
  if (!$("baseUrl").value.trim() || !form.token) {
    setStatus("Enter both a workspace URL and an API token.", "err")
    return
  }
  if (!form.baseUrl) {
    setStatus("That workspace URL isn't a web address. It should look like https://amplifier.app.", "err")
    return
  }
  // Show what we'll actually call — a pasted URL is often missing its scheme.
  $("baseUrl").value = form.baseUrl
  setStatus("Connecting…")

  // Reconnecting over an unchanged connection keeps the account you last
  // selected in the composer; a new URL or token starts from the server's
  // default account for that token.
  const stored = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  const sameConnection = stored.baseUrl === form.baseUrl && stored.token === form.token
  let accountParam = sameConnection && stored.accountId ? stored.accountId : ""

  let res = await ping(form.baseUrl, form.token, accountParam)
  if (res.status === 401 && accountParam) {
    // The remembered account may no longer be one of this user's — retry on
    // the server's default before blaming the token.
    accountParam = ""
    res = await ping(form.baseUrl, form.token, accountParam)
  }

  // Copying a URL out of the app ("…/issues/STR-42") is an easy mistake and an
  // easy fix: if there's no API under the path we were given, try the site root
  // and adopt it when the workspace is what answers there. Only a genuine
  // workspace reply may overwrite the URL — a workspace mounted under a path
  // often shares its host with something else entirely, and that something
  // else erroring is no reason to retarget the extension at it.
  const root = new URL(form.baseUrl).origin
  if (missedTheApi(res) && root !== form.baseUrl) {
    const rootRes = await ping(root, form.token, accountParam)
    if (answeredAsWorkspace(rootRes)) {
      form.baseUrl = root
      $("baseUrl").value = root
      res = rootRes
    }
  }

  if (res.error) {
    setStatus(res.error, "err")
    return
  }
  if (res.status === 401) {
    setStatus(res.data.error || "Token rejected (401). Check the token is correct and still valid.", "err")
    return
  }
  if (res.status < 200 || res.status >= 300) {
    setStatus(res.data.error || `Workspace responded with HTTP ${res.status}. Check the URL.`, "err")
    return
  }

  const data = res.data
  if (!data.ok) {
    setStatus(data.error || "Unexpected response from the workspace.", "err")
    return
  }

  populateTeams(data.teams, form.team)
  await chrome.storage.sync.set({
    ...form,
    team: $("team").value,
    accountId: data.account_id != null ? String(data.account_id) : "",
    accounts: data.accounts || [],
    teams: data.teams || [],
    projects: data.projects || [],
    labels: data.labels || [],
    moodBoards: data.mood_boards || []
  })
  const others = (data.accounts || []).length - 1
  setStatus(
    `Connected to “${data.account}” as ${data.user}. ${(data.teams || []).length} team(s), ${(data.projects || []).length} project(s), ${(data.labels || []).length} label(s), ${(data.mood_boards || []).length} mood board(s) loaded.` +
      (others > 0 ? ` ${others} other account(s) available from the composer's Account picker.` : ""),
    "ok"
  )
}

// A rejected handler is invisible on this page — it lands in the console as an
// uncaught promise and the status line stays blank, which reads as "the button
// does nothing". Every entry point reports instead.
const run = (fn) => fn().catch((e) => setStatus(`Something went wrong: ${e.message}`, "err"))

$("save").addEventListener("click", () => run(connectAndSave))
$("saveOnly").addEventListener("click", () => run(saveOnly))
$("enabled").addEventListener("change", () => run(async () => chrome.storage.sync.set({enabled: $("enabled").checked})))

run(restore)
