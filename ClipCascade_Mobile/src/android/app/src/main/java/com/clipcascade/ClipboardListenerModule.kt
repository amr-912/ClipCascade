// android\app\src\main\java\com\clipcascade\ClipboardListenerModule.kt
package com.clipcascade

import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedReader
import java.io.InputStreamReader
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import com.facebook.react.bridge.Promise


// Exact label of images ClipCascade writes from a remote device. This marker
// protects the next genuine user copy from being consumed by JS echo suppression.
// It does not change the image URI, MIME type, or Samsung clipboard history.
internal const val CLIPCASCADE_REMOTE_IMAGE_LABEL = "ClipCascade Remote Image"


/** Metadata-only stages: reject arbitrary strings, URIs, image data and secrets. */
internal fun isSafeClipboardTransportStage(stage: String): Boolean = stage in setOf(
    "js-image", "js-text", "js-files",
    "p2p-image-pending", "p2p-text-pending", "p2p-files-pending",
    "p2p-image-queued", "p2p-text-queued", "p2p-files-queued",
    "p2p-image-error", "p2p-text-error", "p2p-files-error",
    "p2p-image-acknowledged", "p2p-text-acknowledged", "p2p-files-acknowledged",
    "p2p-image-unacknowledged", "p2p-text-unacknowledged", "p2p-files-unacknowledged"
)

class ClipboardListenerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    private var clipboardManager: ClipboardManager =
        reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null
    private var screenshotMediaMonitor: ScreenshotMediaMonitor? = null
    private val savedScreenshotEvents = AtomicInteger(0)

    @ReactMethod
    fun startScreenshotMonitoring(promise: Promise) {
        val permission = if (Build.VERSION.SDK_INT >= 33)
            Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        if (ContextCompat.checkSelfPermission(reactApplicationContext, permission) !=
            PackageManager.PERMISSION_GRANTED) {
            promise.reject("SCREENSHOT_PERMISSION", "Full photo read access is required for automatic screenshot sync.")
            return
        }
        if (!isListening) {
            promise.reject("MONITOR_INACTIVE", "Start ClipCascade before enabling screenshot monitoring.")
            return
        }
        if (screenshotMediaMonitor?.isActive == true) {
            promise.resolve(true)
            return
        }
        try {
            val monitor = ScreenshotMediaMonitor(reactApplicationContext) { uri ->
                if (isListening) {
                    recordClipboardEvent(
                        "screenshot", "image",
                        android.content.ClipDescription("Saved Screenshot", arrayOf("image/png"))
                    )
                    savedScreenshotEvents.incrementAndGet()
                    val params = Arguments.createMap()
                    params.putString("content", uri.toString())
                    params.putString("type", "image")
                    sendEventToJS(params)
                }
            }
            screenshotMediaMonitor = monitor
            monitor.start { registered ->
                if (registered) {
                    promise.resolve(true)
                } else {
                    screenshotMediaMonitor = null
                    promise.reject("SCREENSHOT_MONITOR_ERROR",
                        "Could not initialize screenshot observer. Check photo permissions.")
                }
            }
        } catch (_: Exception) {
            screenshotMediaMonitor?.stop()
            screenshotMediaMonitor = null
            promise.reject("SCREENSHOT_MONITOR_ERROR", "Could not start screenshot observer.")
        }
    }

    @ReactMethod
    fun stopScreenshotMonitoring(promise: Promise) {
        screenshotMediaMonitor?.stop()
        screenshotMediaMonitor = null
        promise.resolve(true)
    }

    @Volatile private var isListening = false
    private var lastEmittedTime: Long = 0 // for clipboard listener debounce
    private var lastActivityStartTime: Long = 0 // for log cat monitoring  debounce
    private val debounceTime: Long = 0 // milliseconds (increase to debounce clipboard listener)
    private val activityDebounceTime: Long = 1000 // milliseconds (increase to debounce log cat monitoring)

    // logcat‐reader control
    @Volatile private var stopLogcat = false
    @Volatile private var logcatThread: Thread? = null
    @Volatile private var logcatProcess: Process? = null
    private val logcatWatchdogHandler = Handler(Looper.getMainLooper())
    private val logcatWatchdog = object : Runnable {
        override fun run() {
            if (!isListening) return
            if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P &&
                ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.READ_LOGS) == PackageManager.PERMISSION_GRANTED
            ) {
                // The OS can terminate the logcat subprocess while the app
                // remains Connected. Without a watchdog, background copying
                // silently becomes one-way until the app restarts.
                if (logcatThread?.isAlive != true) {
                    startLogcatReader()
                }
            }
            logcatWatchdogHandler.postDelayed(this, 60000L)
        }
    }

    

    override fun getName(): String {
        return "ClipboardListener"
    }

    override fun getConstants(): MutableMap<String, Any> =
        mutableMapOf("applicationId" to BuildConfig.APPLICATION_ID)


    @ReactMethod
    fun startListening() {
        if (isListening) {
            if (logcatThread?.isAlive != true) startLogcatReader()
            return
        }

        // 1) Clipboard listener
        listener = ClipboardManager.OnPrimaryClipChangedListener {
            val clip = try { clipboardManager.primaryClip } catch (_: Exception) { null }
            val description = clip?.description
            if (description?.label?.toString() == CLIPCASCADE_REMOTE_IMAGE_LABEL) {
                recordClipboardEvent("listener", "remote-image", description)
                return@OnPrimaryClipChangedListener
            }
            val payload = clip?.let {
                try { selectClipboardPayload(it, reactApplicationContext.contentResolver) }
                catch (_: Exception) { null }
            }
            recordClipboardEvent("listener", payload?.type ?: "unavailable", description)
            if (payload != null) {
                val params = Arguments.createMap()
                params.putString("content", payload.content)
                params.putString("type", payload.type)
                sendEventToJS(params)
            }
        }
        clipboardManager.addPrimaryClipChangedListener(listener)
        isListening = true

        logcatWatchdogHandler.removeCallbacks(logcatWatchdog)
        startLogcatReader()
        logcatWatchdogHandler.postDelayed(logcatWatchdog, 60000L)
    }

    private fun startLogcatReader() {
        if (!isListening || logcatThread?.isAlive == true) return

        // 2) Logcat monitoring
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P &&
            ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.READ_LOGS) == PackageManager.PERMISSION_GRANTED
        ) {
            // If already stopping, reset flag
            stopLogcat = false

            // Start a single dedicated thread
            logcatThread = Thread {
                try {
                    val timeStamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.getDefault())
                        .format(Date())
                    logcatProcess = Runtime.getRuntime().exec(
                        arrayOf("logcat", "-T", timeStamp, "ClipboardService:E", "*:S")
                    )
                    val reader = BufferedReader(InputStreamReader(logcatProcess!!.inputStream))
                    var line: String? = null
                    reader.use { br ->
                        while (!stopLogcat && br.readLine().also { line = it } != null) {
                            if (line!!.contains(BuildConfig.APPLICATION_ID)) {
                                val currentTime = System.currentTimeMillis()
                                if (currentTime - lastActivityStartTime > activityDebounceTime) {
                                    lastActivityStartTime = currentTime
                                    // launch the floating activity
                                    reactApplicationContext.startActivity(
                                        ClipboardFloatingActivity.getIntent(reactApplicationContext)
                                    )
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    e.printStackTrace()
                } finally {
                    try {
                        logcatProcess?.destroy()
                    } catch (_: Exception) {}
                    stopLogcat = false
                }
            }.apply {
                isDaemon = true
                start()
            }
        }
    }

    @ReactMethod
    fun stopListening() {
        screenshotMediaMonitor?.stop()
        screenshotMediaMonitor = null
        isListening = false
        logcatWatchdogHandler.removeCallbacks(logcatWatchdog)
        // 1) Remove clipboard listener
        listener?.let {
            clipboardManager.removePrimaryClipChangedListener(it)
            listener = null
            isListening = false
        }

        // 2) Tear down logcat‐reader thread & process
        stopLogcat = true
        try {
            logcatThread?.interrupt()
        } catch (_: Exception) {}
        try {
            logcatProcess?.destroy()
        } catch (_: Exception) {}
        logcatThread = null
        logcatProcess = null
    }


    private fun sendEventToJS(params: WritableMap) {
        val currentTime = System.currentTimeMillis()
        if (currentTime - lastEmittedTime > debounceTime) {
            lastEmittedTime = currentTime
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("onClipboardChange", params)
        }
    }

    // In-memory *metadata* only. Never retain clipboard text, URI, label,
    // image bytes, passwords or plaintext logs in diagnostics.
    companion object {
        private val observedEvents = AtomicInteger(0)
        private val transportEvents = AtomicInteger(0)
        @Volatile private var lastTransportStage = "none"
        @Volatile private var lastEventSource = "none"
        @Volatile private var lastEventType = "none"
        @Volatile private var lastEventMimeTypes = "none"

        internal fun recordClipboardEvent(source: String, kind: String, description: android.content.ClipDescription?) {
            observedEvents.incrementAndGet()
            lastEventSource = source
            lastEventType = kind
            lastEventMimeTypes = if (description == null) "none" else
                (0 until description.mimeTypeCount).joinToString(",") { description.getMimeType(it) }
        }
    }

    @ReactMethod
    fun recordTransportStage(stage: String) {
        // Accept only fixed metadata states. In particular, the WebRTC ACK
        // handlers must not disappear from the diagnostic counters merely
        // because the bridge's stage whitelist predates ACK support.
        if (isSafeClipboardTransportStage(stage)) {
            lastTransportStage = stage
            transportEvents.incrementAndGet()
        }
    }

    /**
     * User-initiated, on-device diagnosis. Read one byte at most from the
     * current image URI; return only booleans and MIME types to React Native.
     * Works when Android permits this app to access the system clipboard.
     */
    @ReactMethod
    fun inspectCurrentClipboard(promise: Promise) {
        Thread {
            val report = Arguments.createMap()
            report.putBoolean("monitorActive", isListening)
            report.putBoolean("screenshotMonitorActive", screenshotMediaMonitor?.isActive == true)
            report.putInt("savedScreenshotEvents", savedScreenshotEvents.get())
            report.putInt("observedEvents", observedEvents.get())
            report.putInt("transportEvents", transportEvents.get())
            report.putString("lastTransportStage", lastTransportStage)
            report.putString("lastEventSource", lastEventSource)
            report.putString("lastEventType", lastEventType)
            report.putString("lastEventMimeTypes", lastEventMimeTypes)
            try {
                val clip = clipboardManager.primaryClip
                report.putBoolean("primaryClipAccessible", clip != null)
                report.putInt("itemCount", clip?.itemCount ?: 0)
                val description = clip?.description
                val mimes = Arguments.createArray()
                if (description != null) {
                    for (i in 0 until description.mimeTypeCount) {
                        mimes.pushString(description.getMimeType(i))
                    }
                }
                report.putArray("mimeTypes", mimes)
                var hasUri = false
                if (clip != null) {
                    for (i in 0 until clip.itemCount) {
                        if (clip.getItemAt(i).uri != null) hasUri = true
                    }
                }
                report.putBoolean("hasUri", hasUri)
                val payload = clip?.let {
                    selectClipboardPayload(it, reactApplicationContext.contentResolver)
                }
                report.putString("detectedType", payload?.type ?: "none")
                var imageReadable = "not-tested"
                if (payload?.type == "image") {
                    imageReadable = try {
                        val uri = android.net.Uri.parse(payload.content)
                        reactApplicationContext.contentResolver.openInputStream(uri)?.use { stream ->
                            // Only probe availability; do not read or log the image.
                            stream.read()
                            "yes"
                        } ?: "no"
                    } catch (_: Exception) { "no" }
                }
                report.putString("imageReadable", imageReadable)
            } catch (e: Exception) {
                report.putString("accessErrorType", e.javaClass.simpleName)
            }
            promise.resolve(report)
        }.start()
    }

    @ReactMethod
    fun addListener(type: String?) {
        // Required for RN built-in Event Emitter Calls.
    }

    @ReactMethod
    fun removeListeners(type: Int?) {
        // Required for RN built-in Event Emitter Calls.
    }
}

