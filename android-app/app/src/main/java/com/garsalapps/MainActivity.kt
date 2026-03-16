package com.garsalapps

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.Calendar
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    private val APP_URL             = "https://garsal.netlify.app/"
    private val OAUTH_CALLBACK_SCHEME = "garsalapps"
    private val OAUTH_CALLBACK_HOST   = "oauth"
    private val PREFS_OAUTH           = "oauth_pending"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        setupWebView()
        scheduleNotifications()

        // Caso: app uccisa da Android mentre Chrome Custom Tabs era aperto.
        // Il deep link torna via onCreate invece di onNewIntent.
        intent?.data?.oauthFragment()?.let { saveTokensToPending(it) }

        showBiometricPrompt()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack()
                else finish()
            }
        })
    }

    /**
     * Caso normale: app in background, Chrome Custom Tabs completa l'OAuth.
     * Android chiama onNewIntent con garsalapps://oauth#access_token=...
     */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val fragment = intent?.data?.oauthFragment() ?: return
        saveTokensToPending(fragment)
        // Ricarica la pagina: onPageFinished inietterà i token
        webView.loadUrl(APP_URL)
    }

    /**
     * Salva i token OAuth in SharedPreferences (storage nativo Android).
     * Vengono iniettati nel WebView in onPageFinished dopo il prossimo caricamento.
     */
    private fun saveTokensToPending(fragment: String) {
        val params = fragment.split("&").associate { kv ->
            val eq = kv.indexOf('=')
            if (eq > 0) kv.substring(0, eq) to Uri.decode(kv.substring(eq + 1)) else kv to ""
        }
        val at = params["access_token"] ?: return  // se non c'è l'access token ignora
        val rt = params["refresh_token"] ?: ""
        val gt = params["provider_token"] ?: ""

        getSharedPreferences(PREFS_OAUTH, MODE_PRIVATE).edit()
            .putString("access_token", at)
            .putString("refresh_token", rt)
            .putString("provider_token", gt)
            .apply()
    }

    /**
     * Interfaccia JavaScript esposta al WebView come window.AndroidBridge.
     * Permette al JS di rilevare in modo affidabile che sta girando nell'app Android.
     */
    inner class AndroidBridge {
        @android.webkit.JavascriptInterface
        fun isNativeApp(): Boolean = true
    }

    private fun setupWebView() {
        webView.visibility = View.GONE
        webView.apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                cacheMode = WebSettings.LOAD_DEFAULT
                setSupportZoom(false)
                useWideViewPort = true
                loadWithOverviewMode = true
            }
            // Espone window.AndroidBridge al JavaScript della pagina
            addJavascriptInterface(AndroidBridge(), "AndroidBridge")
            webViewClient = object : WebViewClient() {

                /**
                 * Quando la pagina è completamente caricata, controlla se ci sono
                 * token OAuth in attesa in SharedPreferences e li inietta nel localStorage.
                 */
                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    if (url?.contains("garsal.netlify.app") != true) return

                    val prefs = getSharedPreferences(PREFS_OAUTH, MODE_PRIVATE)
                    val at = prefs.getString("access_token", "") ?: ""
                    if (at.isEmpty()) return

                    val rt = prefs.getString("refresh_token", "") ?: ""
                    val gt = prefs.getString("provider_token", "") ?: ""

                    // Cancella i token pending PRIMA di iniettarli (evita loop)
                    prefs.edit().clear().apply()

                    val js = buildString {
                        append("localStorage.setItem('sb_token','${at.jsEscape()}');")
                        if (rt.isNotEmpty())
                            append("localStorage.setItem('refresh_token','${rt.jsEscape()}');")
                        if (gt.isNotEmpty())
                            append("localStorage.setItem('google_token','${gt.jsEscape()}');")
                        // Chiama init() per aggiornare l'UI senza un altro reload
                        append("if(typeof init==='function')init();")
                    }
                    view?.evaluateJavascript(js, null)
                }

                /**
                 * Intercetta la navigazione verso l'endpoint OAuth di Supabase
                 * e la apre in Chrome Custom Tabs.
                 * Il redirect_to=garsalapps://oauth è già impostato dal JS
                 * tramite window.AndroidBridge.isNativeApp().
                 */
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val url = request?.url?.toString() ?: return false

                    if (url.contains("supabase.co/auth/v1/authorize") &&
                        url.contains("provider=google")
                    ) {
                        CustomTabsIntent.Builder()
                            .setShowTitle(true)
                            .build()
                            .launchUrl(this@MainActivity, request.url)
                        return true
                    }

                    return false
                }
            }
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
            flush()
        }
    }

    /** Ritorna il fragment OAuth dalla Uri se schema e host corrispondono, altrimenti null. */
    private fun Uri.oauthFragment(): String? {
        if (scheme != OAUTH_CALLBACK_SCHEME || host != OAUTH_CALLBACK_HOST) return null
        val frag = fragment ?: toString().substringAfter('#', "")
        return frag.ifEmpty { null }
    }

    /** Escapa backslash e single quote per uso sicuro in stringa JS. */
    private fun String.jsEscape() = replace("\\", "\\\\").replace("'", "\\'")

    private fun showBiometricPrompt() {
        val biometricManager = BiometricManager.from(this)
        val canAuthenticate = biometricManager.canAuthenticate(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)

        if (canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS) {
            val executor = ContextCompat.getMainExecutor(this)
            val callback = object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    showApp()
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    finish()
                }

                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                }
            }

            val promptInfo = BiometricPrompt.PromptInfo.Builder()
                .setTitle("AppSphere")
                .setSubtitle("Sblocca con impronta digitale o PIN")
                .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
                .build()

            BiometricPrompt(this, executor, callback).authenticate(promptInfo)
        } else {
            showApp()
        }
    }

    private fun showApp() {
        webView.visibility = View.VISIBLE
        webView.loadUrl(APP_URL)
    }

    private fun scheduleNotifications() {
        val wm = WorkManager.getInstance(this)

        val habitWork = PeriodicWorkRequestBuilder<NotificationWorker>(24, TimeUnit.HOURS)
            .setInputData(workDataOf(
                "type" to "habit",
                "title" to "Habit Stack",
                "message" to "Hai completato le tue abitudini oggi? 💪"
            ))
            .setInitialDelay(delayUntil(hour = 20, minute = 0), TimeUnit.MILLISECONDS)
            .build()

        val taskWork = PeriodicWorkRequestBuilder<NotificationWorker>(24, TimeUnit.HOURS)
            .setInputData(workDataOf(
                "type" to "task",
                "title" to "Tasks",
                "message" to "Controlla i tuoi task di oggi 📋"
            ))
            .setInitialDelay(delayUntil(hour = 9, minute = 0), TimeUnit.MILLISECONDS)
            .build()

        val weightWork = PeriodicWorkRequestBuilder<NotificationWorker>(7, TimeUnit.DAYS)
            .setInputData(workDataOf(
                "type" to "weight",
                "title" to "Weight Quest",
                "message" to "Ricordati di registrare il tuo peso! ⚖️"
            ))
            .setInitialDelay(delayUntil(hour = 8, minute = 0), TimeUnit.MILLISECONDS)
            .build()

        wm.enqueueUniquePeriodicWork("habit_reminder", ExistingPeriodicWorkPolicy.KEEP, habitWork)
        wm.enqueueUniquePeriodicWork("task_reminder", ExistingPeriodicWorkPolicy.KEEP, taskWork)
        wm.enqueueUniquePeriodicWork("weight_reminder", ExistingPeriodicWorkPolicy.KEEP, weightWork)
    }

    private fun delayUntil(hour: Int, minute: Int): Long {
        val now = Calendar.getInstance()
        val target = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, hour)
            set(Calendar.MINUTE, minute)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        if (target.before(now)) target.add(Calendar.DAY_OF_MONTH, 1)
        return target.timeInMillis - now.timeInMillis
    }
}
