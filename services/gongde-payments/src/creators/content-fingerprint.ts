import { createHash } from "node:crypto";
import type { ValidatedCreatorPack } from "./pack-validation.js";
import { normalizeCreatorSourceArchive } from "./source-normalization.js";

/** Input PNGs have passed the existing canonical PNG normalizer. Names and
 * ownership are deliberately absent; image references use normalized bytes. */
export function creatorContentFingerprint(pack: ValidatedCreatorPack): string {
  const images = new Map([...pack.files].filter(([name]) => name !== "manifest.json").map(([name, bytes]) =>
    [name, createHash("sha256").update(bytes).digest("hex")]));
  const manifest = pack.manifest;
  const layout = {
    canvas: [manifest.canvas_width, manifest.canvas_height, manifest.plus_y],
    preview: images.get(manifest.preview),
    images: [...new Set(images.values())].sort(),
    layers: manifest.layers.map(layer => ({ image: images.get(layer.image), frame: layer.frame, anchor: layer.anchor,
      interpolation: "interpolation" in layer ? layer.interpolation : "linear",
      keyframes: layer.keyframes.map(frame => ({ t: frame.t, x: frame.x, y: frame.y, rotation: frame.rotation,
        scale: frame.scale, scaleY: "scale_y" in frame ? frame.scale_y : frame.scale, alpha: frame.alpha })) }))
  };
  return createHash("sha256").update("gongde-creator-content-v1\0", "utf8")
    .update(JSON.stringify(layout), "utf8").digest("hex");
}

export function creatorSourceContentFingerprint(archive: Buffer, owner: { creatorId: string; slug: string }): string {
  return creatorContentFingerprint(normalizeCreatorSourceArchive(archive, owner).pack);
}
