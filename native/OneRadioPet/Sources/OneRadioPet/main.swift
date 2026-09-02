import AppKit
import Darwin
import Foundation

private struct PetState: Decodable, Equatable {
    let version: Int
    let programId: String
    let generation: Int
    let profileId: String
    let mood: String
    let message: String
    let speechDurationSeconds: Double?
    let revision: Int
    let updatedAt: String
    let ownerPid: Int32
    let instanceId: String
}

private struct ProfileAssets {
    let staticFile: String
    let animatedDirectory: String
}

private let profileAssets: [String: ProfileAssets] = [
    "anxuan": ProfileAssets(staticFile: "long-anxuan.png", animatedDirectory: "anxuan"),
    "anran": ProfileAssets(staticFile: "long-anran.png", animatedDirectory: "anran"),
    "anya": ProfileAssets(staticFile: "long-anya.png", animatedDirectory: "anya"),
    "xiaocheng": ProfileAssets(staticFile: "long-xiaocheng.png", animatedDirectory: "xiaocheng"),
    "longxin": ProfileAssets(staticFile: "long-xin.png", animatedDirectory: "longxin"),
    "longhao": ProfileAssets(staticFile: "long-hao.png", animatedDirectory: "longhao"),
]

private enum PetScale: String, CaseIterable {
    case small
    case medium
    case large

    var windowSize: NSSize {
        switch self {
        case .small: NSSize(width: 280, height: 310)
        case .medium: NSSize(width: 340, height: 370)
        case .large: NSSize(width: 410, height: 445)
        }
    }

    func speakingWindowSize(for message: String) -> NSSize {
        let bubble = bubbleSize(for: message)
        return switch self {
        case .small: NSSize(width: bubble.width + characterSize.width + 44, height: 310)
        case .medium: NSSize(width: bubble.width + characterSize.width + 46, height: 370)
        case .large: NSSize(width: bubble.width + characterSize.width + 48, height: 445)
        }
    }

    func bubbleSize(for message: String) -> NSSize {
        let units = displayUnits(in: message)
        switch self {
        case .small:
            let width = units > 80 ? 300.0 : (units > 38 ? 260.0 : 210.0)
            let rows = min(8.0, max(2.0, ceil(units / (width > 280 ? 25.0 : (width > 230 ? 21.0 : 16.0)))))
            return NSSize(width: width, height: min(158.0, max(74.0, 24.0 + rows * 16.0)))
        case .medium:
            let width = units > 80 ? 360.0 : (units > 38 ? 310.0 : 248.0)
            let rows = min(8.0, max(2.0, ceil(units / (width > 330 ? 28.0 : (width > 280 ? 24.0 : 18.0)))))
            return NSSize(width: width, height: min(184.0, max(90.0, 28.0 + rows * 18.0)))
        case .large:
            let width = units > 80 ? 420.0 : (units > 38 ? 360.0 : 286.0)
            let rows = min(8.0, max(2.0, ceil(units / (width > 390 ? 31.0 : (width > 330 ? 27.0 : 21.0)))))
            return NSSize(width: width, height: min(214.0, max(106.0, 32.0 + rows * 21.0)))
        }
    }

    var characterSize: NSSize {
        switch self {
        case .small: NSSize(width: 118, height: 176)
        case .medium: NSSize(width: 158, height: 228)
        case .large: NSSize(width: 200, height: 286)
        }
    }
}

private func displayUnits(in message: String) -> Double {
    message.reduce(0.0) { total, character in
        guard let scalar = character.unicodeScalars.first else { return total + 1.0 }
        if CharacterSet.whitespacesAndNewlines.contains(scalar) { return total + 0.35 }
        if scalar.isASCII { return total + 0.55 }
        return total + 1.0
    }
}

private enum AnimationMode: String {
    case idle = "music"
    case speaking
}

private struct AnimationBeat {
    let frame: Int
    let ticks: Int
}

private struct HostMotion {
    let idle: [AnimationBeat]
    let speaking: [AnimationBeat]

    func beats(for mode: AnimationMode) -> [AnimationBeat] {
        mode == .speaking ? speaking : idle
    }
}

private let hostMotions: [String: HostMotion] = [
    "anxuan": HostMotion(
        idle: [.init(frame: 0, ticks: 12), .init(frame: 1, ticks: 2), .init(frame: 2, ticks: 14), .init(frame: 4, ticks: 2), .init(frame: 5, ticks: 13)],
        speaking: [.init(frame: 0, ticks: 3), .init(frame: 1, ticks: 2), .init(frame: 2, ticks: 3), .init(frame: 1, ticks: 2), .init(frame: 4, ticks: 2), .init(frame: 2, ticks: 3), .init(frame: 5, ticks: 3)]
    ),
    "anran": HostMotion(
        idle: [.init(frame: 0, ticks: 8), .init(frame: 1, ticks: 2), .init(frame: 2, ticks: 8), .init(frame: 3, ticks: 7), .init(frame: 4, ticks: 2), .init(frame: 5, ticks: 8)],
        speaking: [.init(frame: 0, ticks: 3), .init(frame: 1, ticks: 2), .init(frame: 4, ticks: 2), .init(frame: 1, ticks: 2), .init(frame: 5, ticks: 4)]
    ),
    "anya": HostMotion(
        idle: [.init(frame: 0, ticks: 15), .init(frame: 1, ticks: 2), .init(frame: 2, ticks: 15), .init(frame: 3, ticks: 8), .init(frame: 4, ticks: 2), .init(frame: 5, ticks: 12)],
        speaking: [.init(frame: 0, ticks: 4), .init(frame: 1, ticks: 3), .init(frame: 2, ticks: 3), .init(frame: 3, ticks: 3), .init(frame: 4, ticks: 3), .init(frame: 5, ticks: 4)]
    ),
    "xiaocheng": HostMotion(
        idle: [.init(frame: 0, ticks: 16), .init(frame: 1, ticks: 3), .init(frame: 2, ticks: 14), .init(frame: 3, ticks: 9), .init(frame: 4, ticks: 3), .init(frame: 5, ticks: 13)],
        speaking: [.init(frame: 0, ticks: 4), .init(frame: 1, ticks: 3), .init(frame: 3, ticks: 3), .init(frame: 1, ticks: 3), .init(frame: 5, ticks: 5)]
    ),
    "longxin": HostMotion(
        idle: [.init(frame: 0, ticks: 18), .init(frame: 1, ticks: 4), .init(frame: 2, ticks: 4), .init(frame: 3, ticks: 5), .init(frame: 4, ticks: 4), .init(frame: 5, ticks: 18)],
        speaking: [.init(frame: 0, ticks: 4), .init(frame: 1, ticks: 3), .init(frame: 2, ticks: 3), .init(frame: 3, ticks: 4), .init(frame: 4, ticks: 3), .init(frame: 2, ticks: 2), .init(frame: 1, ticks: 3), .init(frame: 5, ticks: 5)]
    ),
    "longhao": HostMotion(
        idle: [.init(frame: 0, ticks: 14), .init(frame: 1, ticks: 2), .init(frame: 2, ticks: 13), .init(frame: 3, ticks: 8), .init(frame: 4, ticks: 2), .init(frame: 5, ticks: 12)],
        speaking: [.init(frame: 0, ticks: 4), .init(frame: 1, ticks: 3), .init(frame: 3, ticks: 2), .init(frame: 4, ticks: 3), .init(frame: 1, ticks: 3), .init(frame: 5, ticks: 4)]
    ),
]

@MainActor
private final class DraggableHostImageView: NSImageView {
    var openRadio: (() -> Void)?
    var showContextMenu: ((NSEvent) -> Void)?
    var didMoveWindow: (() -> Void)?
    private var pointerDownAt: NSPoint?
    private var windowOriginAtPointerDown: NSPoint?
    private var didDrag = false

    override var acceptsFirstResponder: Bool { true }

    override func isAccessibilityElement() -> Bool { true }

    override func accessibilityRole() -> NSAccessibility.Role? { .button }

    override func accessibilityLabel() -> String? { "打开 ONE RADIO" }

    override func accessibilityHelp() -> String? { "单击打开网页电台，拖动可移动桌面主持人" }

    override func accessibilityPerformPress() -> Bool {
        openRadio?()
        return true
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        pointerDownAt = NSEvent.mouseLocation
        windowOriginAtPointerDown = window?.frame.origin
        didDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let startPointer = pointerDownAt, let startOrigin = windowOriginAtPointerDown, let window else { return }
        let pointer = NSEvent.mouseLocation
        let delta = NSPoint(x: pointer.x - startPointer.x, y: pointer.y - startPointer.y)
        if abs(delta.x) + abs(delta.y) > 3 { didDrag = true }
        window.setFrameOrigin(NSPoint(x: startOrigin.x + delta.x, y: startOrigin.y + delta.y))
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            pointerDownAt = nil
            windowOriginAtPointerDown = nil
        }
        if didDrag {
            didMoveWindow?()
        } else {
            openRadio?()
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        showContextMenu?(event)
    }
}

@MainActor
private final class SpeechBubbleView: NSView {
    static let tailWidth: CGFloat = 28

    private let scrollView = NSScrollView()
    private let textView = NSTextView()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor

        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .noBorder
        addSubview(scrollView)

        textView.isEditable = false
        textView.isSelectable = false
        textView.drawsBackground = false
        textView.textColor = NSColor(calibratedWhite: 0.06, alpha: 1)
        textView.textContainerInset = NSSize(width: 10, height: 8)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        scrollView.documentView = textView
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        let inset: CGFloat = 1
        let radius: CGFloat = 9
        let bodyMaxX = bounds.width - Self.tailWidth
        let midY = bounds.midY
        let tailHalfHeight: CGFloat = 12
        let path = NSBezierPath()

        path.move(to: NSPoint(x: inset + radius, y: inset))
        path.line(to: NSPoint(x: bodyMaxX - radius, y: inset))
        path.curve(
            to: NSPoint(x: bodyMaxX - inset, y: inset + radius),
            controlPoint1: NSPoint(x: bodyMaxX - radius * 0.45, y: inset),
            controlPoint2: NSPoint(x: bodyMaxX - inset, y: inset + radius * 0.45)
        )
        path.line(to: NSPoint(x: bodyMaxX - inset, y: midY - tailHalfHeight))
        path.line(to: NSPoint(x: bounds.width - inset, y: midY))
        path.line(to: NSPoint(x: bodyMaxX - inset, y: midY + tailHalfHeight))
        path.line(to: NSPoint(x: bodyMaxX - inset, y: bounds.height - inset - radius))
        path.curve(
            to: NSPoint(x: bodyMaxX - radius, y: bounds.height - inset),
            controlPoint1: NSPoint(x: bodyMaxX - inset, y: bounds.height - inset - radius * 0.45),
            controlPoint2: NSPoint(x: bodyMaxX - radius * 0.45, y: bounds.height - inset)
        )
        path.line(to: NSPoint(x: inset + radius, y: bounds.height - inset))
        path.curve(
            to: NSPoint(x: inset, y: bounds.height - inset - radius),
            controlPoint1: NSPoint(x: inset + radius * 0.45, y: bounds.height - inset),
            controlPoint2: NSPoint(x: inset, y: bounds.height - inset - radius * 0.45)
        )
        path.line(to: NSPoint(x: inset, y: inset + radius))
        path.curve(
            to: NSPoint(x: inset + radius, y: inset),
            controlPoint1: NSPoint(x: inset, y: inset + radius * 0.45),
            controlPoint2: NSPoint(x: inset + radius * 0.45, y: inset)
        )
        path.close()

        NSColor(calibratedWhite: 0.98, alpha: 1).setFill()
        path.fill()
        NSColor(calibratedWhite: 0.42, alpha: 1).setStroke()
        path.lineWidth = 1.35
        path.lineJoinStyle = .round
        path.stroke()
    }

    override func layout() {
        super.layout()
        scrollView.frame = NSRect(x: 0, y: 0, width: max(0, bounds.width - Self.tailWidth), height: bounds.height)
        refreshDocumentSize()
    }

    func configure(for scale: PetScale) {
        textView.font = NSFont.systemFont(ofSize: scale == .small ? 12 : (scale == .medium ? 13 : 14), weight: .medium)
        refreshDocumentSize()
    }

    func setText(_ text: String) {
        textView.string = text
        refreshDocumentSize()
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }

    private func refreshDocumentSize() {
        let contentWidth = bounds.width - Self.tailWidth
        guard contentWidth > 0, let layoutManager = textView.layoutManager, let textContainer = textView.textContainer else { return }
        textContainer.containerSize = NSSize(width: max(1, contentWidth - 20), height: .greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        let textHeight = ceil(layoutManager.usedRect(for: textContainer).height) + 16
        textView.frame = NSRect(x: 0, y: 0, width: contentWidth, height: max(bounds.height, textHeight))
    }
}

@MainActor
private final class SpeechAccessibilityView: NSView {
    var message = ""

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func isAccessibilityElement() -> Bool { !message.isEmpty }

    override func accessibilityRole() -> NSAccessibility.Role? { .staticText }

    override func accessibilityLabel() -> String? { "主持人口播" }

    override func accessibilityValue() -> Any? { message }
}

@MainActor
private final class PetView: NSView {
    private let imageView = DraggableHostImageView()
    private let speechBubble = SpeechBubbleView()
    private let speechAccessibility = SpeechAccessibilityView()
    private var state: PetState?
    private var animationTimer: Timer?
    private var frameIndex = 0
    private var beatIndex = 0
    private var beatTick = 0
    private var currentProfileId = "anxuan"
    private var currentMode: AnimationMode = .idle
    private var frames: [NSImage] = []
    private var frameCache: [String: [NSImage]] = [:]
    private var assetUnavailable = false
    private var typingMessage = ""
    private var revealedCharacterCount = 0
    private var speechStartedAt = Date()
    private var speechRevealDuration: TimeInterval = 0
    private var bubbleVisible = false
    private let assetsDirectory: URL
    private let radioURL: URL
    private(set) var scale: PetScale
    var scaleDidChange: ((PetScale) -> Void)?
    var windowDidMove: (() -> Void)?
    var moodDidChange: ((String, Bool) -> Void)?

    private var showsSpeechBubble: Bool {
        state?.mood == "speaking" && bubbleVisible
    }

    var presentationWindowSize: NSSize {
        showsSpeechBubble ? scale.speakingWindowSize(for: typingMessage) : scale.windowSize
    }

    init(frame frameRect: NSRect, assetsDirectory: URL, radioURL: URL, scale: PetScale) {
        self.assetsDirectory = assetsDirectory
        self.radioURL = radioURL
        self.scale = scale
        super.init(frame: frameRect)
        wantsLayer = true
        if ProcessInfo.processInfo.environment["ONE_RADIO_PET_VISUAL_TEST"] == "1" {
            layer?.backgroundColor = NSColor(calibratedRed: 1, green: 0, blue: 1, alpha: 1).cgColor
        }
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.animates = false
        imageView.wantsLayer = true
        imageView.layer?.magnificationFilter = .nearest
        imageView.layer?.minificationFilter = .nearest
        imageView.toolTip = "拖动人物移动，单击打开电台，右键调整或关闭"
        imageView.openRadio = { [weak self] in
            guard let self else { return }
            NSWorkspace.shared.open(self.radioURL)
        }
        imageView.showContextMenu = { [weak self] event in self?.openContextMenu(with: event) }
        imageView.didMoveWindow = { [weak self] in self?.windowDidMove?() }
        addSubview(imageView)

        speechBubble.isHidden = true
        addSubview(speechBubble)
        addSubview(speechAccessibility)

        animationTimer = Timer.scheduledTimer(timeInterval: 0.1, target: self, selector: #selector(advanceFrame), userInfo: nil, repeats: true)
        animationTimer?.fireDate = .distantFuture
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        let character = scale.characterSize
        let characterX = showsSpeechBubble
            ? bounds.width - character.width - 12
            : (bounds.width - character.width) / 2
        imageView.frame = NSRect(
            x: characterX,
            y: 8,
            width: character.width,
            height: character.height
        )
        layoutBubble()
    }

    func apply(_ newState: PetState) {
        guard newState != state else { return }
        let previousProfile = state?.profileId
        let previousMode = currentMode
        let wasSpeaking = state?.mood == "speaking"
        state = newState
        let message = Self.displayMessage(newState.message)
        let isSpeaking = newState.mood == "speaking" && !message.isEmpty
        currentMode = isSpeaking ? .speaking : .idle
        if previousProfile != newState.profileId || previousMode != currentMode || frames.isEmpty {
            loadFrames(profileId: newState.profileId, mode: currentMode)
        }
        if isSpeaking && (!wasSpeaking || message != typingMessage) {
            typingMessage = message
            revealedCharacterCount = 0
            speechStartedAt = Date()
            speechRevealDuration = Self.revealDuration(for: message, durationSeconds: newState.speechDurationSeconds)
            bubbleVisible = !typingMessage.isEmpty
            updateBubbleText(currentMessagePrefix)
        } else if isSpeaking {
            updateBubbleText(currentMessagePrefix)
        } else if !isSpeaking {
            typingMessage = ""
            revealedCharacterCount = 0
            speechRevealDuration = 0
            bubbleVisible = false
            speechBubble.setText("")
        }
        let showsBubble = isSpeaking && bubbleVisible
        speechBubble.isHidden = !showsBubble
        speechAccessibility.message = showsBubble ? typingMessage : ""
        moodDidChange?(newState.mood, isSpeaking)
        animationTimer?.fireDate = shouldAnimate ? Date() : .distantFuture
        needsLayout = true
    }

    func updateScale(_ newScale: PetScale) {
        scale = newScale
        needsLayout = true
    }

    private func loadFrames(profileId: String, mode: AnimationMode) {
        imageView.image = nil
        currentProfileId = profileId
        beatIndex = 0
        beatTick = 0
        guard let assets = profileAssets[profileId] else {
            frames = [fallbackAssetImage()]
            assetUnavailable = true
            frameIndex = initialFrameIndex
            imageView.image = frames[frameIndex]
            imageView.needsDisplay = true
            return
        }
        let cacheKey = "\(profileId)-\(mode.rawValue)"
        if let cached = frameCache[cacheKey] {
            frames = cached
        } else {
            let stripURL = assetsDirectory
                .appendingPathComponent("animated", isDirectory: true)
                .appendingPathComponent(assets.animatedDirectory, isDirectory: true)
                .appendingPathComponent("\(mode.rawValue).png")
            let loaded = Self.frames(fromStripAt: stripURL, count: 6)
            frames = loaded
            frameCache[cacheKey] = loaded
        }
        if frames.isEmpty {
            if let staticImage = NSImage(contentsOf: assetsDirectory.appendingPathComponent(assets.staticFile)) {
                assetUnavailable = false
                imageView.image = staticImage
            } else {
                assetUnavailable = true
                imageView.image = fallbackAssetImage()
            }
        } else {
            assetUnavailable = false
            frameIndex = initialFrameIndex
            imageView.image = frames[frameIndex]
        }
        imageView.needsDisplay = true
    }

    private func fallbackAssetImage() -> NSImage {
        NSImage(contentsOf: assetsDirectory.appendingPathComponent("anxuan.png")) ?? Self.fallbackImage()
    }

    private static func frames(fromStripAt url: URL, count: Int) -> [NSImage] {
        guard let source = NSImage(contentsOf: url),
              let cgImage = source.cgImage(forProposedRect: nil, context: nil, hints: nil),
              cgImage.width >= count else { return [] }
        let frameWidth = cgImage.width / count
        return (0..<count).compactMap { index in
            let width = index == count - 1 ? cgImage.width - (frameWidth * index) : frameWidth
            guard let cropped = cgImage.cropping(to: CGRect(x: frameWidth * index, y: 0, width: width, height: cgImage.height)) else { return nil }
            return NSImage(cgImage: cropped, size: NSSize(width: width, height: cgImage.height))
        }
    }

    private static func displayMessage(_ message: String) -> String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func revealDuration(for message: String, durationSeconds: Double?) -> TimeInterval {
        let characterCount = max(1, message.count)
        let fallbackDuration = Double(characterCount) * 0.024
        let plannedDuration = durationSeconds.flatMap { value -> Double? in
            guard value.isFinite && value > 0 else { return nil }
            return value * 0.76
        }
        return max(0.52, min(plannedDuration ?? fallbackDuration, fallbackDuration))
    }

    private static func fallbackImage() -> NSImage {
        let image = NSImage(size: NSSize(width: 128, height: 184))
        image.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .none
        NSColor(calibratedRed: 0.12, green: 0.24, blue: 0.16, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: 28, y: 8, width: 72, height: 92), xRadius: 10, yRadius: 10).fill()
        NSColor(calibratedRed: 0.91, green: 0.72, blue: 0.55, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 30, y: 82, width: 68, height: 68)).fill()
        NSColor(calibratedWhite: 0.08, alpha: 1).setStroke()
        let headset = NSBezierPath()
        headset.lineWidth = 8
        headset.appendArc(withCenter: NSPoint(x: 64, y: 116), radius: 43, startAngle: 20, endAngle: 160)
        headset.stroke()
        NSColor(calibratedWhite: 0.08, alpha: 1).setFill()
        for x in [36.0, 82.0] {
            NSBezierPath(roundedRect: NSRect(x: x, y: 102, width: 12, height: 34), xRadius: 4, yRadius: 4).fill()
        }
        NSColor(calibratedWhite: 0.08, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: 48, y: 116, width: 7, height: 9)).fill()
        NSBezierPath(ovalIn: NSRect(x: 74, y: 116, width: 7, height: 9)).fill()
        image.unlockFocus()
        return image
    }

    private func layoutBubble() {
        let isSpeaking = showsSpeechBubble
        if isSpeaking {
            let bubbleSize = scale.bubbleSize(for: typingMessage)
            let bubbleY = min(
                max(12, imageView.frame.maxY - bubbleSize.height * 0.62),
                max(12, bounds.height - bubbleSize.height - 12)
            )
            speechBubble.frame = NSRect(
                x: 12,
                y: bubbleY,
                width: bubbleSize.width + SpeechBubbleView.tailWidth,
                height: bubbleSize.height
            )
            speechBubble.configure(for: scale)
            speechAccessibility.frame = NSRect(
                x: speechBubble.frame.minX,
                y: speechBubble.frame.minY,
                width: bubbleSize.width,
                height: bubbleSize.height
            )
            updateBubbleText(currentMessagePrefix)
            return
        }

        speechBubble.frame = .zero
        speechAccessibility.frame = .zero
    }

    private var shouldAnimate: Bool {
        state != nil
    }

    @objc private func advanceFrame() {
        advanceTyping()
        guard shouldAnimate, frames.count > 1 else { return }
        let beats = currentMotionBeats
        guard !beats.isEmpty else { return }
        beatTick += 1
        guard beatTick >= max(1, beats[beatIndex].ticks) else { return }
        beatTick = 0
        beatIndex = (beatIndex + 1) % beats.count
        frameIndex = min(max(0, beats[beatIndex].frame), frames.count - 1)
        imageView.image = frames[frameIndex]
    }

    private var currentMotionBeats: [AnimationBeat] {
        let motion = hostMotions[currentProfileId] ?? hostMotions["anxuan"]!
        return motion.beats(for: currentMode)
    }

    private var initialFrameIndex: Int {
        guard let first = currentMotionBeats.first else { return 0 }
        return min(max(0, first.frame), max(0, frames.count - 1))
    }

    private func advanceTyping() {
        guard state?.mood == "speaking", !typingMessage.isEmpty else { return }
        let elapsed = Date().timeIntervalSince(speechStartedAt)
        let progress = speechRevealDuration <= 0
            ? 1
            : min(1, max(0, elapsed / speechRevealDuration))
        revealedCharacterCount = min(typingMessage.count, max(0, Int(ceil(Double(typingMessage.count) * progress))))
        updateBubbleText(currentMessagePrefix)
    }

    private var currentMessagePrefix: String {
        String(typingMessage.prefix(revealedCharacterCount))
    }

    private func updateBubbleText(_ text: String) {
        speechBubble.setText(text)
    }

    @objc private func closePet() {
        NSApplication.shared.terminate(nil)
    }

    private func openContextMenu(with event: NSEvent) {
        let menu = NSMenu(title: "桌面陪伴")
        for (title, value, action) in [
            ("小尺寸", PetScale.small, #selector(useSmallSize)),
            ("中尺寸", PetScale.medium, #selector(useMediumSize)),
            ("大尺寸", PetScale.large, #selector(useLargeSize)),
        ] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            item.state = scale == value ? .on : .off
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let close = NSMenuItem(title: "关闭桌面陪伴", action: #selector(closePet), keyEquivalent: "")
        close.target = self
        menu.addItem(close)
        NSMenu.popUpContextMenu(menu, with: event, for: imageView)
    }

    @objc private func useSmallSize() { scaleDidChange?(.small) }
    @objc private func useMediumSize() { scaleDidChange?(.medium) }
    @objc private func useLargeSize() { scaleDidChange?(.large) }

    override func rightMouseDown(with event: NSEvent) {
        openContextMenu(with: event)
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    private let stateFile: URL
    private let assetsDirectory: URL
    private let instanceId: String
    private let radioURL: URL
    private let defaults: UserDefaults
    private var window: NSWindow?
    private var petView: PetView?
    private var presentationIsSpeaking = false
    private var normalOriginBeforeSpeaking: NSPoint?
    private var timer: DispatchSourceTimer?
    private var pollingIntervalMilliseconds = 0
    private var screenObserver: NSObjectProtocol?
    private var lastData: Data?
    private var lastState: PetState?

    init(stateFile: URL, assetsDirectory: URL, instanceId: String, radioURL: URL) {
        self.stateFile = stateFile
        self.assetsDirectory = assetsDirectory
        self.instanceId = instanceId
        self.radioURL = radioURL
        let suite = ProcessInfo.processInfo.environment["ONE_RADIO_PET_PREFERENCES_SUITE"] ?? "dev.openmusicradio.desktop-pet"
        self.defaults = UserDefaults(suiteName: suite) ?? .standard
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let storedScale = PetScale(rawValue: defaults.string(forKey: "desktopPetScale") ?? "") ?? .small
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: storedScale.windowSize), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = ProcessInfo.processInfo.environment["ONE_RADIO_PET_VISUAL_TEST"] == "1"
            ? NSColor(calibratedRed: 1, green: 0, blue: 1, alpha: 1)
            : .clear
        window.hasShadow = false
        window.level = ProcessInfo.processInfo.environment["ONE_RADIO_PET_VISUAL_TEST"] == "1" ? .screenSaver : .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = false
        window.hidesOnDeactivate = false
        let view = PetView(frame: NSRect(origin: .zero, size: storedScale.windowSize), assetsDirectory: assetsDirectory, radioURL: radioURL, scale: storedScale)
        view.windowDidMove = { [weak self] in self?.handleUserMove() }
        view.scaleDidChange = { [weak self] scale in self?.applyScale(scale) }
        view.moodDidChange = { [weak self] mood, showsSpeechBubble in
            self?.configurePolling(for: mood)
            self?.applyPresentationSize(speaking: showsSpeechBubble)
        }
        window.contentView = view
        restorePosition(window)
        window.orderFrontRegardless()
        self.window = window
        self.petView = view
        pollState()
        configurePolling(for: "preparing")
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.reclampWindow() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.cancel()
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        savePosition()
    }

    private func applyScale(_ scale: PetScale) {
        guard let window, let petView else { return }
        let origin = window.frame.origin
        petView.updateScale(scale)
        window.setContentSize(presentationIsSpeaking ? petView.presentationWindowSize : scale.windowSize)
        window.setFrameOrigin(clamped(origin: origin, size: window.frame.size))
        defaults.set(scale.rawValue, forKey: "desktopPetScale")
        savePosition()
    }

    private func applyPresentationSize(speaking: Bool) {
        guard let window, let petView else { return }
        let targetSize = speaking ? petView.presentationWindowSize : petView.scale.windowSize
        guard window.frame.size != targetSize else { return }
        if speaking && !presentationIsSpeaking {
            normalOriginBeforeSpeaking = window.frame.origin
        }
        let origin = window.frame.origin
        window.setContentSize(targetSize)
        if !speaking, presentationIsSpeaking, let normalOriginBeforeSpeaking {
            window.setFrameOrigin(clamped(origin: normalOriginBeforeSpeaking, size: window.frame.size))
            self.normalOriginBeforeSpeaking = nil
        } else {
            window.setFrameOrigin(clamped(origin: origin, size: window.frame.size))
        }
        presentationIsSpeaking = speaking
    }

    private func restorePosition(_ window: NSWindow) {
        let hasStoredPosition = defaults.object(forKey: "desktopPetX") != nil && defaults.object(forKey: "desktopPetY") != nil
        if hasStoredPosition {
            let origin = NSPoint(x: defaults.double(forKey: "desktopPetX"), y: defaults.double(forKey: "desktopPetY"))
            window.setFrameOrigin(clamped(origin: origin, size: window.frame.size))
            return
        }
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        window.setFrameOrigin(NSPoint(x: visible.maxX - window.frame.width - 22, y: visible.minY + 28))
    }

    private func clamped(origin: NSPoint, size: NSSize) -> NSPoint {
        let screen = NSScreen.screens.first(where: { $0.visibleFrame.intersects(NSRect(origin: origin, size: size)) }) ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return origin }
        return NSPoint(
            x: min(max(origin.x, visible.minX), visible.maxX - size.width),
            y: min(max(origin.y, visible.minY), visible.maxY - size.height)
        )
    }

    private func savePosition() {
        guard let origin = window?.frame.origin else { return }
        defaults.set(origin.x, forKey: "desktopPetX")
        defaults.set(origin.y, forKey: "desktopPetY")
    }

    private func reclampWindow() {
        guard let window else { return }
        window.setFrameOrigin(clamped(origin: window.frame.origin, size: window.frame.size))
        savePosition()
    }

    private func handleUserMove() {
        if presentationIsSpeaking {
            normalOriginBeforeSpeaking = nil
        }
        reclampWindow()
    }

    private func configurePolling(for mood: String) {
        let interval = ["paused", "closing", "ended", "error"].contains(mood) ? 1_000 : 200
        guard interval != pollingIntervalMilliseconds else { return }
        pollingIntervalMilliseconds = interval
        timer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .milliseconds(interval), repeating: .milliseconds(interval))
        timer.setEventHandler { [weak self] in self?.pollState() }
        timer.resume()
        self.timer = timer
    }

    private func pollState() {
        if let state = lastState {
            guard state.instanceId == instanceId else {
                NSApplication.shared.terminate(nil)
                return
            }
            if Darwin.kill(state.ownerPid, 0) != 0 && errno == ESRCH {
                NSApplication.shared.terminate(nil)
                return
            }
        }
        guard let data = try? Data(contentsOf: stateFile), data != lastData else { return }
        guard let state = try? JSONDecoder().decode(PetState.self, from: data), state.version == 1 else { return }
        guard state.instanceId == instanceId else {
            NSApplication.shared.terminate(nil)
            return
        }
        if Darwin.kill(state.ownerPid, 0) != 0 && errno == ESRCH {
            NSApplication.shared.terminate(nil)
            return
        }
        lastData = data
        lastState = state
        petView?.apply(state)
    }
}

private func argumentValue(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), CommandLine.arguments.indices.contains(index + 1) else { return nil }
    return CommandLine.arguments[index + 1]
}

guard let statePath = argumentValue("--state-file"), let assetsPath = argumentValue("--assets-dir"), let instanceId = argumentValue("--instance-id") else {
    FileHandle.standardError.write(Data("OneRadioPet requires --state-file, --assets-dir and --instance-id.\n".utf8))
    exit(64)
}

private let defaultRadioURL = URL(string: "http://127.0.0.1:5173/")!
private let configuredRadioURL = ProcessInfo.processInfo.environment["ONE_RADIO_WEB_URL"].flatMap(URL.init(string:))
private let radioURL: URL = {
    guard let candidate = configuredRadioURL,
          candidate.scheme?.lowercased() == "http",
          ["127.0.0.1", "localhost", "::1"].contains(candidate.host?.lowercased() ?? ""),
          candidate.user == nil,
          candidate.password == nil,
          let port = candidate.port,
          (1024...65535).contains(port) else { return defaultRadioURL }
    return candidate
}()

private let app = NSApplication.shared
app.setActivationPolicy(.accessory)
private let delegate = AppDelegate(
    stateFile: URL(fileURLWithPath: statePath),
    assetsDirectory: URL(fileURLWithPath: assetsPath, isDirectory: true),
    instanceId: instanceId,
    radioURL: radioURL
)
app.delegate = delegate
app.run()
