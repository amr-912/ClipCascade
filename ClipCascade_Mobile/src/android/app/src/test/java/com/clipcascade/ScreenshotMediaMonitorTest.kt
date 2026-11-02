package com.clipcascade

import android.app.Application
import android.database.MatrixCursor
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.fail
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Pure screenshot eligibility: no gallery harvesting, no legacy backfill. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33, 35], application = Application::class)
class ScreenshotMediaMonitorTest {
    @Test fun mediaStoreNullCursorIsNotSilentlyTreatedAsEmpty() {
        try {
            requireScreenshotScanCursor(null)
            fail("A null provider cursor must trigger the bounded scan retry")
        } catch (_: IllegalStateException) {
            // The monitor's catch/finally schedules a retry.
        }
        val cursor = MatrixCursor(arrayOf("_id"))
        try {
            assertSame(cursor, requireScreenshotScanCursor(cursor))
        } finally {
            cursor.close()
        }
    }

    @Test fun screenshotsSubfolderMatches() {
        assertTrue(isSavedScreenshot("DCIM/Screenshots/", "20261030_0325.png"))
        assertTrue(isSavedScreenshot("Pictures/Screenshots/", "img.jpeg"))
        assertTrue(isSavedScreenshot("DCIM\\Screenshots\\", "capture.png"))
        assertTrue(isSavedScreenshot("dcim/screenshots/", "pic.webp"))
    }

    @Test fun filenameFallbackForCustomizedFolders() {
        assertTrue(isSavedScreenshot("DCIM/Custom/", "Screenshot_20261030.png"))
        assertTrue(isSavedScreenshot("Pictures/", "Screenshot-20261030.jpg"))
        assertTrue(isSavedScreenshot(null, "Screenshot (42).png"))
    }

    @Test fun ordinaryGalleryMediaNeverMatches() {
        assertFalse(isSavedScreenshot("DCIM/Camera/", "IMG_0081.jpg"))
        assertFalse(isSavedScreenshot("Pictures/Instagram/", "avatar.png"))
        assertFalse(isSavedScreenshot("DCIM/Screenrecordings/", "recording.mp4"))
        assertFalse(isSavedScreenshot(null, null))
        assertFalse(isSavedScreenshot("DCIM/BackupScreenshotsOld/", "IMG_0081.jpg"))
    }
}
