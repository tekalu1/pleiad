package com.procway.pleiad

import android.app.Application
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.procway.pleiad.remote.FileDeviceStore
import com.procway.pleiad.remote.ProxyTexts
import com.procway.pleiad.remote.RemoteDevice
import java.io.File

/** Holds the one RemoteDevice (host list, pairing, proxies) shared by the host list and the host windows. */
class PleiadApp : Application() {
    lateinit var device: RemoteDevice
        private set

    override fun onCreate() {
        super.onCreate()
        val texts = object : ProxyTexts {
            override fun locale() = resources.configuration.locales[0].language
            override fun title(state: String) = getString(if (state == "revoked") R.string.remote_revoked else R.string.remote_host_offline)
            override fun body(state: String) = getString(
                when (state) {
                    "revoked" -> R.string.remote_page_revoked
                    "host-offline" -> R.string.remote_page_host_offline
                    else -> R.string.remote_page_offline
                },
            )
            override fun tokenRequired() = getString(R.string.remote_token_required)
            override fun lost() = getString(R.string.remote_lost)
        }
        device = RemoteDevice(
            FileDeviceStore(File(noBackupFilesDir, "remote"), KeystoreCipher()),
            app = BuildConfig.VERSION_NAME,
            name = deviceName(),
            platform = "android",
            texts = texts,
            log = { Log.i("Pleiad", it) },
        )
    }

    fun deviceName(): String =
        Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()
}
