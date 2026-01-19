import assert from "node:assert/strict";

const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } };
const parsedRequest = JSON.parse(JSON.stringify(request)) as typeof request;
assert.equal(parsedRequest.jsonrpc, "2.0");
assert.equal(parsedRequest.method, "initialize");

const response = { jsonrpc: "2.0", id: 1, result: { ok: true } };
const parsedResponse = JSON.parse(JSON.stringify(response)) as typeof response;
assert.equal(parsedResponse.result.ok, true);

const failure = { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } };
const parsedFailure = JSON.parse(JSON.stringify(failure)) as typeof failure;
assert.equal(parsedFailure.error.code, -32601);

let threw = false;
try {
  JSON.parse("{");
} catch {
  threw = true;
}
assert.ok(threw);

console.log("smoke ok");
