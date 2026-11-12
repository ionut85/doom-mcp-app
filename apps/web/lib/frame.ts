import { PNG } from "pngjs";
import { upscale } from "@doom-player/doom-core/core";

/** RGBA frame → PNG bytes, nearest-neighbour upscaled by `scale`. */
export function encodePng(rgba: Uint8ClampedArray, width: number, height: number, scale = 2): Buffer {
  const px = scale === 1 ? rgba : upscale(rgba, width, height, scale);
  const png = new PNG({ width: width * scale, height: height * scale });
  png.data = Buffer.from(px.buffer, px.byteOffset, px.byteLength);
  return PNG.sync.write(png, { colorType: 2 });
}
