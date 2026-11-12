// Unit tests for src/us-cash.js: the fewest bills and coins for an amount, the fraction of a
// penny, the words, and the drawing's pieces.
import assert from "node:assert/strict";
import { test } from "node:test";
import { breakdown, cashSVG, describe, formatUSD } from "../src/us-cash.js";

const pieces = (b) => [...b.bills, ...b.coins].reduce((a, p) => a + p.count, 0);
const total = (b) => b.bills.reduce((a, p) => a + p.value * 100 * p.count, 0) + b.coins.reduce((a, p) => a + p.value * p.count, 0);

/** The fewest pieces for every amount up to `max` cents, by dynamic programming. */
function fewest(values, max) {
  const best = new Array(max + 1).fill(Infinity);
  best[0] = 0;
  for (let c = 1; c <= max; c++) for (const v of values) if (v <= c) best[c] = Math.min(best[c], best[c - v] + 1);
  return best;
}

test("the pieces add up to the amount and are the fewest possible (every amount to $250)", () => {
  const best = fewest([10000, 5000, 2000, 1000, 500, 200, 100, 50, 25, 10, 5, 1], 25000);
  for (let c = 0; c <= 25000; c++) {
    const b = breakdown(c / 100);
    assert.equal(total(b), c, `${c}¢`);
    assert.equal(pieces(b), best[c], `${c}¢`);
    assert.equal(b.fraction, 0);
  }
});

test("examples", () => {
  assert.deepEqual(breakdown(0), { bills: [], coins: [], fraction: 0 });
  assert.deepEqual(breakdown(0.99), { bills: [], coins: [{ value: 50, count: 1 }, { value: 25, count: 1 }, { value: 10, count: 2 }, { value: 1, count: 4 }], fraction: 0 });
  assert.deepEqual(breakdown(21.37), {
    bills: [{ value: 20, count: 1 }, { value: 1, count: 1 }],
    coins: [{ value: 25, count: 1 }, { value: 10, count: 1 }, { value: 1, count: 2 }], fraction: 0,
  });
  assert.deepEqual(breakdown(1234).bills, [{ value: 100, count: 12 }, { value: 20, count: 1 }, { value: 10, count: 1 }, { value: 2, count: 2 }]);
});

test("fractions of a cent, and float sums that are not exact", () => {
  assert.deepEqual(breakdown(0.0123), { bills: [], coins: [{ value: 1, count: 1 }], fraction: 0.23 });
  assert.deepEqual(breakdown(0.0004), { bills: [], coins: [], fraction: 0.04 });
  assert.deepEqual(breakdown(0.1 + 0.2), { bills: [], coins: [{ value: 25, count: 1 }, { value: 5, count: 1 }], fraction: 0 });
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += 0.0001; // $0.10 in steps of 1/100 cent
  assert.deepEqual(breakdown(sum), { bills: [], coins: [{ value: 10, count: 1 }], fraction: 0 });
  assert.equal(breakdown(0.00000004).fraction, 0); // under 1/10000 of a cent rounds away
});

test("other sets of bills and coins", () => {
  assert.deepEqual(breakdown(3.3, { bills: [5], coins: [25, 10, 5, 1] }).coins,
    [{ value: 25, count: 13 }, { value: 5, count: 1 }]); // no $1 bill: dollars become coins
  assert.deepEqual(breakdown(4, { bills: [100, 50, 20, 10, 5, 1] }).bills, [{ value: 1, count: 4 }]);
  assert.throws(() => breakdown(1, { coins: [25, 10] }), /penny/);
  assert.throws(() => breakdown(1, { coins: [3, 1] }), /3¢/);
  assert.throws(() => breakdown(1, { bills: [3] }), /\$3/);
  assert.throws(() => breakdown(-1), RangeError);
  assert.throws(() => breakdown(NaN), RangeError);
});

test("describe and formatUSD", () => {
  assert.equal(describe(breakdown(0)), "nothing");
  assert.equal(describe(breakdown(0.0123)), "1 penny and 23% of a penny");
  assert.equal(describe(breakdown(0.00004)), "0.4% of a penny");
  assert.equal(describe(breakdown(21.37)), "1 $20 bill, 1 $1 bill, 1 quarter, 1 dime and 2 pennies");
  assert.equal(describe(breakdown(0.6)), "1 half dollar and 1 dime");
  assert.equal(formatUSD(0), "$0");
  assert.equal(formatUSD(0.0123), "$0.0123");
  assert.equal(formatUSD(21.37), "$21.37");
});

test("the drawing has one piece per bill and coin, a pie for the fraction, and an accessible name", () => {
  const count = (svg, piece) => svg.split(`data-piece="${piece}"`).length - 1;
  const a = cashSVG(21.3712, { size: 22 });
  assert.match(a, /^<svg [^>]*height="22"/);
  assert.match(a, /aria-label="\$21\.37: 1 \$20 bill, 1 \$1 bill, 1 quarter, 1 dime, 2 pennies and 12% of a penny"/);
  assert.equal(count(a, "$20 bill"), 1);
  assert.equal(count(a, "quarter"), 1);
  assert.equal(count(a, "part of a penny"), 1);
  assert.equal(count(a, "penny"), 2 + 2); // two pennies, and the faint and sliced penny of the pie
  const many = cashSVG(1234, { maxStack: 3 });
  assert.equal(count(many, "$100 bill"), 3);
  assert.match(many, />×12</);
  const none = cashSVG(0);
  assert.equal(count(none, "part of a penny"), 1); // a faint penny for nothing spent
  assert.match(none, /aria-label="\$0: nothing"/);
  assert.match(cashSVG(1, { label: "a <b>" }), /aria-label="a &lt;b&gt;"/);
});

test("coins keep their real relative sizes", () => {
  const r = (piece) => Number(cashSVG(0.91, { size: 30.61 }).match(new RegExp(`data-piece="${piece}"><circle [^>]*r="([\\d.]+)"`))[1]);
  assert.equal(r("half dollar"), 15.3); // the half dollar fills the height: 1 px per mm here
  assert.equal(r("quarter"), 12.13);
  assert.equal(r("dime"), 8.96);
  assert.equal(r("penny"), 9.53);
  assert.equal(r("nickel"), 10.61); // 91¢ = 50 + 25 + 10 + 5 + 1: one of each
});
