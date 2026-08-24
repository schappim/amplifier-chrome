// The URL and response rules in api.js, on their own. Run with:
//
//   node test/api_test.mjs
import fs from "fs"
import vm from "vm"
import path from "path"

const root = path.resolve(import.meta.dirname, "..")
const sandbox = {console, URL, URLSearchParams, fetch: async () => ({ok: true, status: 200, url: "", headers: {get: () => null}, text: async () => "{}"})}
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(root, "api.js"), "utf8"), sandbox)
const {normalizeBaseUrl, endpointFor, requestJson, apiCall} = sandbox

const failures = []
const is = (actual, expected, description) => {
  if (actual !== expected) failures.push(`${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// What people paste into a free-text "Workspace URL" field.
is(normalizeBaseUrl("https://amplifier.app"), "https://amplifier.app", "an already-good URL is left alone")
is(normalizeBaseUrl("  https://amplifier.app/  "), "https://amplifier.app", "whitespace and trailing slashes go")
is(normalizeBaseUrl("amplifier.app"), "https://amplifier.app", "a bare host gets https")
is(normalizeBaseUrl("localhost:5001"), "http://localhost:5001", "localhost gets http — https would just fail the handshake")
is(normalizeBaseUrl("127.0.0.1:3000/"), "http://127.0.0.1:3000", "so does a loopback address")
is(normalizeBaseUrl("https://amplifier.app/inspector/ping"), "https://amplifier.app", "the whole endpoint pasted back is still the base URL")
is(normalizeBaseUrl("https://work.example.com/amplifier"), "https://work.example.com/amplifier", "an app mounted under a path keeps it")
is(normalizeBaseUrl(""), "", "nothing in, nothing out")
is(normalizeBaseUrl("   "), "", "whitespace is nothing")
is(normalizeBaseUrl("javascript:alert(1)"), "", "only http(s) survives")
is(normalizeBaseUrl("chrome-extension://abc/options.html"), "", "and nothing else does")

is(endpointFor("amplifier.app/", "/inspector/ping"), "https://amplifier.app/inspector/ping", "endpoints normalize their base")
is(endpointFor("https://amplifier.app", "/inspector/ping", "7"), "https://amplifier.app/inspector/ping?account_id=7", "a selected account rides along")
is(
  endpointFor("https://amplifier.app", "/inspector/components", "7", {project: "a b"}),
  "https://amplifier.app/inspector/components?project=a+b&account_id=7",
  "query params are escaped, not concatenated"
)

// The response that started all this: 200 OK, and an HTML page in the body.
const page = {
  ok: true,
  status: 200,
  url: "http://localhost:5173/inspector/ping",
  headers: {get: () => "text/html; charset=utf-8"},
  text: async () => "<!DOCTYPE html><html><body>dev server</body></html>"
}
sandbox.fetch = async () => page
const parsed = await requestJson("http://localhost:5173/inspector/ping")
is(parsed.status, 200, "the status still comes back")
is(typeof parsed.error, "string", "a page instead of JSON is an error, not a thrown SyntaxError")
if (!/web page/i.test(parsed.error || "")) failures.push(`the error should name the problem, got ${JSON.stringify(parsed.error)}`)
const called = await apiCall("http://localhost:5173/inspector/ping")
is(called.ok, false, "apiCall reports it as a failure")

// An error the API itself reports keeps the server's wording.
sandbox.fetch = async () => ({
  ok: false,
  status: 401,
  url: "https://amplifier.app/inspector/ping",
  headers: {get: () => "application/json"},
  text: async () => JSON.stringify({ok: false, error: "Unauthorized: provide a valid API token"})
})
const rejected = await apiCall("https://amplifier.app/inspector/ping")
is(rejected.ok, false, "a 401 is a failure")
is(rejected.error, "Unauthorized: provide a valid API token", "and the server's own message is what's shown")

// A host that isn't there at all.
sandbox.fetch = async () => {
  throw new TypeError("Failed to fetch")
}
const unreachable = await requestJson("https://nope.invalid/inspector/ping")
is(unreachable.status, 0, "an unreachable host has no status")
if (!/Could not reach/.test(unreachable.error || "")) failures.push(`unreachable should say so, got ${JSON.stringify(unreachable.error)}`)

if (failures.length) {
  console.error(`FAIL\n  - ${failures.join("\n  - ")}`)
  process.exit(1)
}
console.log("PASS — api.js normalizes what's typed and explains what answers")
