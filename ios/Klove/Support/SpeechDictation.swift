import Foundation
import Speech
import AVFoundation

/// On-device speech-to-text for the booking assistant's mic button. Transcribes live into
/// `transcript`; the view mirrors that into the text field. Nothing leaves the device — Apple's
/// Speech framework handles recognition locally (we request on-device when available).
@MainActor
@Observable
final class SpeechDictation {
    var transcript = ""
    var isRecording = false
    var errorMessage: String?

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    var isAvailable: Bool { recognizer?.isAvailable ?? false }

    func toggle() {
        if isRecording { stop() } else { Task { await start() } }
    }

    func start() async {
        guard !isRecording else { return }
        errorMessage = nil
        guard await requestPermissions() else {
            errorMessage = "Enable microphone and speech access in Settings to use voice."
            return
        }
        do {
            try beginSession()
            isRecording = true
        } catch {
            errorMessage = "Couldn't start recording. \(error.localizedDescription)"
            cleanup()
        }
    }

    func stop() {
        guard isRecording else { return }
        isRecording = false
        cleanup()
    }

    // MARK: - Internals

    private func beginSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if recognizer?.supportsOnDeviceRecognition == true { request.requiresOnDeviceRecognition = true }
        self.request = request

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()

        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result { self.transcript = result.bestTranscription.formattedString }
            if error != nil || (result?.isFinal ?? false) { self.stop() }
        }
    }

    private func cleanup() {
        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning { audioEngine.stop() }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func requestPermissions() async -> Bool {
        let speechOK = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0 == .authorized) }
        }
        guard speechOK else { return false }
        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            AVAudioApplication.requestRecordPermission { cont.resume(returning: $0) }
        }
    }
}
