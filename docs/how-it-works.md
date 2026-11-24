# How it works

A developer pastes their API's OpenAPI spec, the file that lists every endpoint and what it accepts. API Test Writer reads it and writes the tests every endpoint should pass: a normal request works, a missing or wrong field gets rejected, an unknown id returns "not found", and a request without a login token is refused. It only expects responses the spec actually promises. You can run the tests right in the page; the built-in demo API has two hidden bugs, and the tests find both. Claude adds tests for business rules the simple checks can't see. Then you download a ready-to-run test file.

_Created by Aarav Makhija._
