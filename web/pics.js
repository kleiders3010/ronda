// Pictures on questions (like Kahoot's question image): kept on this device only, in IndexedDB (localStorage is
// too small for pictures), and shown only on the host's big screen; never sent to the server, never in a share
// link. A question holds a key ("p:<hash>"); a saved file carries the picture itself (a data: URL).
const DB = "ronda-pics", STORE = "pics";
const MAX_SIDE = 1280; // longest side after shrinking: sharp on a projector, small on the device
const cache = new Map();
let dbp = null;

function db() {
  dbp ||= new Promise((ok, bad) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((ok, bad) => {
    const x = d.transaction(STORE, mode);
    const req = fn(x.objectStore(STORE));
    x.oncomplete = () => ok(req?.result);
    x.onerror = () => bad(x.error);
  });
}

export const isPic = (k) => typeof k === "string" && /^p:[0-9a-f]{24}$/.test(k);

/** Stores a data: URL and returns its key (the same picture twice is kept once). */
export async function putPic(dataUrl) {
  const bytes = new TextEncoder().encode(dataUrl);
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = "p:" + h;
  await tx("readwrite", (s) => s.put(dataUrl, key));
  cache.set(key, dataUrl);
  return key;
}

/** The picture's data: URL, or null when this device doesn't have it. */
export async function getPic(key) {
  if (!isPic(key)) return null;
  if (cache.has(key)) return cache.get(key);
  try {
    const v = (await tx("readonly", (s) => s.get(key))) ?? null;
    if (v) cache.set(key, v);
    return v;
  } catch { return null; }
}

/** Drops pictures no saved ronda uses any more. */
export async function keepOnly(keys) {
  try {
    const all = await tx("readonly", (s) => s.getAllKeys());
    const gone = (all || []).filter((k) => !keys.has(k));
    if (gone.length) await tx("readwrite", (s) => { for (const k of gone) s.delete(k); });
    for (const k of gone) cache.delete(k);
  } catch {}
}

/** A picture file (or a pasted one) shrunk to MAX_SIDE, as a data: URL; null if it isn't a picture. */
export async function shrink(file) {
  if (!file || !/^image\//.test(file.type)) return null;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return null; }
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const webp = c.toDataURL("image/webp", 0.82);
  return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/jpeg", 0.85);
}
