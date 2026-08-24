// Switching accounts must not write the workspace's lists into chrome.storage
// .sync. Run with:
//
//   node test/workspace_cache_test.mjs
//
// The reported failure: switching workspaces in the composer or the popup put
// two lines in the console —
//
//   Uncaught (in promise) Error: Resource::kQuotaBytesPerItem quota exceeded
//
// — and left the pickers empty. chrome.storage.sync caps EACH item at 8KB, and
// switchAccount was caching the account's projects, labels, mood boards and
// account list there; any workspace with real content is past 8KB of JSON. The
// set() rejected after the new accountId had already landed, so the extension
// was pointed at the new account with none of its lists, and nothing said so.
//
// This loads the real background.js against a sync stub that enforces the same
// quota Chrome does, and asserts a switch over a big workspace both succeeds
// and leaves the lists in local — plus that lists cached into sync by an older
// version get moved out.
import fs from "fs"
import vm from "vm"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")

const QUOTA_BYTES_PER_ITEM = 8192

// A workspace big enough to matter: 120 projects and 80 labels is a normal
// year's worth, and well past what sync will hold in one item.
const workspace = {
  ok: true,
  account: "Ninja",
  account_id: 7,
  user: "Marcus",
  accounts: [{id: 7, name: "Ninja"}, {id: 9, name: "Little Bird"}],
  teams: [{key: "STR", name: "Struth"}, {key: "HOM", name: "Home"}],
  projects: Array.from({length: 120}, (_, i) => ({
    id: i + 1,
    name: `Project ${i + 1} — a name of the length people actually use`,
    team: i % 2 ? "STR" : "HOM",
    icon: "🌱"
  })),
  labels: Array.from({length: 80}, (_, i) => ({id: i + 1, name: `label-${i + 1}`, team: "STR", color: "#5e6ad2"})),
  mood_boards: Array.from({length: 40}, (_, i) => ({id: i + 1, name: `Board ${i + 1}`}))
}

const failures = []
const assert = (condition, description) => {
  if (!condition) failures.push(description)
}

// chrome.storage.get takes either a defaults object or a list of keys.
const read = (area, defaults) =>
  Array.isArray(defaults)
    ? Object.fromEntries(defaults.filter((k) => k in area).map((k) => [k, area[k]]))
    : Object.fromEntries(Object.keys(defaults).map((k) => [k, area[k] ?? defaults[k]]))

// Load background.js over one fake workspace and one pair of storage areas.
function load({sync = {}, local = {}} = {}) {
  const store = {...sync}
  const cache = {...local}
  const listeners = []
  const rejections = []
  const installed = []
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    importScripts: (file) => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox),
    fetch: async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: {get: (name) => (name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null)},
      text: async () => JSON.stringify(workspace)
    }),
    chrome: {
      runtime: {
        id: "test",
        getURL: (p) => `chrome-extension://test/${p}`,
        onMessage: {addListener: (fn) => listeners.push(fn)},
        onInstalled: {addListener: (fn) => installed.push(fn)},
        onStartup: {addListener() {}},
        openOptionsPage() {}
      },
      storage: {
        sync: {
          get: async (defaults) => read(store, defaults),
          // Chrome's real per-item cap: the whole set() rejects, and the
          // message is the one the user saw.
          set: async (values) => {
            for (const [key, value] of Object.entries(values)) {
              if (JSON.stringify(value).length > QUOTA_BYTES_PER_ITEM) {
                throw new Error("Resource::kQuotaBytesPerItem quota exceeded")
              }
              store[key] = value
            }
          },
          remove: async (keys) => {
            for (const key of [].concat(keys)) delete store[key]
          }
        },
        local: {
          get: async (defaults) => read(cache, defaults),
          set: async (values) => Object.assign(cache, values)
        },
        onChanged: {addListener() {}}
      },
      action: {setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}},
      commands: {onCommand: {addListener() {}}},
      tabs: {query: async () => [], sendMessage: async () => {}}
    }
  }
  vm.createContext(sandbox)
  process.on("unhandledRejection", (e) => rejections.push(e))
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), sandbox)
  const send = (message) => new Promise((resolve) => listeners[0](message, {}, resolve))
  return {store, cache, send, rejections, installed}
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

// 1. Switching into a big workspace succeeds, and the lists land in local.
{
  const {store, cache, send, rejections} = load({
    sync: {baseUrl: "https://amplifier.app", token: "tok", accountId: "7", lastUsed: {}}
  })
  const res = await send({type: "SWITCH_ACCOUNT", payload: {id: 9}})
  await settle()

  assert(res.ok, `the switch should succeed, got ${JSON.stringify(res)}`)
  assert(!res.warning, `and report no warning, got ${JSON.stringify(res.warning)}`)
  assert(rejections.length === 0, `nothing should reject unhandled, got ${rejections.map((e) => e.message).join("; ")}`)
  assert(store.accountId === "7", `the selected account should be the ping's, got ${JSON.stringify(store.accountId)}`)
  assert(cache.projects.length === 120, `the projects should be cached in local, got ${cache.projects?.length}`)
  assert(cache.labels.length === 80, `the labels should be cached in local, got ${cache.labels?.length}`)
  assert(cache.moodBoards.length === 40, `the mood boards should be cached in local, got ${cache.moodBoards?.length}`)
  assert(cache.accounts.length === 2, `the account list should be cached in local, got ${cache.accounts?.length}`)
  for (const key of ["accounts", "teams", "projects", "labels", "moodBoards"]) {
    assert(!(key in store), `${key} must not be written to sync — that is what breaches the 8KB per-item quota`)
  }
}

// 2. The picker refreshes cache into local too.
{
  const {store, cache, send} = load({sync: {baseUrl: "https://amplifier.app", token: "tok", accountId: "7"}})
  const res = await send({type: "LIST_PROJECTS"})
  await settle()

  assert(res.ok && res.projects.length === 120, `LIST_PROJECTS should return the list, got ${JSON.stringify(res).slice(0, 120)}`)
  assert(cache.projects.length === 120, "and cache it in local")
  assert(!("projects" in store), "never in sync")
}

// 3. Lists an older version left in sync get moved to local on update, and the
//    sync copies removed — a fresher local cache wins.
{
  const {store, cache, installed} = load({
    sync: {
      baseUrl: "https://amplifier.app",
      token: "tok",
      accountId: "7",
      teams: [{key: "OLD", name: "Stale"}],
      projects: [{id: 1, name: "From sync", team: "OLD"}],
      labels: [{id: 1, name: "stale"}]
    },
    // An account list already in local means the install hook has nothing to
    // re-ping for, so what's left is purely what the migration did.
    local: {accounts: [{id: 7, name: "Ninja"}], projects: [{id: 2, name: "Already local", team: "STR"}]}
  })
  await installed[0]()
  await settle()

  for (const key of ["teams", "projects", "labels"]) {
    assert(!(key in store), `${key} should be cleared out of sync, got ${JSON.stringify(store[key])?.slice(0, 80)}`)
  }
  assert(cache.teams?.[0]?.key === "OLD", `the stale team list should move to local, got ${JSON.stringify(cache.teams)?.slice(0, 80)}`)
  assert(
    cache.projects?.length === 1 && cache.projects[0].name === "Already local",
    `a local cache already present should win, got ${JSON.stringify(cache.projects)?.slice(0, 80)}`
  )
}

if (failures.length) {
  console.error("FAIL")
  for (const f of failures) console.error("  ✗ " + f)
  process.exit(1)
}
console.log("PASS — the workspace lists are cached in local, clear of sync's 8KB per-item quota")
