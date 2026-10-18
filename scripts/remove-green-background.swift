import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 3 else { exit(2) }
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(1) }
let width = image.width, height = image.height, row = width * 4
var pixels = [UInt8](repeating: 0, count: height * row)
let space = CGColorSpaceCreateDeviceRGB()
guard let context = CGContext(data: &pixels, width: width, height: height,
    bitsPerComponent: 8, bytesPerRow: row, space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
for offset in stride(from: 0, to: pixels.count, by: 4) {
  let alpha = Double(pixels[offset + 3]) / 255.0
  if alpha == 0 { continue }
  let red = Double(pixels[offset]) / alpha
  let green = Double(pixels[offset + 1]) / alpha
  let blue = Double(pixels[offset + 2]) / alpha
  let excess = (green - max(red, blue)) / 255.0
  if excess > 0.08 {
    let factor = 1.0 - min(max((excess - 0.08) / 0.22, 0.0), 1.0)
    let newAlpha = alpha * factor
    let neutralGreen = min(green, max(red, blue))
    pixels[offset] = UInt8(min(255, red * newAlpha))
    pixels[offset + 1] = UInt8(min(255, neutralGreen * newAlpha))
    pixels[offset + 2] = UInt8(min(255, blue * newAlpha))
    pixels[offset + 3] = UInt8(min(255, newAlpha * 255.0))
  }
}
guard let resultContext = CGContext(data: &pixels, width: width, height: height,
    bitsPerComponent: 8, bytesPerRow: row, space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
      let result = resultContext.makeImage(),
      let destination = CGImageDestinationCreateWithURL(
        output as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(destination, result, nil)
guard CGImageDestinationFinalize(destination) else { exit(1) }
