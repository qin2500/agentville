// Draws the 1024px app icon: a pixel-art house with a lead's banner and a villager asking "!",
// at night, in the app's own palette (docs/DESIGN.md). Usage: swift DrawIcon.swift out.png
import AppKit

let map = [
    "................................",
    "................................",
    "..e.....................yy......",
    "..........e............yyyy.....",
    ".......................yyyy..e..",
    "....e........ccc........yy......",
    "............occc................",
    "............o...........e.......",
    "............o...................",
    "...........oooo.................",
    "..........orrrro.......eee......",
    ".........orrrrrro......eRe......",
    "........orrrrrrrro.....eRe......",
    ".......orrrrrrrrrro....eee......",
    "......orrrrrrrrrrrro...eRe......",
    ".....oooooooooooooooo..eee......",
    "......oWWWWWWWWWWWWo....e.......",
    "......oWooooWWWWWWWo............",
    "......oWoyyoWWooooWo...hhh......",
    "......oWoyyoWWowwoWo...oko......",
    "......oWooooWWowwoWo..kccck.....",
    "......oWWWWWWWowyoWo...ccc......",
    "......oWWWWWWWowwoWo...hhh......",
    "......oooooooooooooo...h.h......",
    "GGGGGGGGGGGGGGppppGGGGGGGGGGGGGG",
    "GGggGGggGGggGGppppggGGggGGggGGgg",
    "ggGGggGGggGGgppppppGggGGggGGggGG",
    "GGggGGggGGggGppppppgGGggGGggGGgg",
    "ggGGggGGggGGppppppppggGGggGGggGG",
    "GGggGGggGGggppppppppGGggGGggGGgg",
    "ggGGggGGggGppppppppppGggGGggGGgg",
    "GGggGGggGGgppppppppppgGGggGGggGG",
]
let palette: [Character: UInt32] = [
    "o": 0x1a1c22, "g": 0x3b5d3a, "G": 0x4f7a4a, "p": 0x8a7353, "w": 0x6b4428, "W": 0x9a6a3e,
    "r": 0x9c3f35, "k": 0xe8b48a, "h": 0x4a3426, "y": 0xf2c14e, "e": 0xf4efe4, "R": 0xff7262,
    "c": 0xc96442,
]
func color(_ hex: UInt32) -> NSColor {
    NSColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
}

let size = 1024, cell: CGFloat = 26, origin: CGFloat = (1024 - 26 * 32) / 2
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current!.imageInterpolation = .none
let tile = NSBezierPath(roundedRect: NSRect(x: origin, y: origin, width: cell * 32, height: cell * 32), xRadius: 185, yRadius: 185)
NSGradient(starting: color(0x2b3150), ending: color(0x0f1115))!.draw(in: tile, angle: -90)
tile.addClip()
for (row, line) in map.enumerated() {
    for (col, ch) in line.enumerated() {
        guard let hex = palette[ch] else { continue }
        color(hex).setFill()
        NSRect(x: origin + CGFloat(col) * cell, y: origin + CGFloat(31 - row) * cell, width: cell, height: cell).fill()
    }
}
NSGraphicsContext.restoreGraphicsState()
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
