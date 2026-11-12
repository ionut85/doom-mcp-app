import fs from "node:fs";
import path from "node:path";

export { randomLog } from "../src/selftest.ts";

const root = path.resolve(import.meta.dirname, "../../..");
export const WAD = fs.readFileSync(process.env.DOOM_IWAD ?? path.join(root, "wads/freedoom1.wad"));
