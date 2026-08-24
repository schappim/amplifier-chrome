// The team an issue is filed into must follow the project it is filed under.
// Run with:
//
//   node test/team_follows_project_test.mjs
//
// A project belongs to exactly one team, but the composer's Team and Project
// pickers used to move independently: choosing "STR · Getting Started" while
// the untouched team picker sent nothing filed the issue into HOM, the
// workspace's first team, with an STR project hanging off it. The server takes
// the team it is given, so the worker is the last place to catch the mismatch.
// This loads the real background.js against stubbed chrome APIs and a fake
// workspace, and asserts the project wins — while a projectless issue still
// files into the team the caller asked for.
import fs from "fs"
import vm from "vm"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")

let lastRequest = null
// The settings (chrome.storage.sync)…
const store = {
  baseUrl: "https://amplifier.app",
  token: "tok",
  team: "HOM", // the stored default — the wrong answer once a project is picked
  accountId: "7",
  lastUsed: {}
}
// …and the picker cache the worker consults (chrome.storage.local), in the
// ping's shape. The lists live here because sync caps each item at 8KB.
const cache = {
  projects: [
    {id: 154, name: "Getting Started [Desktop]", team: "STR", icon: null},
    {id: 12, name: "Groceries", team: "HOM", icon: null}
  ]
}
const listeners = []

// chrome.storage.get takes either a defaults object or a list of keys.
const readFrom = (area, defaults) =>
  Array.isArray(defaults)
    ? Object.fromEntries(defaults.filter((k) => k in area).map((k) => [k, area[k]]))
    : Object.fromEntries(Object.keys(defaults).map((k) => [k, area[k] ?? defaults[k]]))

const sandbox = {
  console,
  URL,
  URLSearchParams,
  importScripts: (file) => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox),
  fetch: async (url, init) => {
    lastRequest = {url, body: JSON.parse(init.body)}
    return {
      ok: true,
      status: 200,
      url,
      headers: {get: (name) => (name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null)},
      text: async () => JSON.stringify({ok: true, identifier: "STR-2162", url: "https://amplifier.app/issues/STR-2162"})
    }
  },
  chrome: {
    runtime: {
      id: "test",
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: {addListener: (fn) => listeners.push(fn)},
      onInstalled: {addListener() {}},
      onStartup: {addListener() {}},
      openOptionsPage() {}
    },
    storage: {
      sync: {
        get: async (defaults) => readFrom(store, defaults),
        set: async (values) => Object.assign(store, values),
        remove: async () => {}
      },
      local: {
        get: async (defaults) => readFrom(cache, defaults),
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
vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), sandbox)

const send = (message) => new Promise((resolve) => listeners[0](message, {}, resolve))

const failures = []
const assert = (condition, description) => {
  if (!condition) failures.push(description)
}

const capture = [{body: "**Element:** …", url: "https://x.test/"}]

// The exact shape that filed an STR issue into HOM: an STR project, and a team
// that is either stale or absent.
await send({
  type: "CREATE_ISSUE",
  payload: {title: "Populate the getting started video", team: "HOM", project: "154", captures: capture}
})
assert(lastRequest.body.team === "STR", `an STR project must file into STR, got ${JSON.stringify(lastRequest.body.team)}`)
assert(lastRequest.body.project === "154", "the project must still be sent")
assert(store.team === "STR", `the remembered team must follow the project, got ${JSON.stringify(store.team)}`)

// An unsent team is the commonest case — the picker the user never touched.
store.team = "HOM"
await send({type: "CREATE_ISSUE", payload: {title: "No team named", project: 154, captures: capture}})
assert(lastRequest.body.team === "STR", `a numeric project id must resolve too, got ${JSON.stringify(lastRequest.body.team)}`)

// With no project there is nothing to derive from, so the caller's team stands.
store.team = "HOM"
await send({type: "CREATE_ISSUE", payload: {title: "Projectless", team: "STR", captures: capture}})
assert(lastRequest.body.team === "STR", `an explicit team must survive, got ${JSON.stringify(lastRequest.body.team)}`)
assert(lastRequest.body.project === null, "no project means none is sent")

// And a project in the stored team is not disturbed.
store.team = "HOM"
await send({type: "CREATE_ISSUE", payload: {title: "Home errand", project: "12", captures: capture}})
assert(lastRequest.body.team === "HOM", `a HOM project must file into HOM, got ${JSON.stringify(lastRequest.body.team)}`)

// An unknown project id can't name a team; fall back rather than blanking it.
store.team = "HOM"
await send({type: "CREATE_ISSUE", payload: {title: "Stale project", team: "STR", project: "9999", captures: capture}})
assert(lastRequest.body.team === "STR", `an unknown project must leave the team alone, got ${JSON.stringify(lastRequest.body.team)}`)

// The review bar files through the same door and gets the same guard.
store.team = "HOM"
await send({type: "SEND_REVIEW", payload: {title: "Review", project: "154", items: [{body: "…"}]}})
assert(lastRequest.body.team === "STR", `reviews must follow the project too, got ${JSON.stringify(lastRequest.body.team)}`)

if (failures.length) {
  console.error(`FAIL\n  - ${failures.join("\n  - ")}`)
  process.exit(1)
}
console.log("PASS — the filed team follows the project it is filed under")
