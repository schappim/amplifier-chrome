// Round-trip check for the background worker's CREATE_ISSUE handler, run with:
//
//   node extensions/chrome/test/create_issue_prompt_test.mjs
//
// The worker builds its request body from an explicit field list, so a payload
// field the composer sends is silently dropped if it isn't named there — which
// is exactly how "file an issue, get the prompt on your clipboard" shipped once
// with the ask missing and nothing to copy. This loads the real background.js
// against stubbed chrome APIs and a fake workspace, and asserts both directions:
// asking carries include_prompt out and brings prompt back; not asking does
// neither.
import fs from "fs"
import vm from "vm"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")

let lastRequest = null
const store = {baseUrl: "https://amplifier.app", token: "tok", team: "STR", accountId: "7", lastUsed: {}}
const listeners = []

const sandbox = {
  console,
  fetch: async (url, init) => {
    lastRequest = {url, body: JSON.parse(init.body)}
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        identifier: "STR-1465",
        url: "https://amplifier.app/issues/STR-1465",
        // Mirror the server: the prompt is only rendered when asked for.
        ...(lastRequest.body.include_prompt ? {prompt: "Work on issue STR-1465…"} : {})
      })
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
        get: async (defaults) => Object.fromEntries(Object.keys(defaults).map((k) => [k, store[k] ?? defaults[k]])),
        set: async (values) => Object.assign(store, values),
        remove: async () => {}
      },
      local: {get: async (defaults) => defaults, set: async () => {}},
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

// The composer's payload: it always asks for the prompt, to put on the clipboard.
const asked = await send({
  type: "CREATE_ISSUE",
  payload: {title: "Card is misaligned", team: "STR", includePrompt: true, captures: [{body: "**Element:** …", url: "https://x.test/"}]}
})
assert(lastRequest.body.include_prompt === true, "asking should send include_prompt:true")
assert(asked.prompt === "Work on issue STR-1465…", `asking should return the prompt, got ${JSON.stringify(asked.prompt)}`)

// Older callers (and the curl shape) don't, and must not be handed one.
const plain = await send({type: "CREATE_ISSUE", payload: {title: "No prompt", team: "STR"}})
assert(lastRequest.body.include_prompt === false, "not asking should send include_prompt:false")
assert(plain.prompt === null, `not asking should return no prompt, got ${JSON.stringify(plain.prompt)}`)

if (failures.length) {
  console.error(`FAIL\n  - ${failures.join("\n  - ")}`)
  process.exit(1)
}
console.log("PASS — CREATE_ISSUE carries include_prompt out and the prompt back")
