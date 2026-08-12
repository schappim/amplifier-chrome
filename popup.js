// Popup: quick on/off toggle + account switcher + connection status + link to
// settings. The account list comes from the workspace (the API token is
// user-level); switching goes through the background worker (SWITCH_ACCOUNT),
// which restores that account's last-used picks and refreshes the pickers.

// Keep in sync with background.js.
const DEFAULT_BASE_URL = "https://amplifier.app"

const $ = (id) => document.getElementById(id)

function hostOf(url) {
  try {
    return new URL(url).host
  } catch (_e) {
    return url
  }
}

async function render() {
  const cfg = await chrome.storage.sync.get({enabled: true, baseUrl: DEFAULT_BASE_URL, token: "", team: "", accounts: [], accountId: ""})
  $("enabled").checked = cfg.enabled

  // The review bar flag lives in storage.local with the review session itself.
  const {reviewActive} = await chrome.storage.local.get({reviewActive: false})
  $("review").checked = Boolean(reviewActive)

  // Account switcher — only worth the space once there's something to switch.
  const row = $("accountRow")
  const select = $("account")
  if ((cfg.accounts || []).length > 1) {
    row.style.display = ""
    select.innerHTML = ""
    for (const a of cfg.accounts) {
      const opt = document.createElement("option")
      opt.value = String(a.id)
      opt.textContent = a.name
      if (String(a.id) === String(cfg.accountId)) opt.selected = true
      select.appendChild(opt)
    }
  } else {
    row.style.display = "none"
  }

  const active = (cfg.accounts || []).find((a) => String(a.id) === String(cfg.accountId))
  const configured = Boolean(cfg.baseUrl && cfg.token)
  const state = $("status")
  if (configured) {
    const name = active?.name || hostOf(cfg.baseUrl)
    state.innerHTML = `<span class="dot on"></span>Connected to <b>${name}</b>${cfg.team ? ` · team ${cfg.team}` : ""}`
  } else {
    state.innerHTML = `<span class="dot off"></span>Not configured — open Settings to connect.`
  }
}

$("enabled").addEventListener("change", () => {
  chrome.storage.sync.set({enabled: $("enabled").checked})
})

$("review").addEventListener("change", () => {
  chrome.storage.local.set({reviewActive: $("review").checked})
})

$("account").addEventListener("change", async () => {
  const state = $("status")
  state.innerHTML = `<span class="dot off"></span>Switching…`
  const res = await chrome.runtime.sendMessage({type: "SWITCH_ACCOUNT", payload: {id: $("account").value}})
  await render()
  if (res?.warning) {
    state.innerHTML = `<span class="dot off"></span>Switched, but the workspace didn't respond.`
  }
})

$("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage()
  window.close()
})

render()
