package com.garsalapps

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class NotificationWorker(
    private val context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val type    = inputData.getString("type")    ?: return Result.failure()
        val title   = inputData.getString("title")   ?: "AppSphere"
        val message = inputData.getString("message") ?: ""

        sendNotification(type, title, message)
        return Result.success()
    }

    private fun sendNotification(type: String, title: String, message: String) {
        val channelId = "appsphere_$type"
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // Crea il canale (richiesto da Android 8+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                title,
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply { description = message }
            nm.createNotificationChannel(channel)
        }

        // Tap sulla notifica → apre l'app
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        val pendingIntent = PendingIntent.getActivity(
            context, type.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()

        val notificationId = when (type) {
            "habit"  -> 1
            "task"   -> 2
            "weight" -> 3
            else     -> 0
        }
        nm.notify(notificationId, notification)
    }
}
