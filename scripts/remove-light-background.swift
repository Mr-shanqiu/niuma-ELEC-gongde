import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 3 else {
  fputs("usage: remove-light-background.swift INPUT OUTPUT\n", stderr)
  exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

guard
  let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  fputs("unable to read input image\n", stderr)
  exit(1)
}

let width = image.width
let height = image.height
let bytesPerRow = width * 4
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue |
  CGImageAlphaInfo.premultipliedLast.rawValue
var pixels = [UInt8](repeating: 0, count: height * bytesPerRow)

guard let context = CGContext(
  data: &pixels,
  width: width,
  height: height,
  bitsPerComponent: 8,
  bytesPerRow: bytesPerRow,
  space: colorSpace,
  bitmapInfo: bitmapInfo
) else {
  fputs("unable to create bitmap context\n", stderr)
  exit(1)
}

context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

let pixelCount = width * height
var background = [Bool](repeating: false, count: pixelCount)
var queue: [Int] = []

func isBackgroundCandidate(_ pixel: Int) -> Bool {
  let offset = pixel * 4
  let red = Int(pixels[offset])
  let green = Int(pixels[offset + 1])
  let blue = Int(pixels[offset + 2])
  let maximum = max(red, green, blue)
  let minimum = min(red, green, blue)
  let chroma = maximum - minimum
  let brightness = (red + green + blue) / 3
  return brightness >= 190 && chroma <= 75
}

func enqueue(_ pixel: Int) {
  guard pixel >= 0, pixel < pixelCount else { return }
  guard !background[pixel], isBackgroundCandidate(pixel) else { return }
  background[pixel] = true
  queue.append(pixel)
}

for x in 0..<width {
  enqueue(x)
  enqueue((height - 1) * width + x)
}
for y in 0..<height {
  enqueue(y * width)
  enqueue(y * width + width - 1)
}

var queueIndex = 0
while queueIndex < queue.count {
  let pixel = queue[queueIndex]
  queueIndex += 1
  let x = pixel % width
  let y = pixel / width
  if x > 0 { enqueue(pixel - 1) }
  if x + 1 < width { enqueue(pixel + 1) }
  if y > 0 { enqueue(pixel - width) }
  if y + 1 < height { enqueue(pixel + width) }
}

for pixel in 0..<pixelCount where background[pixel] {
  let offset = pixel * 4
  pixels[offset] = 0
  pixels[offset + 1] = 0
  pixels[offset + 2] = 0
  pixels[offset + 3] = 0
}

guard
  let outputContext = CGContext(
    data: &pixels,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: bytesPerRow,
    space: colorSpace,
    bitmapInfo: bitmapInfo
  ),
  let outputImage = outputContext.makeImage(),
  let destination = CGImageDestinationCreateWithURL(
    outputURL as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
  )
else {
  fputs("unable to create output image\n", stderr)
  exit(1)
}

CGImageDestinationAddImage(destination, outputImage, nil)
guard CGImageDestinationFinalize(destination) else {
  fputs("unable to write output image\n", stderr)
  exit(1)
}
