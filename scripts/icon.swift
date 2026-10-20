import AppKit

let output = CommandLine.arguments[1]
let size = 1024
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let shape = NSBezierPath(roundedRect: NSRect(x: 80, y: 80, width: 864, height: 864), xRadius: 195, yRadius: 195)
NSColor(calibratedRed: 0.94, green: 0.93, blue: 0.89, alpha: 1).setFill()
shape.fill()
NSColor(calibratedRed: 0.79, green: 0.81, blue: 0.74, alpha: 1).setStroke()
shape.lineWidth = 2
shape.stroke()
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont(name: "Georgia-Italic", size: 680)!,
    .foregroundColor: NSColor(calibratedRed: 0.28, green: 0.39, blue: 0.31, alpha: 1)
]
("d" as NSString).draw(at: NSPoint(x: 270, y: 92), withAttributes: attributes)
NSColor(calibratedRed: 0.28, green: 0.31, blue: 0.25, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 675, y: 310, width: 60, height: 60)).fill()
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
