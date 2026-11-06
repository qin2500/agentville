// Agentville.app: runs the bundled launch.sh, and shows a dialog if the server can't start.
import AppKit
import Foundation

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    var opening = false
    func applicationDidFinishLaunching(_ notification: Notification) { openVillage() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openVillage()
        return false
    }
    func openVillage() {
        if opening { return }
        opening = true
        DispatchQueue.global().async {
            var failure: String? = nil
            if let script = Bundle.main.path(forResource: "launch", ofType: "sh") {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/bin/bash")
                process.arguments = [script]
                let output = Pipe()
                process.standardOutput = output
                process.standardError = output
                do {
                    try process.run()
                    let data = output.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    if process.terminationStatus != 0 { failure = String(data: data, encoding: .utf8) ?? "The local server could not start." }
                } catch { failure = error.localizedDescription }
            } else { failure = "launch.sh is missing from the app bundle. Rebuild the launcher." }
            let message = failure
            DispatchQueue.main.async {
                self.opening = false
                guard let message = message else { return }
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = "Agentville couldn’t open"
                alert.informativeText = message
                alert.alertStyle = .warning
                alert.addButton(withTitle: "OK")
                alert.runModal()
                NSApp.terminate(nil)
            }
        }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = LauncherDelegate()
app.delegate = delegate
app.run()
