import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPath, parseSpec, sample } from "../src/core/spec.ts";
import { checkCase, planTests, renderTestFile, runTests } from "../src/core/plan.ts";
import { SAMPLE_SPEC, demoApi } from "../src/core/sample.ts";
import { makeTestAgent } from "../src/agent.ts";
import { scriptedModel, lastToolResults } from "../src/harness/index.ts";

const spec = parseSpec(SAMPLE_SPEC);

test("reads the YAML spec, resolving $refs and allOf", () => {
  assert.deepEqual(spec.operations.map((o) => o.id), ["listOrders", "createOrder", "getOrder", "updateOrderStatus"]);
  const get = spec.operations.find((o) => o.id === "getOrder")!;
  assert.deepEqual(get.params.map((p) => p.name), ["id"]);
  assert.ok(get.secured);
  assert.deepEqual(get.responses["200"]?.required?.sort(), ["customerName", "dish", "id", "quantity", "status", "total"]);
  assert.deepEqual(get.responses["404"]?.required, ["error"]);
});

test("JSON specs work too, and bad input gets a clear error", () => {
  const json = JSON.stringify({ openapi: "3.1.0", info: { title: "T" }, paths: { "/ping": { get: { responses: { "200": { description: "ok" } } } } } });
  assert.equal(parseSpec(json).operations[0].id, "get /ping");
  assert.throws(() => parseSpec("swagger: '2.0'\npaths: {}"), /Only OpenAPI 3/);
  assert.throws(() => parseSpec("{ not json"), /Couldn't read/);
});

test("paths and samples", () => {
  assert.deepEqual(matchPath("/api/orders/{id}", "/api/orders/ord_9?x=1"), { id: "ord_9" });
  assert.equal(matchPath("/api/orders/{id}", "/api/orders"), null);
  const create = spec.operations.find((o) => o.id === "createOrder")!;
  assert.deepEqual(sample(create.body!), { customerName: "Asha Verma", dish: "thali", quantity: 1 });
});

test("baseline plan covers each kind of failure the spec declares", () => {
  const plan = planTests(spec);
  const titles = plan.map((t) => t.title);
  assert.ok(titles.includes(`POST /api/orders rejects a missing "dish"`));
  assert.ok(titles.includes(`POST /api/orders rejects "quantity" below 1`));
  assert.ok(titles.includes(`POST /api/orders rejects "quantity" above 20`));
  assert.ok(titles.includes(`PATCH /api/orders/{id} rejects an unknown "status"`));
  assert.ok(titles.includes("GET /api/orders/{id} returns 404 for an unknown id"));
  assert.equal(plan.filter((t) => t.kind === "no-auth").length, 4);
  // every expected status is one the spec declares
  for (const t of plan) assert.ok(String(t.expectStatus) in spec.operations.find((o) => o.id === t.op)!.responses, t.title);
});

test("running against the demo API catches exactly the two planted bugs", async () => {
  const plan = planTests(spec);
  const results = await runTests(spec, plan, demoApi());
  const failed = results.filter((r) => !r.pass).map((r) => plan.find((t) => t.id === r.id)!.title);
  assert.deepEqual(failed, [`POST /api/orders rejects "quantity" below 1`, "GET /api/orders/{id} returns 404 for an unknown id"]);
  const r404 = results.find((r) => plan.find((t) => t.id === r.id)!.kind === "not-found" && !r.pass)!;
  assert.deepEqual(r404.problems, ["Expected 404, got 500."]);
});

test("checkCase rejects undeclared statuses, wrong paths, invalid success bodies and duplicates", () => {
  const plan = planTests(spec);
  assert.match(checkCase(spec, { op: "getOrder", title: "x", path: "/api/orders/ord_1001", expectStatus: 418 }, plan)[0], /418 isn't in the spec/);
  assert.match(checkCase(spec, { op: "getOrder", title: "x", path: "/api/items/1", expectStatus: 200 }, plan)[0], /doesn't match/);
  assert.match(checkCase(spec, { op: "createOrder", title: "x", path: "/api/orders", body: { dish: "pizza" }, expectStatus: 201 }, plan).join(), /breaks the spec/);
  assert.match(checkCase(spec, { ...plan[0] }, plan)[0], /Same as existing/);
  assert.deepEqual(checkCase(spec, { op: "updateOrderStatus", title: "can't cancel a cooking order", path: "/api/orders/ord_1001", body: { status: "cancelled" }, auth: true, expectStatus: 409 }, plan), []);
});

test("rendered test file is valid JavaScript with one test per case", async () => {
  const plan = planTests(spec);
  const src = renderTestFile(spec, plan);
  assert.equal(src.match(/^test\(/gm)?.length, plan.length);
  assert.match(src, /auth: false/);
  // parses as a module
  new Function(src.replace(/^import .*$/gm, "").replace(/await /g, ""));
});

test("agent adds a business-rule test, gets one rejected, runs the suite", async () => {
  const model = scriptedModel([
    { tools: [{ name: "list_operations", input: {} }] },
    {
      tools: [{
        name: "add_tests",
        input: {
          tests: [
            { op: "updateOrderStatus", title: "Can't skip from cooking to delivered", path: "/api/orders/ord_1001", body: { status: "delivered" }, expectStatus: 409, why: "Only the next status is allowed." },
            { op: "createOrder", title: "Rejects a one-letter name", path: "/api/orders", body: { customerName: "A", dish: "dosa", quantity: 1 }, expectStatus: 422, why: "minLength 2" },
          ],
        },
      }],
    },
    (req) => {
      const out = JSON.parse(lastToolResults(req)[0]);
      assert.equal(out.added.length, 1);
      assert.match(out.rejected[0].problems[0], /422 isn't in the spec/);
      return { tools: [{ name: "run_tests", input: {} }] };
    },
    (req) => {
      const out = JSON.parse(lastToolResults(req)[0]);
      assert.equal(out.failed.length, 2);
      return { text: "Two tests failed, both API bugs." };
    },
  ]);
  const { agent, state, prompt } = makeTestAgent(model, spec, { run: demoApi() });
  const r = await agent.run(prompt);
  assert.equal(r.status, "done");
  assert.equal(state.cases.filter((c) => c.source === "claude").length, 1);
  assert.equal(state.results?.length, state.cases.length);
});
