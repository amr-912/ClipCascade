package com.clipcascade

import android.app.Application
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Test the real native diagnostic stage allowlist, not a duplicated JS list. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 35], application = Application::class)
class ClipboardTransportStageTest {
    @Test fun eachClipboardTypeReportsActualAckOrTimeout() {
        for (type in listOf("text", "image", "files")) {
            assertTrue(isSafeClipboardTransportStage("p2p-$type-acknowledged"))
            assertTrue(isSafeClipboardTransportStage("p2p-$type-unacknowledged"))
            assertTrue(isSafeClipboardTransportStage("p2p-$type-queued"))
            assertTrue(isSafeClipboardTransportStage("p2p-$type-pending"))
            assertTrue(isSafeClipboardTransportStage("p2p-$type-error"))
            assertTrue(isSafeClipboardTransportStage("js-$type"))
        }
    }

    @Test fun neverPersistSecretOrFreeFormTransportStates() {
        for (value in listOf(
            "", "ACK OK", "p2p-image-acknowledged extra", "p2p-image-acknowledged\\nsecret",
            "content://media/external/images/media/42",
            "JSESSIONID=not-a-cookie", "turns:turn.example:443",
            "p2p-image-queued:image-base64",
            "p2p-clipboard-acknowledged",
        )) {
            assertFalse("unexpected metadata allowlist entry", isSafeClipboardTransportStage(value))
        }
    }
}
