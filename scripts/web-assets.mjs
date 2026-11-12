// Copies the browser runtime into apps/web/public/doom/ with content-hashed
// names: the Emscripten glue, the wasm, and the IWAD gzipped (the browser
// inflates it with DecompressionStream). manifest.json maps logical names to
// files, so everything else can be cached forever.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "apps/web/public/doom");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 10);
function emit(name, ext, buf) {
  const file = `${name}.${hash(buf)}${ext}`;
  fs.writeFileSync(path.join(out, file), buf);
  return file;
}

const wasm = fs.readFileSync(path.join(root, "engine/dist/doom.wasm"));
const glue = fs.readFileSync(path.join(root, "engine/dist/doom.mjs"));
const wadPath = process.env.DOOM_IWAD ?? path.join(root, "wads/freedoom1.wad");
const wad = fs.readFileSync(wadPath);
const manifest = {
  glue: emit("doom", ".mjs", glue),
  wasm: emit("doom", ".wasm", wasm),
  wad: emit(path.basename(wadPath, ".wad"), ".wad.gz", zlib.gzipSync(wad, { level: 9 })),
  wadBytes: wad.length,
  wadSha256: createHash("sha256").update(wad).digest("hex"),
};
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("web assets:", manifest.glue, manifest.wasm, manifest.wad);
