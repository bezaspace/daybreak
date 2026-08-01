import { describe, it } from "node:test";
import assert from "node:assert";
import { sum } from "./sum.js";

describe("sum", () => {
  it("adds two numbers", () => {
    assert.strictEqual(sum(2, 3), 5);
  });

  it("works with negative numbers", () => {
    assert.strictEqual(sum(-2, 3), 1);
  });
});
