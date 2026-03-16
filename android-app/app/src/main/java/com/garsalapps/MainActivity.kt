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

    private val APP_URL = "https://garsal.netlify.app/"

    private val OAUTH_CALLBACK_SCHEME = "garsalapps"
    private val OAUTH_CALLBACK_HOST   = "oauth"

    /**
     * Fragment OAuth salvato quando il callback arriva prima che il WebView
     * sia pronto (app uccisa da Android mentre Chrome Custom Tabs era aperto).
     */
    private var pendingOAuthFragment: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        setupWebView()
        scheduleNotifications()

        // Caso: app uccisa da Android mentre Chrome Custom Tabs era aperto.
        // Il deep link torna via onCreate invece di onNewIntent.
        intent?.data?.oauthFragment()?.let { pendingOAuthFragment = it }

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
        if (webView.visibility == View.VISIBLE) {
            injectTokensAndReload(fragment)
        } else {
            // Biometria ancora in corso — salva per dopo
            pendingOAuthFragment = fragment
        }
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
            webViewClient = object : WebViewClient() {

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // Inietta i token OAuth salvati nel localStorage non appena la pagina è pronta
                    val fragment = pendingOAuthFragment ?: return
                    if (url?.contains("garsal.netlify.app") == true) {
                        pendingOAuthFragment = null
                        injectTokensAndReload(fragment)
                    }
                }

                /**
                 * Intercetta la navigazione verso l'endpoint OAuth di Supabase
                 * e la apre in Chrome Custom Tabs, cambiando redirect_to
                 * con il custom scheme garsalapps://oauth.
                 */
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val url = request?.url?.toString() ?: return false

                    if (url.contains("supabase.co/auth/v1/authorize") &&
                        url.contains("provider=google")
                    ) {
                        val original = request.url
                        val modified = original.buildUpon()
                            .clearQuery()
                            .apply {
                                original.queryParameterNames.forEach { param ->
                                    val value = if (param == "redirect_to") {
                                        "$OAUTH_CALLBACK_SCHEME://$OAUTH_CALLBACK_HOST"
                                    } else {
                                        original.getQueryParameter(param)
                                    }
                                    appendQueryParameter(param, value)
                                }
                            }
                            .build()

                        CustomTabsIntent.Builder()
                            .setShowTitle(true)
                            .build()
                            .launchUrl(this@MainActivity, modified)
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

    /**
     * Inietta i token OAuth direttamente nel localStorage del WebView
     * tramite JavaScript, poi ricarica la pagina in modo che init() li trovi.
     * Più affidabile del passaggio via URL hash.
     */
    private fun injectTokensAndReload(fragment: String) {
        val params = fragment.split("&").associate { kv ->
            val eq = kv.indexOf('=')
            if (eq > 0) kv.substring(0, eq) to Uri.decode(kv.substring(eq + 1)) else kv to ""
        }

        val accessToken   = params["access_token"]   ?: return
        val refreshToken  = params["refresh_token"]  ?: ""
        val providerToken = params["provider_token"] ?: ""

        val js = buildString {
            append("localStorage.setItem('sb_token','${accessToken.jsEscape()}');")
            if (refreshToken.isNotEmpty())
                append("localStorage.setItem('refresh_token','${refreshToken.jsEscape()}');")
            if (providerToken.isNotEmpty())
                append("localStorage.setItem('google_token','${providerToken.jsEscape()}');")
            append("window.location.reload();")
        }

        webView.evaluateJavascript(js, null)
    }

    /** Ritorna il fragment OAuth dalla Uri se schema e host corrispondono, altrimenti null. */
    private fun Uri.oauthFragment(): String? {
        if (scheme != OAUTH_CALLBACK_SCHEME || host != OAUTH_CALLBACK_HOST) return null
        val frag = fragment ?: toString().substringAfter('#', "")
        return frag.ifEmpty { null }
    }

    /** Escapa i single quote per uso sicuro in stringa JS. */
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
