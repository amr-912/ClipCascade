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


// Exact label of images ClipCascade writes from a remote device. This marker
// protects the next genuine user copy from being consumed by JS echo suppression.
// It does not change the image URI, MIME type, or Samsung clipboard history.
internal const val CLIPCASCADE_REMOTE_IMAGE_LABEL = "ClipCascade Remote Image"

class ClipboardListenerModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
    private var clipboardManager: ClipboardManager =
        reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private var listener: ClipboardManager.OnPrimaryClipChangedListener? = null
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

    @ReactMethod
    fun startListening() {
        if (isListening) {
            if (logcatThread?.isAlive != true) startLogcatReader()
            return
        }

        // 1) Clipboard listener
        listener = ClipboardManager.OnPrimaryClipChangedListener {
            val clip = clipboardManager.primaryClip
            if (clip != null && clip.itemCount > 0) {

                val description = clip.description
                // This image was written by our own receive path, not copied
                // by the user. Filter the *specific event*, rather than
                // suppressing an unrelated future clipboard change.
                if (description?.label?.toString() == CLIPCASCADE_REMOTE_IMAGE_LABEL) {
                    return@OnPrimaryClipChangedListener
                }
                if (description != null) { 

                    val mimeType = description.getMimeType(0)
                    if (mimeType != null) {
                        
                        val item = clip.getItemAt(0)
                        val params: WritableMap = Arguments.createMap()
                        
                        if (mimeType.startsWith("text/") && item.text != null) {
                            // Text
                            params.putString("content", item.text.toString())
                            params.putString("type", "text")
                        }
                        else if (description.hasMimeType("image/*") && item.uri != null) {
                            // Image
                            params.putString("content", item.uri.toString())
                            params.putString("type", "image")
                        }
                        else if (item.uri != null) {
                            // Files
                            params.putString("content", item.uri.toString())
                            params.putString("type", "files")
                        }

                        sendEventToJS(params)
                    }
                }
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

    @ReactMethod
    fun addListener(type: String?) {
        // Required for RN built-in Event Emitter Calls.
    }

    @ReactMethod
    fun removeListeners(type: Int?) {
        // Required for RN built-in Event Emitter Calls.
    }
}

