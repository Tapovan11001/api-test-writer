import { parseSpec, type Spec } from "../src/core/spec.ts";
import { planTests, renderTestFile, runTests, type Fetcher, type Result, type TestCase } from "../src/core/plan.ts";
import { SAMPLE_SPEC, demoApi } from "../src/core/sample.ts";
import { makeTestAgent } from "../src/agent.ts";
import { anthropicModel } from "../src/harness/models/anthropic.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KIND: Record<TestCase["kind"], string> = {
  happy: "happy path",
  "missing-field": "missing field",
  "wrong-type": "wrong type",
  "out-of-range": "out of range",
  "not-found": "not found",
  "no-auth": "no token",
  custom: "business rule",
};

let spec: Spec | null = null;
let cases: TestCase[] = [];
let results = new Map<string, Result>();

const isSample = () => spec?.title === "Tiffin Orders API" && $<HTMLInputElement>("base").value.trim() === "";

function fetcherFor(base: string, token: string): Fetcher {
  return async ({ method, path, body, headers }) => {
    const h = { ...headers };
    if (h.authorization) {
      if (token) h.authorization = `Bearer ${token}`;
      else delete h.authorization;
    }
    const res = await fetch(base.replace(/\/$/, "") + path, { method: method.toUpperCase(), headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, body: json };
  };
}

function load() {
  const err = $("spec-error");
  try {
    spec = parseSpec($<HTMLTextAreaElement>("spec").value);
    err.hidden = true;
  } catch (e) {
    spec = null;
    err.hidden = false;
    err.textContent = e instanceof Error ? e.message : String(e);
  }
  cases = spec ? planTests(spec) : [];
  results = new Map();
  $("claude-reply").hidden = true;
  $("claude-status").textContent = "";
  render();
}

function target() {
  const note = $("target-note");
  const run = $<HTMLButtonElement>("run");
  if (!spec) { run.disabled = true; note.textContent = ""; return; }
  if (isSample()) {
    note.textContent = "Leave the URL empty to run against a demo version of this API that lives in the page. It has two bugs planted in it.";
    run.disabled = false;
  } else if ($<HTMLInputElement>("base").value.trim()) {
    note.textContent = "Requests go straight from your browser, so the API has to allow CORS. For a local Next.js app, download the test file and run it with node instead.";
    run.disabled = false;
  } else {
    note.textContent = "Add your API's URL to run these here, or download the test file and run it next to your app.";
    run.disabled = true;
  }
}

function render() {
  target();
  if (!spec) {
    $("counts").textContent = "";
    $("ops").replaceChildren();
    $("summary").textContent = "";
    $("code").textContent = "";
    return;
  }
  const fromClaude = cases.filter((c) => c.source === "claude").length;
  $("counts").innerHTML = "";
  $("counts").append(
    stat(String(spec.operations.length), "endpoints"),
    stat(String(cases.length), "tests"),
    ...(fromClaude ? [stat(String(fromClaude), "from Claude")] : []),
  );
  if (results.size) {
    const failed = cases.filter((c) => results.get(c.id) && !results.get(c.id)!.pass);
    const s = $("summary");
    s.className = `summary ${failed.length ? "bad" : "good"}`;
    s.textContent = failed.length
      ? `${results.size - failed.length} passed, ${failed.length} failed. Failed tests are listed first under each endpoint.`
      : `All ${results.size} tests passed.`;
  } else {
    $("summary").className = "summary";
    $("summary").textContent = "Not run yet. Each test expects a status code the spec declares for that endpoint.";
  }

  $("ops").replaceChildren(
    ...spec.operations.map((op) => {
      const box = document.createElement("section");
      box.className = "op";
      const head = document.createElement("h3");
      const m = document.createElement("span");
      m.className = `m m-${op.method}`;
      m.textContent = op.method.toUpperCase();
      const p = document.createElement("code");
      p.textContent = op.path;
      const sum = document.createElement("span");
      sum.className = "op-sum";
      sum.textContent = op.summary;
      head.append(m, p, sum);
      const list = document.createElement("ul");
      const mine = cases.filter((c) => c.op === op.id);
      const rank = (c: TestCase) => (results.get(c.id) && !results.get(c.id)!.pass ? 0 : 1);
      mine.sort((a, b) => rank(a) - rank(b));
      list.append(
        ...mine.map((c) => {
          const r = results.get(c.id);
          const li = document.createElement("li");
          li.className = r ? (r.pass ? "pass" : "fail") : "";
          const mark = document.createElement("span");
          mark.className = "mark";
          mark.textContent = r ? (r.pass ? "✓" : "✗") : "·";
          mark.setAttribute("aria-label", r ? (r.pass ? "passed" : "failed") : "not run");
          const main = document.createElement("div");
          main.className = "t-main";
          const title = document.createElement("span");
          title.className = "t-title";
          title.textContent = c.title.replace(`${op.method.toUpperCase()} ${op.path} `, "");
          const meta = document.createElement("span");
          meta.className = "t-meta";
          const kind = document.createElement("span");
          kind.className = `chip${c.source === "claude" ? " claude" : ""}`;
          kind.textContent = c.source === "claude" ? "Claude" : KIND[c.kind];
          const why = document.createElement("span");
          why.textContent = c.why;
          meta.append(kind, why);
          main.append(title, meta);
          if (r && !r.pass) {
            const pr = document.createElement("span");
            pr.className = "t-problem";
            pr.textContent = r.problems.join(" ");
            main.append(pr);
          }
          const st = document.createElement("span");
          st.className = "expect";
          st.textContent = r && r.status !== null && r.status !== c.expectStatus ? `${c.expectStatus} → ${r.status}` : String(c.expectStatus);
          li.append(mark, main, st);
          return li;
        }),
      );
      box.append(head, list);
      return box;
    }),
  );
  $("code").textContent = renderTestFile(spec, cases);
}

function stat(n: string, label: string) {
  const d = document.createElement("span");
  d.className = "stat";
  const b = document.createElement("b");
  b.textContent = n;
  d.append(b, ` ${label}`);
  return d;
}

function tab(name: "tests" | "file" | "claude") {
  for (const t of ["tests", "file", "claude"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
}

async function run() {
  if (!spec) return;
  const btn = $<HTMLButtonElement>("run");
  btn.disabled = true;
  $("summary").textContent = "Running…";
  try {
    const base = $<HTMLInputElement>("base").value.trim();
    const f = isSample() ? demoApi() : fetcherFor(base, $<HTMLInputElement>("token").value.trim());
    const rs = await runTests(spec, cases, f);
    results = new Map(rs.map((r) => [r.id, r]));
    render();
    tab("tests");
  } finally {
    target();
  }
}

$("run").addEventListener("click", run);
$("tab-tests").addEventListener("click", () => tab("tests"));
$("tab-file").addEventListener("click", () => tab("file"));
$("tab-claude").addEventListener("click", () => tab("claude"));
$("base").addEventListener("input", target);

let t: ReturnType<typeof setTimeout> | undefined;
$("spec").addEventListener("input", () => {
  clearTimeout(t);
  t = setTimeout(load, 300);
});
$("load-sample").addEventListener("click", () => {
  $<HTMLTextAreaElement>("spec").value = SAMPLE_SPEC;
  $<HTMLInputElement>("base").value = "";
  load();
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("code").textContent ?? "");
    $("copy").textContent = "Copied";
  } catch {
    const r = document.createRange();
    r.selectNodeContents($("code"));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(r);
    $("copy").textContent = "Selected, press ⌘C";
  }
  setTimeout(() => ($("copy").textContent = "Copy"), 1800);
});
$("download").addEventListener("click", () => {
  const blob = new Blob([$("code").textContent ?? ""], { type: "text/javascript" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "api.test.mjs";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

try { const k = sessionStorage.getItem("atw-key"); if (k) $<HTMLInputElement>("api-key").value = k; } catch {}
$("ask").addEventListener("click", async () => {
  if (!spec) return;
  const key = $<HTMLInputElement>("api-key").value.trim();
  const st = $("claude-status");
  if (!key) { st.textContent = "Paste an Anthropic API key first."; return; }
  try { sessionStorage.setItem("atw-key", key); } catch {}
  const btn = $<HTMLButtonElement>("ask");
  btn.disabled = true;
  $("claude-reply").hidden = true;
  st.textContent = "Claude is reading the spec…";
  const base = $<HTMLInputElement>("base").value.trim();
  const runner = isSample() ? demoApi() : base ? fetcherFor(base, $<HTMLInputElement>("token").value.trim()) : undefined;
  try {
    const { agent, state, prompt } = makeTestAgent(anthropicModel({ apiKey: key, browser: true, maxTokens: 8000 }), spec, {
      run: runner,
      onEvent: (e) => {
        if (e.kind === "tool_call") st.textContent = { list_operations: "Listing endpoints…", get_operation: "Reading an endpoint closely…", add_tests: "Adding tests (each one is checked against the spec)…", run_tests: "Running the full suite…" }[e.name] ?? st.textContent;
      },
    });
    const r = await agent.run(prompt);
    cases = state.cases;
    if (state.results) results = new Map(state.results.map((x) => [x.id, x]));
    render();
    const added = cases.filter((c) => c.source === "claude").length;
    if (r.status === "done") {
      st.textContent = `Claude added ${added} test${added === 1 ? "" : "s"}. They're marked "Claude" in the Tests tab and in the test file.`;
      if (r.output) {
        $("claude-reply").hidden = false;
        $("claude-reply").textContent = r.output;
      }
    } else {
      const err = r.trace.find((e) => e.kind === "error");
      st.textContent = err && err.kind === "error"
        ? (/fetch|network|connection/i.test(err.message) ? "Couldn't reach the Claude API from this page. Open the hosted site if this preview blocks outside requests." : err.message)
        : `Stopped: ${r.status}.`;
    }
  } finally {
    btn.disabled = false;
  }
});

$<HTMLTextAreaElement>("spec").value = SAMPLE_SPEC;
load();
