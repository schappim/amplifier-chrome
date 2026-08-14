// What happens on the options page when "Connect & save" reaches something
// that isn't the workspace. Run with:
//
//   node extensions/chrome/test/options_connect_test.mjs
//
// The reported failure: a URL that answers 200 with an HTML page (a local dev
// server serving its index.html for every path, a tunnel interstitial, a
// sign-in wall) made res.json() throw `Unexpected token '<'`. The page said
// nothing at all — the error only existed in the console — so "Connect" looked
// like a dead button. This loads the real api.js + options.js against a stubbed
// DOM and asserts the page explains itself instead, and that a URL missing its
// scheme or carrying a page path still connects.
import fs from "fs"
import vm from "vm"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")

const failures = []
const assert = (condition, description) => {
  if (!condition) failures.push(description)
}

// A DOM with only the parts options.js touches.
function makeDocument() {
  const el = (extra) => ({
    value: "",
    checked: false,
    textContent: "",
    className: "",
    innerHTML: "",
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn
    },
    appendChild() {},
    ...extra
  })
  const elements = {
    enabled: el({checked: true}),
    baseUrl: el(),
    token: el(),
    team: el(),
    status: el(),
    save: el(),
    saveOnly: el()
  }
  return {
    elements,
    getElementById: (id) => elements[id],
    createElement: () => el()
  }
}

// Load api.js + options.js the way options.html does, over one fake workspace.
async function load({fetch, storage = {}}) {
  const document = makeDocument()
  const store = {...storage}
  const rejections = []
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    document,
    fetch,
    chrome: {
      storage: {
        sync: {
          get: async (defaults) => Object.fromEntries(Object.keys(defaults).map((k) => [k, store[k] ?? defaults[k]])),
          set: async (values) => Object.assign(store, values)
        }
      }
    }
  }
  vm.createContext(sandbox)
  process.on("unhandledRejection", (e) => rejections.push(e))
  for (const file of ["api.js", "options.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox)
  }
  await new Promise((resolve) => setImmediate(resolve)) // let restore() settle
  return {document, store, rejections}
}

const html = (url) => ({
  ok: true,
  status: 200,
  url,
  headers: {get: () => "text/html; charset=utf-8"},
  text: async () => "<!DOCTYPE html>\n<html><body>Vite dev server</body></html>"
})

const json = (url, status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: {get: () => "application/json; charset=utf-8"},
  text: async () => JSON.stringify(payload)
})

const workspace = {ok: true, account: "Ninja", account_id: 7, accounts: [{id: 7, name: "Ninja"}], user: "Marcus", teams: [{key: "STR", name: "Struth"}], projects: [], labels: [], mood_boards: []}

// 1. A web page where the API should be: say so, don't throw.
{
  const calls = []
  const {document, rejections} = await load({
    fetch: async (url) => {
      calls.push(url)
      return html(url)
    }
  })
  document.elements.baseUrl.value = "http://localhost:5173"
  document.elements.token.value = "tok"
  await document.elements.save.listeners.click()

  const status = document.elements.status
  assert(status.className.includes("err"), `an HTML response should report an error, got class ${JSON.stringify(status.className)}`)
  assert(/web page/i.test(status.textContent), `the error should name the problem, got ${JSON.stringify(status.textContent)}`)
  assert(/workspace url/i.test(status.textContent), `the error should point at the setting to fix, got ${JSON.stringify(status.textContent)}`)
  assert(rejections.length === 0, `nothing should reject unhandled, got ${rejections.map((e) => e.message).join("; ")}`)
  assert(calls.length === 1 && calls[0] === "http://localhost:5173/inspector/ping", `should have called the ping endpoint once, got ${JSON.stringify(calls)}`)
}

// 2. A host typed without a scheme resolves against the workspace, not against
//    the extension's own origin (where it silently 404s).
{
  const calls = []
  const {document, store} = await load({
    fetch: async (url) => {
      calls.push(url)
      return json(url, 200, workspace)
    }
  })
  document.elements.baseUrl.value = "amplifier.app "
  document.elements.token.value = "tok"
  await document.elements.save.listeners.click()

  assert(calls[0] === "https://amplifier.app/inspector/ping", `a bare host should get https, got ${JSON.stringify(calls[0])}`)
  assert(store.baseUrl === "https://amplifier.app", `the saved URL should be normalized, got ${JSON.stringify(store.baseUrl)}`)
  assert(document.elements.baseUrl.value === "https://amplifier.app", "the field should show what was saved")
  assert(/Connected to/.test(document.elements.status.textContent), `should report success, got ${JSON.stringify(document.elements.status.textContent)}`)
}

// 3. A URL copied out of the app carries a page path; fall back to the site
//    root and adopt it.
{
  const calls = []
  const {document, store} = await load({
    fetch: async (url) => {
      calls.push(url)
      if (url.startsWith("https://amplifier.app/issues")) return json(url, 404, {error: "Not found"})
      return json(url, 200, workspace)
    }
  })
  document.elements.baseUrl.value = "https://amplifier.app/issues/STR-42"
  document.elements.token.value = "tok"
  await document.elements.save.listeners.click()

  assert(calls[1] === "https://amplifier.app/inspector/ping", `should retry at the root, got ${JSON.stringify(calls)}`)
  assert(store.baseUrl === "https://amplifier.app", `should adopt the root, got ${JSON.stringify(store.baseUrl)}`)
  assert(store.token === "tok", "should save the token alongside it")
}

// 3b. …but only the workspace may claim the URL. A workspace mounted under a
//     path shares its host with whatever else lives at the root, and that
//     something else erroring is not an invitation to retarget the extension.
{
  const {document, store} = await load({
    fetch: async (url) => {
      if (url.startsWith("https://work.example.com/amplifier")) return html(url) // the app, briefly behind a 200 error page
      return json(url, 500, {error: "boom"}) // a different app at the root
    }
  })
  document.elements.baseUrl.value = "https://work.example.com/amplifier"
  document.elements.token.value = "tok"
  await document.elements.save.listeners.click()

  assert(
    document.elements.baseUrl.value === "https://work.example.com/amplifier",
    `the typed URL should survive a failed root probe, got ${JSON.stringify(document.elements.baseUrl.value)}`
  )
  assert(store.baseUrl === undefined, `nothing should be saved on a failed connect, got ${JSON.stringify(store.baseUrl)}`)
  assert(document.elements.status.className.includes("err"), "and it should report the failure")
}

// 4. A remembered account that's no longer the user's retries on the server's
//    default before blaming the token.
{
  const calls = []
  const {document, store} = await load({
    storage: {baseUrl: "https://amplifier.app", token: "tok", accountId: "99"},
    fetch: async (url) => {
      calls.push(url)
      if (url.includes("account_id=99")) return json(url, 401, {ok: false, error: "Unauthorized"})
      return json(url, 200, workspace)
    }
  })
  document.elements.baseUrl.value = "https://amplifier.app"
  document.elements.token.value = "tok"
  await document.elements.save.listeners.click()

  assert(calls.length === 2 && !calls[1].includes("account_id"), `should retry without the account, got ${JSON.stringify(calls)}`)
  assert(store.accountId === "7", `should adopt the server's default account, got ${JSON.stringify(store.accountId)}`)
}

// 5. A token the workspace rejects is the token's fault, and says so.
{
  const {document} = await load({
    fetch: async (url) => json(url, 401, {ok: false, error: "Unauthorized: provide a valid API token"})
  })
  document.elements.baseUrl.value = "https://amplifier.app"
  document.elements.token.value = "nope"
  await document.elements.save.listeners.click()

  const status = document.elements.status
  assert(status.className.includes("err"), "a rejected token should report an error")
  assert(/token/i.test(status.textContent), `the error should name the token, got ${JSON.stringify(status.textContent)}`)
}

if (failures.length) {
  console.error(`FAIL\n  - ${failures.join("\n  - ")}`)
  process.exit(1)
}
console.log("PASS — the options page explains a non-workspace URL instead of throwing")
