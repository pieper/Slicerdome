import { test } from "node:test";
import assert from "node:assert/strict";
import { numbers } from "../bench/tasks.mjs";

test("numbers reads thousands separators, minus signs and lists", () => {
  assert.deepEqual(numbers("1,218,462 voxels"), [1218462]);
  assert.deepEqual(numbers("447,491"), [447491]);
  assert.deepEqual(numbers("(9.00, −23.24, -31.44)"), [9, -23.24, -31.44]);
  assert.deepEqual(numbers("IJK (133,86,57)"), [133, 86, 57]);
  assert.deepEqual(numbers("1.5e3 and 2E-2"), [1500, 0.02]);
});
