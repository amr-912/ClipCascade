package com.clipcascade

import android.content.ContentResolver
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
    private val executor = Executors.newSingleThreadExecutor()
    private val delivered = mutableSetOf<Long>()
    @Volatile private var active = false
    @Volatile private var observer: ContentObserver? = null
    private var baselineId = 0L
    private var scanInFlight = false

    val isActive: Boolean get() = active

    private val scheduleScan = Runnable {
        if (!active) return@Runnable
        executor.execute {
            if (active) scanNewImages()
        }
    }

    /** Start watching only AFTER capturing a high-water mark of existing images. */
    fun start() {
        if (active) return
        active = true
        executor.execute {
            try {
                baselineId = latestImageId()
                if (!active) return@execute
                val watch = object : ContentObserver(handler) {
                    override fun onChange(selfChange: Boolean) = changed()
                    override fun onChange(selfChange: Boolean, uri: Uri?) = changed()
                    private fun changed() {
                        if (!active) return
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
                    return@execute
                }
                handler.postDelayed(scheduleScan, 1100L)
            } catch (_: Exception) {
                active = false
            }
        }
    }

    fun stop() {
        active = false
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
    } ?: 0L

    private fun scanNewImages() {
        if (!active || scanInFlight) return
        scanInFlight = true
        try {
            val idColumn = MediaStore.Images.Media._ID
            val nameColumn = MediaStore.Images.Media.DISPLAY_NAME
            val sizeColumn = MediaStore.Images.Media.SIZE
            val projection = mutableListOf(idColumn, nameColumn, sizeColumn)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                projection.add(MediaStore.MediaColumns.RELATIVE_PATH)
                projection.add(MediaStore.MediaColumns.IS_PENDING)
            }
            resolver.query(
                mediaUri,
                projection.toTypedArray(),
                "$idColumn > ?",
                arrayOf(baselineId.toString()),
                "$idColumn ASC",
            )?.use { cursor ->
                val idIndex = cursor.getColumnIndexOrThrow(idColumn)
                val nameIndex = cursor.getColumnIndexOrThrow(nameColumn)
                val sizeIndex = cursor.getColumnIndexOrThrow(sizeColumn)
                val pathIndex = cursor.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH)
                val pendingIndex = cursor.getColumnIndex(MediaStore.MediaColumns.IS_PENDING)
                while (active && cursor.moveToNext()) {
                    val id = cursor.getLong(idIndex)
                    if (delivered.contains(id)) continue
                    val name = if (cursor.isNull(nameIndex)) null else cursor.getString(nameIndex)
                    val relativePath = if (pathIndex >= 0 && !cursor.isNull(pathIndex))
                        cursor.getString(pathIndex) else null
                    if (!isSavedScreenshot(relativePath, name)) continue
                    if (cursor.isNull(sizeIndex) || cursor.getLong(sizeIndex) <= 0L) continue
                    // Never send a half-written image; transient rows are retried
                    // on the next MediaStore change.
                    if (pendingIndex >= 0 && cursor.getInt(pendingIndex) != 0) continue
                    val uri = ContentUris.withAppendedId(mediaUri, id)
                    if (!active) break
                    // Mark first: observers often fire repeatedly for one screenshot.
                    delivered.add(id)
                    deliver(uri)
                }
            }
        } catch (_: Exception) {
            // Losing media access (permission revoked) must not expose any data.
        } finally {
            scanInFlight = false
        }
    }
}
