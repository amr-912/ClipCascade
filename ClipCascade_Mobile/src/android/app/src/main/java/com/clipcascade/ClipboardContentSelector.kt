package com.clipcascade

import android.content.ClipData
import android.content.ContentResolver

/**
 * Interpret the system clipboard without coercing image URIs into text.
 * Samsung/other providers may advertise text/plain before an image MIME, or expose
 * the image URI in a later ClipData.Item. No private keyboard history is read.
 */
internal data class ClipboardPayload(val content: String, val type: String)

internal fun selectClipboardPayload(clip: ClipData, resolver: ContentResolver): ClipboardPayload? {
    if (clip.itemCount <= 0) return null
    val description = clip.description
    val declaredImage = description?.hasMimeType("image/*") == true

    // Image URI is authoritative over text for a mixed-format screenshot.
    for (index in 0 until clip.itemCount) {
        val uri = clip.getItemAt(index).uri ?: continue
        val providerImage = try {
            resolver.getType(uri)?.startsWith("image/", ignoreCase = true) == true
        } catch (_: Exception) {
            false
        }
        if (declaredImage || providerImage) {
            return ClipboardPayload(uri.toString(), "image")
        }
    }

    for (index in 0 until clip.itemCount) {
        val text = clip.getItemAt(index).text
        if (text != null) return ClipboardPayload(text.toString(), "text")
    }

    for (index in 0 until clip.itemCount) {
        val uri = clip.getItemAt(index).uri ?: continue
        return ClipboardPayload(uri.toString(), "files")
    }
    return null
}
