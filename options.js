// Options page: configure the workspace URL and API token — ONE connection.
// The API token is user-level, so it reaches every workspace account the user
// belongs to; /inspector/ping reports that account list and the extension
// offers it as a picker in the popup and in the composer panels, not here.
// This is an extension page with host_permissions, so it can call the
// workspace's /inspector/ping directly to validate the token and load teams.

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
    baseUrl: $("baseUrl").value.trim().replace(/\/+$/, ""),
    token: $("token").value.trim(),
    team: $("team").value
  }
}

async function saveOnly() {
  const form = readForm()
  await chrome.storage.sync.set(form)
  setStatus("Saved.", "ok")
}

async function connectAndSave() {
  const form = readForm()
  if (!form.baseUrl || !form.token) {
    setStatus("Enter both a workspace URL and an API token.", "err")
    return
  }
  setStatus("Connecting…")

  // Reconnecting over an unchanged connection keeps the account you last
  // selected in the composer; a new URL or token starts from the server's
  // default account for that token.
  const stored = await chrome.storage.sync.get({baseUrl: DEFAULT_BASE_URL, token: "", accountId: ""})
  const sameConnection = stored.baseUrl === form.baseUrl && stored.token === form.token
  let accountParam = sameConnection && stored.accountId ? stored.accountId : ""

  let data
  for (;;) {
    let res
    try {
      const query = accountParam ? `?account_id=${encodeURIComponent(accountParam)}` : ""
      res = await fetch(form.baseUrl + "/inspector/ping" + query, {
        headers: {Authorization: `Bearer ${form.token}`, Accept: "application/json"}
      })
    } catch (e) {
      setStatus(`Could not reach ${form.baseUrl}: ${e.message}`, "err")
      return
    }
    if (res.status === 401 && accountParam) {
      // The remembered account may no longer be one of this user's — retry on
      // the server's default before blaming the token.
      accountParam = ""
      continue
    }
    if (res.status === 401) {
      setStatus("Token rejected (401). Check the token is correct and still valid.", "err")
      return
    }
    if (!res.ok) {
      setStatus(`Workspace responded with HTTP ${res.status}. Check the URL.`, "err")
      return
    }
    data = await res.json()
    break
  }

  if (!data?.ok) {
    setStatus("Unexpected response from the workspace.", "err")
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

$("save").addEventListener("click", connectAndSave)
$("saveOnly").addEventListener("click", saveOnly)
$("enabled").addEventListener("change", () => chrome.storage.sync.set({enabled: $("enabled").checked}))

restore()
