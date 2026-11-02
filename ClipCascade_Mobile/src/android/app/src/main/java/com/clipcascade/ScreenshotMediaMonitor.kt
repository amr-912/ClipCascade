package com.clipcascade

import android.content.ContentResolver
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.content.ContentUris
import android.content.Context
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Screenshot-only source independent of Samsung Keyboard's private clipboard.
 * No polling of an entire gallery, no historical backfill, no image bytes in logs.
 * The caller explicitly enables it after granting media read permission.
 */
internal fun isSavedScreenshot(relativePath: String?, displayName: String?): Boolean {
    val screenshotFolder = relativePath
        ?.replace('\\', '/')
        ?.split('/')
        ?.any { it.equals("Screenshots", ignoreCase = true) } == true
    val name = displayName?.lowercase(Locale.ROOT) ?: ""
    return screenshotFolder ||
        name.startsWith("screenshot_") ||
        name.startsWith("screenshot-") ||
        name.startsWith("screenshot ") ||
        name.startsWith("screenshot(")
}

internal class ScreenshotMediaMonitor(
    private val context: Context,
    private val deliver: (Uri) -> Unit,
) {
    private val resolver: ContentResolver = context.contentResolver
    private val mediaUri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    private val handler = Handler(Looper.getMainLooper())
    private var executor = Executors.newSingleThreadExecutor()
    private val delivered = mutableSetOf<Long>()
    @Volatile private var active = false
    @Volatile private var observer: ContentObserver? = null
    private var baselineId = 0L
    private var scanInFlight = false
    private var incompleteRetries = 0
    private val maxIncompleteRetries = 6

    val isActive: Boolean get() = active

    private val scheduleScan = Runnable {
        if (!active) return@Runnable
        try {
            executor.execute {
                if (active) scanNewImages()
            }
        } catch (_: java.util.concurrent.RejectedExecutionException) {
            // Stop may race with an already scheduled ContentObserver callback.
        }
    }

    /** Start watching only AFTER capturing a high-water mark of existing images. */
    fun start(onReady: (Boolean) -> Unit) {
        if (active) {
            onReady(true)
            return
        }
        if (executor.isShutdown) executor = Executors.newSingleThreadExecutor()
        active = true
        executor.execute {
            try {
                baselineId = latestImageId()
                if (!active) {
                    onReady(false)
                    return@execute
                }
                val watch = object : ContentObserver(handler) {
                    override fun onChange(selfChange: Boolean) = changed()
                    override fun onChange(selfChange: Boolean, uri: Uri?) = changed()
                    private fun changed() {
                        if (!active) return
                        incompleteRetries = 0
                        handler.removeCallbacks(scheduleScan)
                        // Let Samsung finish writing the screenshot/MediaStore row.
                        handler.postDelayed(scheduleScan, 900L)
                    }
                }
                observer = watch
                resolver.registerContentObserver(mediaUri, true, watch)
                if (!active) {
                    resolver.unregisterContentObserver(watch)
                    observer = null
                    onReady(false)
                    return@execute
                }
                handler.postDelayed(scheduleScan, 1100L)
                onReady(true)
            } catch (_: Exception) {
                active = false
                // Failed baseline/registration must never leave a live executor
                // or fall back to scanning screenshots from the beginning.
                executor.shutdownNow()
                observer?.let {
                    try { resolver.unregisterContentObserver(it) } catch (_: Exception) {}
                }
                observer = null
                onReady(false)
            }
        }
    }

    fun stop() {
        active = false
        incompleteRetries = 0
        handler.removeCallbacks(scheduleScan)
        observer?.let {
            try { resolver.unregisterContentObserver(it) } catch (_: Exception) {}
        }
        observer = null
        executor.shutdownNow()
    }

    private fun latestImageId(): Long = resolver.query(
        mediaUri,
        arrayOf(MediaStore.Images.Media._ID),
        null, null,
        "${MediaStore.Images.Media._ID} DESC",
    )?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getLong(0) else 0L
    } ?: throw IllegalStateException("MediaStore unavailable: refuse to scan history")

    private fun scanNewImages() {
        if (!active || scanInFlight) return
        val readPermission = if (Build.VERSION.SDK_INT >= 33)
            Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        if (ContextCompat.checkSelfPermission(context, readPermission) != PackageManager.PERMISSION_GRANTED) {
            // If media access was revoked in Settings (or the selected-only
            // temporary grant expired), stop rather than silently scanning.
            stop()
            return
        }
        scanInFlight = true
        var needsRetry = false
        var lastCompletedId = baselineId
        var earliestIncompleteId: Long? = null
        try {
            val idColumn = MediaStore.Images.Media._ID
            val nameColumn = MediaStore.Images.Media.DISPLAY_NAME
            val sizeColumn = MediaStore.Images.Media.SIZE
            val projection = mutableListOf(idColumn, nameColumn, sizeColumn)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                projection.add(MediaStore.MediaColumns.RELATIVE_PATH)
                projection.add(MediaStore.MediaColumns.IS_PENDING)
            }
            // A transient null cursor is a provider failure, NOT an empty
            // result. Treat it like a query exception and schedule the same
            // bounded retry; otherwise a screenshot can be lost forever when
            // Android emits no second media notification.
            val cursor = resolver.query(
                mediaUri,
                projection.toTypedArray(),
                "$idColumn > ?",
                arrayOf(baselineId.toString()),
                "$idColumn ASC",
            ) ?: throw IllegalStateException("MediaStore screenshot scan unavailable")
            cursor.use { cursor ->
                val idIndex = cursor.getColumnIndexOrThrow(idColumn)
                val nameIndex = cursor.getColumnIndexOrThrow(nameColumn)
                val sizeIndex = cursor.getColumnIndexOrThrow(sizeColumn)
                val pathIndex = cursor.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
                val pendingIndex = cursor.getColumnIndex(MediaStore.MediaColumns.IS_PENDING)
                while (active && cursor.moveToNext()) {
                    val id = cursor.getLong(idIndex)
                    if (earliestIncompleteId == null) lastCompletedId = id
                    if (delivered.contains(id)) continue
                    val name = if (cursor.isNull(nameIndex)) null else cursor.getString(nameIndex)
                    val relativePath = if (pathIndex >= 0 && !cursor.isNull(pathIndex))
                        cursor.getString(pathIndex) else null
                    if (!isSavedScreenshot(relativePath, name)) continue
                    // Samsung may expose a new row before image writing finishes.
                    // Retry for a bounded window even if no second provider
                    // notification is emitted, without harvesting older media.
                    if (cursor.isNull(sizeIndex) || cursor.getLong(sizeIndex) <= 0L ||
                        (pendingIndex >= 0 && cursor.getInt(pendingIndex) != 0)) {
                        needsRetry = true
                        if (earliestIncompleteId == null) earliestIncompleteId = id
                        continue
                    }
                    val uri = ContentUris.withAppendedId(mediaUri, id)
                    if (!active) break
                    // Do not mark a screenshot delivered until the event is
                    // actually emitted. A bridge exception must be retryable.
                    try {
                        deliver(uri)
                    } catch (_: Exception) {
                        needsRetry = true
                        if (earliestIncompleteId == null) earliestIncompleteId = id
                        continue
                    }
                    delivered.add(id)
                    // Bound de-dup metadata for months-long foreground sessions.
                    if (delivered.size > 2048) {
                        val sortedIds = delivered.sorted()
                        val floor = sortedIds[sortedIds.size - 1024]
                        delivered.removeAll { it < floor }
                        baselineId = maxOf(baselineId, floor - 1)
                    }
                }
                // Progress the high-water mark without skipping unfinished
                // screenshots. Normal camera/gallery additions are never sent.
                baselineId = if (earliestIncompleteId == null) {
                    maxOf(baselineId, lastCompletedId)
                } else {
                    maxOf(baselineId, earliestIncompleteId!! - 1)
                }
            }
        } catch (_: Exception) {
            // Provider queries can fail transiently during photo finalization.
            // Retry a bounded number of times without walking old history.
            needsRetry = true
        } finally {
            scanInFlight = false
            if (active && needsRetry && incompleteRetries < maxIncompleteRetries) {
                incompleteRetries++
                handler.removeCallbacks(scheduleScan)
                handler.postDelayed(scheduleScan, 1600L)
            } else if (!needsRetry) {
                incompleteRetries = 0
            }
        }
    }
}
