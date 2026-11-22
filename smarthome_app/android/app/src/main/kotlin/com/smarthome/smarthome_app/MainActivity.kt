package com.smarthome.smarthome_app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createNotificationChannels()
    }

    /**
     * The channels push notifications name (docs/architecture/push.md):
     * "alerts" for fire, gas, door and security warnings (sound, heads-up),
     * "general" for the rest. Users can tune each one in the phone settings.
     */
    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val alerts = NotificationChannel(
            "alerts", "Cảnh báo an toàn và an ninh", NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "Cháy, khí gas, khói, cửa ra vào và cảnh báo bảo mật"
            enableVibration(true)
            enableLights(true)
        }
        val general = NotificationChannel(
            "general", "Thông báo chung", NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Tự động hóa, thanh toán, chia sẻ thiết bị và gói trợ lý"
        }
        manager.createNotificationChannels(listOf(alerts, general))
    }
}
