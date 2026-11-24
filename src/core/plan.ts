// Turning operations into test cases, running them, and writing them out as a test file.
import { validate } from "../harness/schema.ts";
import type { JsonSchema } from "../harness/types.ts";
import { fillPath, matchPath, sample, successStatus, type Method, type Operation, type Schema, type Spec } from "./spec.ts";

export type Kind = "happy" | "missing-field" | "wrong-type" | "out-of-range" | "not-found" | "no-auth" | "custom";

export interface TestCase {
  id: string;
  op: string; // operation id
  kind: Kind;
  title: string;
  method: Method;
  path: string; // concrete, may include ?query
  body?: unknown;
  auth: boolean; // send the bearer token?
  expectStatus: number;
  why: string;
  source: "rules" | "claude";
}

export interface Request {
  method: Method;
  path: string;
  body?: unknown;
  headers: Record<string, string>;
}
export interface Response {
  status: number;
  body: unknown;
}
export type Fetcher = (req: Request) => Promise<Response>;

export interface Result {
  id: string;
  pass: boolean;
  status: number | null;
  problems: string[];
}

const errorStatus = (op: Operation) => [400, 422].find((c) => String(c) in op.responses);

function pathValues(op: Operation): Record<string, unknown> {
  return Object.fromEntries(op.params.filter((p) => p.in === "path").map((p) => [p.name, p.example ?? sample(p.schema, p.name)]));
}

function withQuery(op: Operation, path: string): string {
  const q = op.params.filter((p) => p.in === "query" && p.required);
  if (!q.length) return path;
  return path + "?" + q.map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(String(p.example ?? sample(p.schema, p.name)))}`).join("&");
}

/**
 * The tests any API should pass, worked out from the spec alone:
 * a happy path, missing required fields, wrong types, values out of range,
 * an unknown id, and a call without a token. Only statuses the spec declares are expected.
 */
export function planTests(spec: Spec): TestCase[] {
  const out: TestCase[] = [];
  for (const op of spec.operations) {
    const n = () => `${op.id}-${out.filter((t) => t.op === op.id).length + 1}`;
    const path = withQuery(op, fillPath(op.path, pathValues(op)));
    const body = op.body ? sample(op.body) : undefined;
    const base = { op: op.id, method: op.method, auth: op.secured, source: "rules" as const };
    const label = `${op.method.toUpperCase()} ${op.path}`;

    out.push({ ...base, id: n(), kind: "happy", title: `${label} works with valid input`, path, body, expectStatus: successStatus(op), why: "A valid request should get the success status from the spec, with a body that matches its schema." });

    const bad = errorStatus(op);
    const props = op.body?.properties ?? {};
    if (bad && op.body?.type === "object" && body && typeof body === "object") {
      for (const field of (op.body.required ?? []).slice(0, 3)) {
        const b = { ...(body as Record<string, unknown>) };
        delete b[field];
        out.push({ ...base, id: n(), kind: "missing-field", title: `${label} rejects a missing "${field}"`, path, body: b, expectStatus: bad, why: `"${field}" is required in the spec.` });
      }
      const numeric = Object.entries(props).find(([, s]) => s.type === "integer" || s.type === "number");
      if (numeric) {
        out.push({ ...base, id: n(), kind: "wrong-type", title: `${label} rejects text in "${numeric[0]}"`, path, body: { ...(body as object), [numeric[0]]: "abc" }, expectStatus: bad, why: `"${numeric[0]}" is a ${numeric[1].type} in the spec.` });
      }
      for (const [k, s] of Object.entries(props)) {
        if (s.minimum !== undefined) {
          out.push({ ...base, id: n(), kind: "out-of-range", title: `${label} rejects "${k}" below ${s.minimum}`, path, body: { ...(body as object), [k]: s.minimum - 1 }, expectStatus: bad, why: `The spec sets minimum ${s.minimum} for "${k}".` });
        }
        if (s.maximum !== undefined) {
          out.push({ ...base, id: n(), kind: "out-of-range", title: `${label} rejects "${k}" above ${s.maximum}`, path, body: { ...(body as object), [k]: s.maximum + 1 }, expectStatus: bad, why: `The spec sets maximum ${s.maximum} for "${k}".` });
        }
        if (s.enum?.length && s.type === "string") {
          out.push({ ...base, id: n(), kind: "out-of-range", title: `${label} rejects an unknown "${k}"`, path, body: { ...(body as object), [k]: "not-a-real-value" }, expectStatus: bad, why: `"${k}" must be one of ${s.enum.join(", ")}.` });
        }
      }
    }

    if ("404" in op.responses && op.params.some((p) => p.in === "path")) {
      const missing = Object.fromEntries(Object.keys(pathValues(op)).map((k) => [k, "does-not-exist-999"]));
      out.push({ ...base, id: n(), kind: "not-found", title: `${label} returns 404 for an unknown id`, path: withQuery(op, fillPath(op.path, missing)), body, expectStatus: 404, why: "The spec declares a 404 for this operation." });
    }

    if (op.secured && "401" in op.responses) {
      out.push({ ...base, id: n(), kind: "no-auth", title: `${label} needs a token`, path, body, auth: false, expectStatus: 401, why: "The operation is secured, and the spec declares a 401." });
    }
  }
  return out;
}

/**
 * Checks a test case someone else wrote (Claude, through a tool) against the spec.
 * Returns problems, empty if the case is fine.
 */
export function checkCase(spec: Spec, t: Partial<TestCase>, existing: TestCase[]): string[] {
  const p: string[] = [];
  const op = spec.operations.find((o) => o.id === t.op);
  if (!op) return [`No operation "${t.op}". Use an id from list_operations.`];
  if (!t.path || !matchPath(op.path, t.path)) p.push(`Path "${t.path}" doesn't match ${op.path}.`);
  if (typeof t.expectStatus !== "number" || !(String(t.expectStatus) in op.responses)) {
    p.push(`Status ${t.expectStatus} isn't in the spec for ${op.id}. Declared: ${Object.keys(op.responses).join(", ")}.`);
  }
  if (op.body && t.expectStatus !== undefined && t.expectStatus >= 200 && t.expectStatus < 300 && t.body !== undefined) {
    const v = validate(t.body, op.body as JsonSchema, "body");
    if (v.length) p.push(`This expects success but the body breaks the spec: ${v.join("; ")}.`);
  }
  if (!t.title?.trim()) p.push("Give the test a short title.");
  const same = existing.find((e) => e.op === t.op && e.path === t.path && e.expectStatus === t.expectStatus && JSON.stringify(e.body) === JSON.stringify(t.body) && e.auth === (t.auth ?? op.secured));
  if (same) p.push(`Same as existing test "${same.title}".`);
  return p;
}

/** Runs each case and checks the status and, for declared bodies, the response shape. */
export async function runTests(spec: Spec, cases: TestCase[], fetcher: Fetcher, token = "test-token"): Promise<Result[]> {
  const results: Result[] = [];
  for (const t of cases) {
    const op = spec.operations.find((o) => o.id === t.op)!;
    const headers: Record<string, string> = { accept: "application/json" };
    if (t.body !== undefined) headers["content-type"] = "application/json";
    if (t.auth) headers.authorization = `Bearer ${token}`;
    try {
      const r = await fetcher({ method: t.method, path: t.path, body: t.body, headers });
      const problems: string[] = [];
      if (r.status !== t.expectStatus) problems.push(`Expected ${t.expectStatus}, got ${r.status}.`);
      const schema = op.responses[String(r.status)];
      if (r.status === t.expectStatus && schema) problems.push(...validate(r.body, schema as JsonSchema, "response").map((x) => `${x}.`));
      results.push({ id: t.id, pass: problems.length === 0, status: r.status, problems });
    } catch (e) {
      results.push({ id: t.id, pass: false, status: null, problems: [`Request failed: ${e instanceof Error ? e.message : e}`] });
    }
  }
  return results;
}

const requiredKeys = (s: Schema | null | undefined) => (s?.type === "object" ? s.required ?? [] : []);

/** A node:test file a developer can drop into their repo and run with BASE_URL set. */
export function renderTestFile(spec: Spec, cases: TestCase[]): string {
  const lines = [
    `// API tests for ${spec.title}, generated from its OpenAPI spec by API Test Writer.`,
    `// Run: BASE_URL=http://localhost:3000 API_TOKEN=... node --test api.test.mjs`,
    `import { test } from "node:test";`,
    `import assert from "node:assert/strict";`,
    ``,
    `const BASE = process.env.BASE_URL ?? "http://localhost:3000";`,
    `const TOKEN = process.env.API_TOKEN ?? "";`,
    ``,
    `async function call(method, path, { body, auth = true } = {}) {`,
    `  const headers = { accept: "application/json" };`,
    `  if (body !== undefined) headers["content-type"] = "application/json";`,
    `  if (auth && TOKEN) headers.authorization = \`Bearer \${TOKEN}\`;`,
    `  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });`,
    `  const text = await res.text();`,
    `  let json = null;`,
    `  try { json = text ? JSON.parse(text) : null; } catch {}`,
    `  return { status: res.status, body: json };`,
    `}`,
  ];
  for (const t of cases) {
    const op = spec.operations.find((o) => o.id === t.op)!;
    const opts: string[] = [];
    if (t.body !== undefined) opts.push(`body: ${JSON.stringify(t.body)}`);
    if (!t.auth && op.secured) opts.push("auth: false");
    const keys = requiredKeys(op.responses[String(t.expectStatus)]);
    lines.push(
      ``,
      `// ${t.why}${t.source === "claude" ? " (suggested by Claude)" : ""}`,
      `test(${JSON.stringify(t.title)}, async () => {`,
      `  const r = await call(${JSON.stringify(t.method.toUpperCase())}, ${JSON.stringify(t.path)}${opts.length ? `, { ${opts.join(", ")} }` : ""});`,
      `  assert.equal(r.status, ${t.expectStatus});`,
      ...(keys.length ? [`  for (const k of ${JSON.stringify(keys)}) assert.ok(r.body && k in r.body, \`missing "\${k}" in response\`);`] : []),
      `});`,
    );
  }
  return lines.join("\n") + "\n";
}
