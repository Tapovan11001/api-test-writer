// Reading an OpenAPI 3 spec into a flat list of operations. No AI in this file.
import { parse as parseYaml } from "yaml";

export type Method = "get" | "post" | "put" | "patch" | "delete";
export const METHODS: Method[] = ["get", "post", "put", "patch", "delete"];

/** The parts of JSON Schema that OpenAPI specs commonly use. */
export interface Schema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  format?: string;
  example?: unknown;
  default?: unknown;
  description?: string;
  nullable?: boolean;
  $ref?: string;
}

export interface Param {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: Schema;
  example?: unknown;
}

export interface Operation {
  id: string; // operationId, or "get /path"
  method: Method;
  path: string; // template, e.g. /api/orders/{id}
  summary: string;
  params: Param[];
  body: Schema | null;
  bodyRequired: boolean;
  responses: Record<string, Schema | null>; // status code -> JSON body schema
  secured: boolean;
}

export interface Spec {
  title: string;
  operations: Operation[];
}

type Doc = Record<string, any>;

/** Accepts JSON or YAML text. Throws a readable error if it isn't an OpenAPI 3 document. */
export function parseSpec(text: string): Spec {
  let doc: Doc;
  const t = text.trim();
  if (!t) throw new Error("The spec is empty.");
  try {
    doc = t.startsWith("{") ? JSON.parse(t) : parseYaml(t);
  } catch (e) {
    throw new Error(`Couldn't read the spec: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
  if (!doc || typeof doc !== "object") throw new Error("The spec should be an object.");
  if (!String(doc.openapi ?? "").startsWith("3")) throw new Error('Only OpenAPI 3 specs are supported (the file needs "openapi: 3.x").');
  if (!doc.paths || typeof doc.paths !== "object") throw new Error("The spec has no paths.");

  const globalSecurity = Array.isArray(doc.security) && doc.security.length > 0;
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries<Doc>(doc.paths)) {
    const shared: Doc[] = item.parameters ?? [];
    for (const method of METHODS) {
      const op: Doc | undefined = item[method];
      if (!op) continue;
      const params = [...shared, ...(op.parameters ?? [])]
        .map((p) => deref(doc, p))
        .filter((p) => p.in === "path" || p.in === "query" || p.in === "header")
        .map<Param>((p) => ({
          name: p.name,
          in: p.in,
          required: p.in === "path" ? true : Boolean(p.required),
          schema: resolve(doc, p.schema ?? { type: "string" }),
          example: p.example ?? p.schema?.example,
        }));
      const rb = op.requestBody ? deref(doc, op.requestBody) : null;
      const bodySchema = rb?.content?.["application/json"]?.schema;
      const responses: Record<string, Schema | null> = {};
      for (const [code, r] of Object.entries<Doc>(op.responses ?? {})) {
        const res = deref(doc, r);
        const s = res?.content?.["application/json"]?.schema;
        responses[code] = s ? resolve(doc, s) : null;
      }
      const security = op.security ?? (globalSecurity ? doc.security : []);
      operations.push({
        id: op.operationId ?? `${method} ${path}`,
        method,
        path,
        summary: op.summary ?? op.description ?? "",
        params,
        body: bodySchema ? resolve(doc, bodySchema) : null,
        bodyRequired: Boolean(rb?.required),
        responses,
        secured: Array.isArray(security) && security.some((s: Doc) => Object.keys(s).length > 0),
      });
    }
  }
  if (!operations.length) throw new Error("The spec has paths but no operations (get, post, put, patch, delete).");
  return { title: doc.info?.title ?? "API", operations };
}

function deref(doc: Doc, node: Doc): Doc {
  let n = node;
  for (let i = 0; i < 10 && n && typeof n.$ref === "string"; i++) n = lookup(doc, n.$ref);
  return n;
}

function lookup(doc: Doc, ref: string): Doc {
  if (!ref.startsWith("#/")) throw new Error(`Only local $refs are supported, got ${ref}`);
  const v = ref.slice(2).split("/").reduce<any>((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
  if (v === undefined) throw new Error(`$ref not found: ${ref}`);
  return v;
}

/** Inline every $ref (with a depth limit, so recursive schemas don't loop). */
export function resolve(doc: Doc, s: Doc, depth = 0): Schema {
  if (depth > 8) return {};
  const n = deref(doc, s);
  if (n.allOf) {
    const parts = n.allOf.map((p: Doc) => resolve(doc, p, depth + 1));
    return {
      type: "object",
      properties: Object.assign({}, ...parts.map((p: Schema) => p.properties ?? {})),
      required: parts.flatMap((p: Schema) => p.required ?? []),
    };
  }
  const out: Schema = { ...n };
  delete out.$ref;
  if (n.properties) out.properties = Object.fromEntries(Object.entries<Doc>(n.properties).map(([k, v]) => [k, resolve(doc, v, depth + 1)]));
  if (n.items) out.items = resolve(doc, n.items, depth + 1);
  return out;
}

/** Turn /api/orders/{id} into /api/orders/ord_1001 using the given values. */
export function fillPath(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([^}]+)\}/g, (_, k) => encodeURIComponent(String(values[k] ?? k)));
}

/** Does a concrete path match an operation's template? */
export function matchPath(template: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const re = new RegExp("^" + template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{([^}]+)\\?\}/g, (_, k) => (names.push(k), "([^/]+)")) + "$");
  const m = path.split("?")[0].match(re);
  if (!m) return null;
  return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
}

/** A valid example value for a schema. Deterministic, so generated tests don't change between runs. */
export function sample(s: Schema, name = ""): unknown {
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case "object": {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) o[k] = sample(v, k);
      return o;
    }
    case "array":
      return s.items ? [sample(s.items, name)] : [];
    case "integer":
      return s.minimum ?? 1;
    case "number":
      return s.minimum ?? 9.5;
    case "boolean":
      return true;
    case "string": {
      if (s.format === "email") return "asha@example.com";
      if (s.format === "date-time") return "2026-01-15T10:00:00Z";
      if (s.format === "date") return "2026-01-15";
      if (s.format === "uuid") return "3f2b8c1e-4a6d-4e8b-9c1a-2d5e7f9a0b13";
      if (s.format === "uri") return "https://example.com";
      const base = name ? `sample ${name}` : "sample";
      return s.minLength && base.length < s.minLength ? base.padEnd(s.minLength, "x") : base;
    }
    default:
      return null;
  }
}

export const successStatus = (op: Operation) =>
  Object.keys(op.responses).filter((c) => /^2\d\d$/.test(c)).map(Number).sort((a, b) => a - b)[0] ?? 200;
