import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private enum HelperOutput: String {
    case ready = "READY"
    case appNotRunning = "APP_NOT_RUNNING"
    case screenLocked = "SCREEN_LOCKED"
    case windowUnavailable = "WINDOW_UNAVAILABLE"
    case automationFailed = "AUTOMATION_FAILED"
}

private struct OwnedWindow {
    let bounds: CGRect
}

private let minimumWindowWidth: CGFloat = 900
private let minimumWindowHeight: CGFloat = 650

private func finish(_ output: HelperOutput) -> Never {
    print(output.rawValue)
    // The status is the machine-readable contract; keep it on stdout even for
    // expected unavailable states so the TypeScript adapter can classify them.
    exit(0)
}

private func runningApplication(for sourceID: String) -> NSRunningApplication? {
    let processNames: Set<String>
    let bundleIdentifiers: Set<String>
    switch sourceID {
    case "qq_music":
        processNames = ["QQMusic", "QQ音乐"]
        bundleIdentifiers = ["com.tencent.QQMusicMac", "com.tencent.QQMusic"]
    case "netease_music":
        processNames = ["NeteaseMusic", "网易云音乐", "cloudmusic"]
        bundleIdentifiers = ["com.netease.163music", "com.netease.cloudmusic"]
    default:
        return nil
    }

    let applications = NSWorkspace.shared.runningApplications
    return applications.first(where: { application in
        if let bundleIdentifier = application.bundleIdentifier, bundleIdentifiers.contains(bundleIdentifier) {
            return true
        }
        if let localizedName = application.localizedName, processNames.contains(localizedName) {
            return true
        }
        return processNames.contains(application.executableURL?.deletingPathExtension().lastPathComponent ?? "")
    })
}

private func isScreenLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return false
    }
    return (session["CGSSessionScreenIsLocked"] as? Bool) == true
        || (session["CGSSessionScreenIsLocked"] as? Int) == 1
}

private func restoreMinimizedWindows(for application: NSRunningApplication) {
    let accessibilityApplication = AXUIElementCreateApplication(application.processIdentifier)
    var windowsValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(accessibilityApplication, kAXWindowsAttribute as CFString, &windowsValue) == .success,
          let windows = windowsValue as? [AXUIElement] else {
        return
    }
    for window in windows {
        var minimizedValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimizedValue) == .success,
              (minimizedValue as? Bool) == true else {
            continue
        }
        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }
}

private func largestOwnedWindow(for application: NSRunningApplication) -> OwnedWindow? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }

    let pid = application.processIdentifier
    var largest: OwnedWindow?
    var largestArea: CGFloat = 0
    for info in windowList {
        guard let ownerPID = info[kCGWindowOwnerPID as String] as? Int,
              ownerPID == Int(pid),
              let layer = info[kCGWindowLayer as String] as? Int,
              layer == 0,
              let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary else {
            continue
        }

        var bounds = CGRect.zero
        guard CGRectMakeWithDictionaryRepresentation(boundsDictionary as CFDictionary, &bounds),
              bounds.width >= minimumWindowWidth,
              bounds.height >= minimumWindowHeight else {
            continue
        }
        let area = bounds.width * bounds.height
        if area > largestArea {
            largestArea = area
            largest = OwnedWindow(bounds: bounds)
        }
    }
    return largest
}

private func sleepMillis(_ milliseconds: UInt32) {
    usleep(milliseconds * 1_000)
}

private func postMouse(_ type: CGEventType, at point: CGPoint, clickState: Int64 = 0) -> Bool {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
        return false
    }
    if clickState > 0 {
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
    }
    event.post(tap: .cghidEventTap)
    return true
}

private func click(at point: CGPoint, count: Int = 1) -> Bool {
    guard postMouse(.mouseMoved, at: point) else { return false }
    for clickIndex in 1...count {
        let state = count > 1 ? Int64(clickIndex) : 0
        guard postMouse(.leftMouseDown, at: point, clickState: state), postMouse(.leftMouseUp, at: point, clickState: state) else {
            return false
        }
        if count > 1 { sleepMillis(80) }
    }
    return true
}

private func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) -> Bool {
    guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
        return false
    }
    keyDown.flags = flags
    keyUp.flags = flags
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
    return true
}

private func postUnicodeText(_ text: String) -> Bool {
    let utf16 = Array(text.utf16)
    guard utf16.count <= 65_535,
          let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else {
        return false
    }
    // Unicode text is carried only by the key-down event. A raw key-up with the
    // text payload can duplicate or corrupt CJK input in both clients.
    utf16.withUnsafeBufferPointer { buffer in
        event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
    }
    event.post(tap: .cghidEventTap)
    return true
}

private func relativePoint(_ bounds: CGRect, x: CGFloat, y: CGFloat) -> CGPoint {
    CGPoint(x: bounds.minX + x, y: bounds.minY + y)
}

private func normalizedPoint(_ bounds: CGRect, x: CGFloat, y: CGFloat) -> CGPoint {
    CGPoint(x: bounds.minX + (x / 1_125) * bounds.width, y: bounds.minY + (y / 768) * bounds.height)
}

private func prepareSearch(in bounds: CGRect, query: String, point: CGPoint) -> Bool {
    guard click(at: point) else { return false }
    sleepMillis(300)
    guard postKey(0, flags: .maskCommand) else { return false }
    sleepMillis(300)
    guard postKey(51) else { return false }
    sleepMillis(300)
    guard postUnicodeText(query) else { return false }
    sleepMillis(300)
    guard postKey(36) else { return false }
    sleepMillis(1_800)
    return true
}

private func runNetease(query: String, bounds: CGRect) -> Bool {
    // The player-only view replaces the search bar. Its fixed top-left chevron
    // closes that view; the same point is inert in the normal title bar.
    guard click(at: relativePoint(bounds, x: 84, y: 16)) else { return false }
    sleepMillis(500)
    let searchPoint = relativePoint(bounds, x: 390, y: 50)
    guard prepareSearch(in: bounds, query: query, point: searchPoint) else { return false }
    guard click(at: relativePoint(bounds, x: 300, y: 280), count: 2) else { return false }
    sleepMillis(1_800)
    // Play a visible track directly. "Play all" can select an entitlement-
    // blocked first track and immediately return the client to an idle state.
    guard click(at: relativePoint(bounds, x: 500, y: 444), count: 2) else { return false }
    sleepMillis(1_000)
    return true
}

private func runQQ(query: String, bounds: CGRect) -> Bool {
    let searchPoint = normalizedPoint(bounds, x: 400, y: 40)
    guard prepareSearch(in: bounds, query: query, point: searchPoint) else { return false }
    guard click(at: normalizedPoint(bounds, x: 279, y: 177)) else { return false }
    sleepMillis(700)
    return true
}

private func run(sourceID: String, query: String) -> HelperOutput {
    guard sourceID == "qq_music" || sourceID == "netease_music" else {
        return .automationFailed
    }
    if isScreenLocked() {
        return .screenLocked
    }
    guard let application = runningApplication(for: sourceID) else {
        return .appNotRunning
    }
    application.unhide()
    restoreMinimizedWindows(for: application)
    application.activate(options: [.activateAllWindows])
    sleepMillis(800)
    guard let window = largestOwnedWindow(for: application) else {
        return .windowUnavailable
    }

    switch sourceID {
    case "qq_music":
        return runQQ(query: query, bounds: window.bounds) ? .ready : .automationFailed
    case "netease_music":
        return runNetease(query: query, bounds: window.bounds) ? .ready : .automationFailed
    default:
        return .automationFailed
    }
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else { finish(.automationFailed) }
let sourceID = arguments[1]
let query = arguments[2]
guard !query.isEmpty, query.utf8.count <= 64 else { finish(.automationFailed) }

finish(run(sourceID: sourceID, query: query))
