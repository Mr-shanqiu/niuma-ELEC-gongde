// Render the resting pose from the pack, never independently position artwork.
// Usage: swift scripts/render-appearance-preview.swift <pack-directory>
import AppKit
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf:
    directory.appendingPathComponent("manifest.json"))) as! [String: Any]
let layers = manifest["layers"] as! [[String: Any]]
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 480,
    pixelsHigh: 340, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
    isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
bitmap.size = NSSize(width: 240, height: 170)
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
let bounds = NSRect(x: 0, y: 0, width: 240, height: 170)
NSColor.clear.setFill()
bounds.fill(using: .copy)
NSBezierPath(rect: bounds).addClip()
for layer in layers {
    let r = layer["frame"] as! [Double]
    let anchor = layer["anchor"] as! [Double]
    let key = (layer["keyframes"] as! [[String: Double]])[0]
    let ax = r[0] + r[2] * anchor[0], ay = r[1] + r[3] * anchor[1]
    let image = NSImage(contentsOf: directory.appendingPathComponent(layer["image"] as! String))!
    NSGraphicsContext.saveGraphicsState()
    let transform = NSAffineTransform()
    transform.translateX(by: ax + key["x"]!, yBy: ay + key["y"]!)
    transform.rotate(byDegrees: key["rotation"]!)
    transform.scaleX(by: key["scale"]!, yBy: key["scale"]! * (key["scale_y"] ?? 1))
    transform.translateX(by: -ax, yBy: -ay)
    transform.concat()
    image.draw(in: NSRect(x: r[0], y: r[1], width: r[2], height: r[3]),
        from: .zero, operation: .sourceOver, fraction: key["alpha"]!,
        respectFlipped: false, hints: nil)
    NSGraphicsContext.restoreGraphicsState()
}
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to:
    directory.appendingPathComponent(manifest["preview"] as! String))
