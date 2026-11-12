// us-cash: an amount of money drawn as US bills and coins, in SVG.
//
// Dollars are bills and cents are coins, each the fewest pieces that add up to the amount (the
// US denominations are a set where taking the largest piece that fits each time gives the fewest).
// What is left under a cent is one more penny drawn as a pie chart of that fraction over a faint
// whole penny. Coins keep their real relative sizes (a dime is smaller than a penny, a nickel
// larger). Bills are all one size and much larger than any coin, so they are drawn as tall as
// the largest coin, the half dollar, with their real proportions.
//
// No dependencies and no state outside a call, so it can move into a library of its own.
//
//   import { breakdown, describe, cashSVG, defineUsCash } from "./us-cash.js";
//
//   breakdown(21.37)
//     // { bills: [{ value: 20, count: 1 }, { value: 1, count: 1 }],
//     //   coins: [{ value: 25, count: 1 }, { value: 10, count: 1 }, { value: 1, count: 2 }], fraction: 0 }
//   describe(breakdown(0.0123))   // "1 penny and 23% of a penny"
//   cashSVG(0.0123, { size: 22 }) // "<svg …>…</svg>", a string, so it also works outside a browser
//
//   defineUsCash();               // registers <us-cash>
//   <us-cash amount="0.0123" size="22"></us-cash>   or   element.amount = 0.0123
//
// Options (cashSVG; the element takes them as attributes of the same names, lists as "50 25 10 5 1"):
//   size       px: the height of the drawing (the half dollar's diameter and the bills' height). 24
//   coins      the coins to use, in cents; must include 1. [50, 25, 10, 5, 1]
//   bills      the bills to use, in dollars. [100, 50, 20, 10, 5, 2, 1]
//   max-stack  (maxStack) at most this many of one bill are drawn; more are counted as "×n". 3
//   label      the accessible name; by default the amount and its pieces.

/** US coins: value in cents, diameter in mm, metal, whether the edge is reeded, and which way the portrait faces. */
export const COINS = [
  { value: 50, name: "half dollar", plural: "half dollars", mm: 30.61, metal: "silver", reeded: true, faces: "left" }, // Kennedy
  { value: 25, name: "quarter", plural: "quarters", mm: 24.26, metal: "silver", reeded: true, faces: "left" }, // Washington
  { value: 10, name: "dime", plural: "dimes", mm: 17.91, metal: "silver", reeded: true, faces: "left" }, // Roosevelt
  { value: 5, name: "nickel", plural: "nickels", mm: 21.21, metal: "nickel", reeded: false, faces: "left" }, // Jefferson
  { value: 1, name: "penny", plural: "pennies", mm: 19.05, metal: "copper", reeded: false, faces: "right" }, // Lincoln
];

/** US bills: value in dollars and whose portrait is on the front. All are 156.1 × 66.3 mm. */
export const BILLS = [
  { value: 100, portrait: "Franklin" }, { value: 50, portrait: "Grant" }, { value: 20, portrait: "Jackson" },
  { value: 10, portrait: "Hamilton" }, { value: 5, portrait: "Lincoln" }, { value: 2, portrait: "Jefferson" },
  { value: 1, portrait: "Washington" },
];

const BILL_RATIO = 156.1 / 66.3;
const LARGEST_COIN_MM = 30.61;
const DEFAULT_COINS = COINS.map((c) => c.value);
const DEFAULT_BILLS = BILLS.map((b) => b.value);

/** "$0.0123", "$21.37", "$0". */
export function formatUSD(amount) {
  return amount === 0 ? "$0" : amount < 1 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

/**
 * The fewest bills and coins for an amount in dollars, largest first, and the fraction of a
 * cent left over (0 ≤ fraction < 1; amounts are rounded to 1/10000 of a cent).
 * Dollars that the bills cannot make (when $1 is not among them) are made of coins.
 */
export function breakdown(amount, { coins = DEFAULT_COINS, bills = DEFAULT_BILLS } = {}) {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`us-cash: not an amount of money: ${amount}`);
  for (const v of coins) if (!COINS.some((c) => c.value === v)) throw new RangeError(`us-cash: no US coin is worth ${v}¢`);
  for (const v of bills) if (!BILLS.some((b) => b.value === v)) throw new RangeError(`us-cash: no US bill is worth $${v}`);
  if (!coins.includes(1)) throw new RangeError("us-cash: the coins must include the penny (1)");
  const units = Math.round(amount * 1e6); // 1/10000 of a cent
  let cents = Math.floor(units / 1e4);
  const take = (values, centsEach) => [...values].sort((a, b) => b - a).flatMap((value) => {
    const count = Math.floor(cents / (value * centsEach));
    cents -= count * value * centsEach;
    return count ? [{ value, count }] : [];
  });
  const billParts = take(bills, 100);
  const coinParts = take(coins, 1);
  return { bills: billParts, coins: coinParts, fraction: (units % 1e4) / 1e4 };
}

const share = (f) => `${f >= 0.01 ? Math.round(f * 100) : +(f * 100).toPrecision(1)}%`;

/** The pieces in words: "1 $20 bill, 2 dimes, 1 penny and 23% of a penny", or "nothing". */
export function describe({ bills = [], coins = [], fraction = 0 }) {
  const words = [
    ...bills.map((b) => `${b.count} $${b.value} bill${b.count === 1 ? "" : "s"}`),
    ...coins.map((c) => {
      const coin = COINS.find((x) => x.value === c.value);
      return `${c.count} ${c.count === 1 ? coin.name : coin.plural}`;
    }),
    ...(fraction > 0 ? [`${share(fraction)} of a penny`] : []),
  ];
  if (!words.length) return "nothing";
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

// ---------------------------------------------------------------------------------------------
// Drawing

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const n = (x) => +x.toFixed(2);

// Coin metals: a lit face (highlight, body, edge), the rim, and the relief of the portrait.
const METALS = {
  copper: { stops: ["#f7c9a1", "#d08550", "#99522a"], rim: "#7a3f1b", relief: "#6b3415" },
  silver: { stops: ["#ffffff", "#c8cbd0", "#8b9097"], rim: "#6b7077", relief: "#585d64" },
  nickel: { stops: ["#f5f4ee", "#bfbdb4", "#87857c"], rim: "#67655d", relief: "#56544d" },
};

// A head and shoulders in profile, facing right, in a 100 × 100 box.
const PROFILE = "M40 15C58 10 72 22 72 38L76 46L80 54L73 56L74 62L71 66C70 72 64 74 58 72L58 82L66 92L30 92L36 80C26 72 22 58 24 44C26 26 32 18 40 15Z";

function gradients(id) {
  return Object.entries(METALS).map(([metal, m]) => `<radialGradient id="${id}-${metal}" cx="50%" cy="50%" r="50%" fx="35%" fy="30%">` +
    `<stop offset="0" stop-color="${m.stops[0]}"/><stop offset=".55" stop-color="${m.stops[1]}"/><stop offset="1" stop-color="${m.stops[2]}"/></radialGradient>`).join("");
}

function coinSVG(coin, cx, cy, r, id, extra = "") {
  const m = METALS[coin.metal];
  const rim = Math.max(0.6, r * 0.12);
  const k = (r * 1.25) / 100;
  const flip = coin.faces === "left" ? -1 : 1;
  const face = `translate(${n(cx - flip * 51 * k)} ${n(cy - 53 * k)}) scale(${n(flip * k)} ${n(k)})`; // the head's middle on the coin's
  return `<g data-piece="${coin.name}"${extra}>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="url(#${id}-${coin.metal})"/>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r - rim / 2)}" fill="none" stroke="${m.rim}" stroke-width="${n(rim)}"` +
    (coin.reeded ? ` stroke-dasharray="${n(rim * 0.7)} ${n(rim * 0.5)}"` : "") + "/>" +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.78)}" fill="none" stroke="${m.rim}" stroke-opacity=".3" stroke-width="${n(Math.max(0.4, r * 0.04))}"/>` +
    `<path d="${PROFILE}" transform="${face}" fill="${m.relief}" opacity=".45"/></g>`;
}

/** The part of a penny for a fraction of a cent: a pie slice from twelve o'clock, clockwise, over a faint whole penny. */
function pieSVG(fraction, cx, cy, r, id) {
  const penny = COINS.find((c) => c.value === 1);
  const a = Math.min(fraction, 0.9999) * 2 * Math.PI;
  const slice = `M${n(cx)} ${n(cy)}L${n(cx)} ${n(cy - r - 1)}A${n(r + 1)} ${n(r + 1)} 0 ${fraction > 0.5 ? 1 : 0} 1 ${n(cx + (r + 1) * Math.sin(a))} ${n(cy - (r + 1) * Math.cos(a))}Z`;
  return `<g data-piece="part of a penny" data-fraction="${fraction}">` +
    coinSVG(penny, cx, cy, r, id, ` opacity=".28"`) +
    (fraction > 0 ? `<clipPath id="${id}-slice"><path d="${slice}"/></clipPath>` + coinSVG(penny, cx, cy, r, id, ` clip-path="url(#${id}-slice)"`) : "") +
    "</g>";
}

function billSVG(bill, x, h) {
  const w = h * BILL_RATIO;
  const ink = "#2d5a3b";
  const cx = x + w / 2;
  const cy = h / 2;
  const line = Math.max(0.5, h * 0.03);
  const inset = h * 0.09;
  const [rx, ry] = [h * 0.26, h * 0.34];
  const side = (w / 2 - rx - inset) / 2; // the middle of the space beside the oval
  const fs = h * (bill.value >= 100 ? 0.3 : 0.36);
  const ribbon = bill.value === 100 ? `<rect x="${n(cx + rx + h * 0.05)}" y="${n(inset)}" width="${n(h * 0.06)}" height="${n(h - 2 * inset)}" fill="#3a6fd0" opacity=".85"/>` : "";
  // The lower right numeral of the larger bills is in color-shifting ink (copper to green).
  const right = bill.value >= 10 ? "#9a5b2c" : ink;
  const numeral = (tx, color) => `<text x="${n(tx)}" y="${n(cy + fs * 0.36)}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="${n(fs)}" fill="${color}">${bill.value}</text>`;
  return `<g data-piece="$${bill.value} bill">` +
    `<rect x="${n(x + line / 2)}" y="${n(line / 2)}" width="${n(w - line)}" height="${n(h - line)}" rx="${n(h * 0.06)}" fill="#e2e8d2" stroke="#6d8a68" stroke-width="${n(line)}"/>` +
    `<rect x="${n(x + inset)}" y="${n(inset)}" width="${n(w - 2 * inset)}" height="${n(h - 2 * inset)}" rx="${n(h * 0.04)}" fill="none" stroke="${ink}" stroke-opacity=".5" stroke-width="${n(line * 0.8)}"/>` +
    `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="#cdd7ba" stroke="${ink}" stroke-width="${n(line)}"/>` +
    `<circle cx="${n(cx)}" cy="${n(cy - ry * 0.22)}" r="${n(h * 0.105)}" fill="${ink}" opacity=".75"/>` +
    `<path d="M${n(cx - rx * 0.62)} ${n(cy + ry * 0.78)}C${n(cx - rx * 0.6)} ${n(cy + ry * 0.12)} ${n(cx + rx * 0.6)} ${n(cy + ry * 0.12)} ${n(cx + rx * 0.62)} ${n(cy + ry * 0.78)}Z" fill="${ink}" opacity=".75"/>` +
    ribbon + numeral(x + inset + side, ink) + numeral(x + w - inset - side + (ribbon ? h * 0.05 : 0), right) + "</g>";
}

let lastId = 0;

/** The amount drawn as bills and coins: an SVG element as a string. Options are listed at the top of this file. */
export function cashSVG(amount, { size = 24, coins, bills, maxStack = 3, label, gap } = {}) {
  const parts = breakdown(amount, { coins, bills });
  const id = `us-cash-${++lastId}`;
  const h = size;
  const mm = h / LARGEST_COIN_MM;
  const space = gap ?? Math.max(2, h * 0.12);
  const billW = h * BILL_RATIO;
  const out = [];
  let x = 0;
  for (const { value, count } of parts.bills) {
    const shown = Math.min(count, maxStack);
    const step = h * 0.14; // the bills under the top one show only their edges
    for (let i = 0; i < shown; i++) out.push(billSVG(BILLS.find((b) => b.value === value), x + i * step, h));
    x += billW + (shown - 1) * step;
    if (count > shown) {
      const fs = h * 0.45;
      x += space;
      out.push(`<text x="${n(x)}" y="${n(h / 2 + fs * 0.35)}" font-size="${n(fs)}" font-family="system-ui, sans-serif" fill="currentColor">×${count}</text>`);
      x += fs * 0.62 * (String(count).length + 1);
    }
    x += space;
  }
  for (const { value, count } of parts.coins) {
    const coin = COINS.find((c) => c.value === value);
    const d = coin.mm * mm;
    for (let i = 0; i < count; i++) out.push(coinSVG(coin, x + d / 2 + i * d * 0.6, h / 2, d / 2, id));
    x += d + (count - 1) * d * 0.6 + space;
  }
  if (parts.fraction > 0 || (!parts.bills.length && !parts.coins.length)) {
    const d = COINS.find((c) => c.value === 1).mm * mm;
    out.push(pieSVG(parts.fraction, x + d / 2, h / 2, d / 2, id)); // nothing spent: a faint penny
    x += d + space;
  }
  const width = Math.max(1, x - space);
  const name = label ?? `${formatUSD(amount)}: ${describe(parts)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(h)}" viewBox="0 0 ${n(width)} ${n(h)}" role="img" aria-label="${esc(name)}">` +
    `<defs>${gradients(id)}</defs>${out.join("")}</svg>`;
}

/**
 * Register the <us-cash> element (once; later calls return the same class). Attributes: amount
 * (dollars), size, coins, bills, max-stack, label. The `amount` property reads and sets the amount.
 */
export function defineUsCash(tag = "us-cash") {
  const known = customElements.get(tag);
  if (known) return known;
  class UsCash extends HTMLElement {
    static observedAttributes = ["amount", "size", "coins", "bills", "max-stack", "label"];

    constructor() {
      super();
      this.attachShadow({ mode: "open" }).innerHTML = "<style>:host{display:inline-flex;align-items:center;line-height:0;vertical-align:middle}svg{display:block}</style><span></span>";
      this.drawn = null;
    }

    get amount() { return Number(this.getAttribute("amount")) || 0; }
    set amount(v) { this.setAttribute("amount", String(v)); }

    connectedCallback() { this.render(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }

    render() {
      const list = (name) => this.getAttribute(name)?.split(/[\s,]+/).filter(Boolean).map(Number);
      const options = {
        size: Number(this.getAttribute("size")) || 24,
        maxStack: Number(this.getAttribute("max-stack")) || 3,
        ...(list("coins") ? { coins: list("coins") } : {}),
        ...(list("bills") ? { bills: list("bills") } : {}),
        ...(this.hasAttribute("label") ? { label: this.getAttribute("label") } : {}),
      };
      const key = JSON.stringify([this.amount, options]);
      if (key === this.drawn) return;
      this.drawn = key;
      this.shadowRoot.querySelector("span").innerHTML = cashSVG(this.amount, options);
    }
  }
  customElements.define(tag, UsCash);
  return UsCash;
}
