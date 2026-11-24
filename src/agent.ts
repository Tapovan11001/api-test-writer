import { Agent, defineTool, type ModelClient, type TraceEvent } from "./harness/index.ts";
import { checkCase, planTests, runTests, type Fetcher, type Result, type TestCase } from "./core/plan.ts";
import type { Spec } from "./core/spec.ts";

export const SYSTEM = `You help a developer test their HTTP API from its OpenAPI spec.

Simple rules have already written the baseline tests: a happy path per operation, missing required fields, wrong types, numbers out of range, unknown enum values, unknown ids and missing tokens. Your job is the tests those rules can't think of: business logic written in summaries and descriptions (allowed status changes, who can do what), string length limits, combinations of fields, and query parameters.

Use list_operations, then get_operation for the ones worth a closer look. Add 3 to 6 tests with add_tests. Every test needs an expected status the spec actually declares for that operation; the tool rejects anything else. Don't repeat a baseline test.

If run_tests is available, run the whole suite once at the end. Then reply in 2 to 4 short sentences for the developer: which tests failed, and for each, whether the API looks wrong or the spec is unclear, judged from the spec. Don't invent behaviour the spec doesn't describe.`;

const testInput = {
  type: "object",
  properties: {
    op: { type: "string", description: "Operation id from list_operations" },
    title: { type: "string", description: "Short test name, e.g. 'PATCH /api/orders/{id} refuses to cancel a delivered order'" },
    path: { type: "string", description: "Concrete path with real values, e.g. /api/orders/ord_1001, plus ?query if needed" },
    body: { description: "JSON request body, if the operation takes one" },
    auth: { type: "boolean", description: "Send the bearer token. Defaults to true for secured operations." },
    expectStatus: { type: "integer", description: "Status the spec says this request should get" },
    why: { type: "string", description: "One sentence: what part of the spec this checks" },
  },
  required: ["op", "title", "path", "expectStatus", "why"],
} as const;

export function makeTestAgent(model: ModelClient, spec: Spec, opts: { run?: Fetcher; onEvent?: (e: TraceEvent) => void } = {}) {
  const state: { cases: TestCase[]; results: Result[] | null } = { cases: planTests(spec), results: null };

  const tools = [
    defineTool<Record<string, never>>({
      name: "list_operations",
      description: "List every operation in the spec, with how many baseline tests it already has.",
      input: { type: "object", properties: {} },
      run: () =>
        spec.operations.map((o) => ({
          id: o.id,
          route: `${o.method.toUpperCase()} ${o.path}`,
          summary: o.summary,
          statuses: Object.keys(o.responses),
          tests: state.cases.filter((t) => t.op === o.id).map((t) => `${t.expectStatus}: ${t.title}`),
        })),
    }),
    defineTool<{ id: string }>({
      name: "get_operation",
      description: "Full details of one operation: parameters, request body schema, responses.",
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: ({ id }) => {
        const o = spec.operations.find((x) => x.id === id);
        if (!o) throw new Error(`No operation "${id}". Ids: ${spec.operations.map((x) => x.id).join(", ")}`);
        return o;
      },
    }),
    defineTool<{ tests: Array<Partial<TestCase>> }>({
      name: "add_tests",
      description: "Add test cases. Each is checked against the spec; rejected ones come back with the reason.",
      input: { type: "object", properties: { tests: { type: "array", items: testInput as any } }, required: ["tests"] },
      run: ({ tests }) => {
        const added: string[] = [];
        const rejected: { title?: string; problems: string[] }[] = [];
        for (const t of tests) {
          const op = spec.operations.find((o) => o.id === t.op);
          const c = { ...t, auth: t.auth ?? op?.secured ?? false };
          const problems = checkCase(spec, c, state.cases);
          if (problems.length || !op) {
            rejected.push({ title: t.title, problems });
            continue;
          }
          const id = `${op.id}-c${state.cases.filter((x) => x.op === op.id).length + 1}`;
          state.cases.push({ id, op: op.id, kind: "custom", title: c.title!, method: op.method, path: c.path!, body: c.body, auth: c.auth, expectStatus: c.expectStatus!, why: c.why ?? "", source: "claude" });
          added.push(c.title!);
        }
        return { added, rejected, total: state.cases.length };
      },
    }),
  ];
  if (opts.run) {
    const run = opts.run;
    tools.push(
      defineTool<Record<string, never>>({
        name: "run_tests",
        description: "Run every test (baseline and yours) against the API. Returns the failures.",
        input: { type: "object", properties: {} },
        run: async () => {
          state.results = await runTests(spec, state.cases, run);
          const failed = state.results.filter((r) => !r.pass).map((r) => {
            const t = state.cases.find((c) => c.id === r.id)!;
            return { title: t.title, source: t.source, request: `${t.method.toUpperCase()} ${t.path}`, body: t.body, problems: r.problems };
          });
          return { passed: state.results.length - failed.length, failed };
        },
      }) as any,
    );
  }

  const agent = new Agent({ model, system: SYSTEM, tools, limits: { maxSteps: 10 }, onEvent: opts.onEvent });
  const prompt = `API: ${spec.title}. ${spec.operations.length} operations, ${state.cases.length} baseline tests.${opts.run ? " The API is running, so run_tests works." : " The API isn't running here, so just add tests."}`;
  return { agent, state, prompt };
}
