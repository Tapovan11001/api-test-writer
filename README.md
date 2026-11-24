# API Test Writer

Reads an OpenAPI spec and writes the API tests every endpoint should pass, runs them, and gives you a test file to keep.

**Live:** {{live-url}}

## How it works in 100 words

A developer pastes their API's OpenAPI spec, the file that lists every endpoint and what it accepts. API Test Writer reads it and writes the tests every endpoint should pass: a normal request works, a missing or wrong field gets rejected, an unknown id returns "not found", and a request without a login token is refused. It only expects responses the spec actually promises. You can run the tests right in the page; the built-in demo API has two hidden bugs, and the tests find both. Claude adds tests for business rules the simple checks can't see. Then you download a ready-to-run test file.

_Created by Aarav Makhija._

## Why

Most small teams have an OpenAPI spec (or can generate one from their Next.js or Express routes) and very few API tests. The tests that catch the most bugs are also the most boring to write: send a valid request, leave out a required field, send text where a number goes, ask for an id that doesn't exist, forget the token. Those can be worked out from the spec alone, so this tool does that part, and uses Claude only for the tests that need reading the descriptions.

## What it does

- Reads OpenAPI 3 in YAML or JSON, with `$ref`, shared path parameters and `allOf`.
- Writes baseline tests for each endpoint:
  - **happy path**: a valid request built from the schema's examples, expecting the spec's 2xx status and a body that matches the response schema
  - **missing field**: each required body field removed, expecting 400 or 422
  - **wrong type**: text in a number field
  - **out of range**: one below `minimum`, one above `maximum`, an unknown `enum` value
  - **not found**: an id that doesn't exist, expecting 404
  - **no token**: the request without auth, expecting 401
- A test is only written if the spec declares the status it expects. The tool never guesses what the API "should" return.
- Runs the tests in the page, against your URL or a built-in demo API.
- Downloads `api.test.mjs`, a plain `node:test` file. Run it with `BASE_URL=http://localhost:3000 node --test api.test.mjs`.
- **Ask Claude**: Claude reads the operations through tools and adds tests for business rules written in descriptions, like "only a placed order can be cancelled". Every test it proposes goes through `checkCase` first: the path has to match the endpoint, the expected status has to be declared, a test expecting success has to send a valid body, and duplicates are refused. Rejected tests go back with the reason.

## The demo API

The sample spec is a tiffin delivery app's orders API. The page includes an in-memory version of it, written like a rushed route handler, with two bugs planted:

1. `POST /api/orders` checks that `quantity` is at most 20 but never that it's at least 1, so an order for 0 thalis is accepted.
2. `GET /api/orders/{id}` reads a field of an order that might not exist, so an unknown id returns 500 instead of 404.

Press **Run tests** and those are the two that fail, out of 19. The test suite checks this too.

## Run it

```bash
npm install
npm test        # 8 tests: parsing, planning, the demo bugs, checkCase, the test file, the agent loop
npm run dev     # localhost:5173
```

## Layout

| Path | What's in it |
|---|---|
| `src/core/spec.ts` | Parse the spec, resolve `$ref`s, build example values |
| `src/core/plan.ts` | Baseline test plan, `checkCase`, the runner, the test file writer |
| `src/core/sample.ts` | Sample spec and the demo API with its two bugs |
| `src/agent.ts` | Claude agent with `list_operations`, `get_operation`, `add_tests`, `run_tests` |
| `src/harness/` | [TinyHarness](https://github.com/Tapovan11001/tinyharness), vendored |
| `web/` | Spec on the left, tests and the test file on the right |

## Limits

- Only checks status codes and response shape, not exact values (for example, that `total` is quantity × price). Claude points those out in its reply, but they aren't asserted yet.
- Running in the browser needs CORS on your API. The downloaded file has no such limit.
- Tests run in order and share state, like a real API would. The happy-path PATCH moves the sample order to "cooking" before later tests run.

## License

MIT
