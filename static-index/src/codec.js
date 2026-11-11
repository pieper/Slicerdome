// Binary decoding helpers: varint postings and gzip members.

/**
 * Decode `count` (doc-gap, tf) varint pairs from a term's postings bytes.
 * The first doc id is absolute, later ones are gaps from the previous one.
 */
export function decodePostings(bytes, count) {
  const docs = new Uint32Array(count);
  const tfs = new Uint32Array(count);
  let p = 0;
  let doc = 0;
  for (let i = 0; i < count; i++) {
    let v = 0;
    let mul = 1;
    let b;
    do {
      b = bytes[p++];
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    doc = i === 0 ? v : doc + v;
    let tf = 0;
    mul = 1;
    do {
      b = bytes[p++];
      tf += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    docs[i] = doc;
    tfs[i] = tf;
  }
  return { docs, tfs };
}

const utf8 = new TextDecoder("utf-8");

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipText(bytes) {
  return utf8.decode(await gunzip(bytes));
}

export async function gunzipJson(bytes) {
  return JSON.parse(await gunzipText(bytes));
}

export function decodeText(bytes) {
  return utf8.decode(bytes);
}

/** Prefix sums: sizes [a, b, c] -> offsets [0, a, a+b, a+b+c]. */
export function offsets(sizes) {
  const out = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) out[i + 1] = out[i] + sizes[i];
  return out;
}
