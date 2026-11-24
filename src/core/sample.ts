// A small sample API (a tiffin delivery app's orders endpoints, like a Next.js /api route)
// and an in-memory version of it with two planted bugs, so the demo has something to catch.
import type { Fetcher } from "./plan.ts";

export const SAMPLE_SPEC = `openapi: 3.0.3
info:
  title: Tiffin Orders API
  version: 1.0.0
security:
  - bearerAuth: []
paths:
  /api/orders:
    get:
      operationId: listOrders
      summary: List orders, optionally by status
      parameters:
        - name: status
          in: query
          schema: { $ref: "#/components/schemas/Status" }
      responses:
        "200":
          description: Orders
          content:
            application/json:
              schema:
                type: object
                required: [orders]
                properties:
                  orders: { type: array, items: { $ref: "#/components/schemas/Order" } }
        "401": { $ref: "#/components/responses/Unauthorized" }
    post:
      operationId: createOrder
      summary: Place an order
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/NewOrder" }
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
  /api/orders/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string, example: ord_1001 }
    get:
      operationId: getOrder
      summary: Get one order
      responses:
        "200":
          description: The order
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
    patch:
      operationId: updateOrderStatus
      summary: Move an order to its next status
      description: placed -> cooking -> out-for-delivery -> delivered. Only a placed order can be cancelled.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [status]
              example: { status: cooking }
              properties:
                status: { $ref: "#/components/schemas/Status" }
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Order" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409":
          description: The order can't move to that status from where it is
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Error" }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
  responses:
    BadRequest:
      description: Invalid input
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    Unauthorized:
      description: Missing or bad token
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
    NotFound:
      description: No such order
      content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } }
  schemas:
    Status:
      type: string
      enum: [placed, cooking, out-for-delivery, delivered, cancelled]
    NewOrder:
      type: object
      required: [customerName, dish, quantity]
      properties:
        customerName: { type: string, minLength: 2, example: Asha Verma }
        dish: { type: string, enum: [thali, biryani, dosa] }
        quantity: { type: integer, minimum: 1, maximum: 20 }
    Order:
      allOf:
        - $ref: "#/components/schemas/NewOrder"
        - type: object
          required: [id, status, total]
          properties:
            id: { type: string }
            status: { $ref: "#/components/schemas/Status" }
            total: { type: number, description: Rupees }
    Error:
      type: object
      required: [error]
      properties:
        error: { type: string }
`;

const PRICE: Record<string, number> = { thali: 120, biryani: 180, dosa: 90 };
const NEXT: Record<string, string[]> = {
  placed: ["cooking", "cancelled"],
  cooking: ["out-for-delivery"],
  "out-for-delivery": ["delivered"],
  delivered: [],
  cancelled: [],
};

interface Order { id: string; customerName: string; dish: string; quantity: number; status: string; total: number }

/**
 * An in-memory implementation of the sample API, written the way a rushed route handler
 * often is. Two bugs are planted on purpose:
 *  1. POST checks that quantity is a number but not that it's at least 1.
 *  2. GET /api/orders/{id} reads a field of an order that may not exist, so an unknown id is a 500, not a 404.
 */
export function demoApi(): Fetcher {
  const orders = new Map<string, Order>([
    ["ord_1001", { id: "ord_1001", customerName: "Ravi Kumar", dish: "thali", quantity: 2, status: "placed", total: 240 }],
  ]);
  let seq = 1002;
  const err = (status: number, error: string) => ({ status, body: { error } });

  return async ({ method, path, body, headers }) => {
    if (headers.authorization !== "Bearer test-token") return err(401, "Missing or bad token");
    const [p, qs] = path.split("?");
    const query = new URLSearchParams(qs ?? "");
    const m = p.match(/^\/api\/orders(?:\/([^/]+))?$/);
    if (!m) return err(404, "No such route");
    const id = m[1] ? decodeURIComponent(m[1]) : null;

    if (!id && method === "get") {
      const s = query.get("status");
      return { status: 200, body: { orders: [...orders.values()].filter((o) => !s || o.status === s) } };
    }
    if (!id && method === "post") {
      const b = body as Partial<Order> | undefined;
      if (!b || typeof b.customerName !== "string" || b.customerName.trim().length < 2) return err(400, "customerName is required");
      if (!b.dish || !(b.dish in PRICE)) return err(400, "dish must be thali, biryani or dosa");
      if (typeof b.quantity !== "number" || !Number.isInteger(b.quantity)) return err(400, "quantity must be a whole number");
      if (b.quantity > 20) return err(400, "quantity must be 20 or less"); // BUG: no lower bound
      const o: Order = { id: `ord_${seq++}`, customerName: b.customerName, dish: b.dish, quantity: b.quantity, status: "placed", total: PRICE[b.dish] * b.quantity };
      orders.set(o.id, o);
      return { status: 201, body: o };
    }
    if (id && method === "get") {
      const o = orders.get(id);
      try {
        // BUG: o can be undefined here
        return { status: 200, body: { ...o, total: (o as Order).quantity * PRICE[(o as Order).dish] } };
      } catch {
        return err(500, "Internal server error");
      }
    }
    if (id && method === "patch") {
      const o = orders.get(id);
      if (!o) return err(404, "No such order");
      const s = (body as { status?: string } | undefined)?.status;
      if (!s || !(s in NEXT)) return err(400, "status is not valid");
      if (!NEXT[o.status].includes(s)) return err(409, `Can't move from ${o.status} to ${s}`);
      o.status = s;
      return { status: 200, body: o };
    }
    return err(405, "Method not allowed");
  };
}
