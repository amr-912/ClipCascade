package com.clipcascade

import android.app.Application
import android.content.ClipData
import android.content.ClipDescription
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * JVM tests against Android ClipData and ClipDescription, not textual source
 * patterns. Real Samsung Keyboard behavior must still be tested on hardware.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 35], application = Application::class)
class ClipboardContentSelectorTest {
    private val resolver get() = RuntimeEnvironment.getApplication().contentResolver

    @Test
    fun mixedMimesPrioritizeImageUriEvenWhenTextMimeComesFirst() {
        val uri = Uri.parse("content://example/screenshot/42")
        val description = ClipDescription("screenshot", arrayOf("text/plain", "image/png"))
        val clip = ClipData(description, ClipData.Item("image preview text"))
        clip.addItem(ClipData.Item(uri))

        val payload = selectClipboardPayload(clip, resolver)
        assertEquals("image", payload?.type)
        assertEquals(uri.toString(), payload?.content)
    }

    @Test
    fun imageUriFirstItemRemainsImage() {
        val uri = Uri.parse("content://example/screenshot/43")
        val clip = ClipData(ClipDescription("shot", arrayOf("image/png")),
            ClipData.Item(uri))
        assertEquals("image", selectClipboardPayload(clip, resolver)?.type)
    }

    @Test
    fun ordinaryTextIsNotConvertedToImage() {
        val clip = ClipData.newPlainText("text", "hello world")
        val payload = selectClipboardPayload(clip, resolver)
        assertEquals("text", payload?.type)
        assertEquals("hello world", payload?.content)
    }

    @Test
    fun nonImageUriStaysFile() {
        val clip = ClipData(ClipDescription("document", arrayOf("application/pdf")),
            ClipData.Item(Uri.parse("content://example/documents/1")))
        assertEquals("files", selectClipboardPayload(clip, resolver)?.type)
    }
}
