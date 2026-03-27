# AppSphere — App Android

App Android che carica AppSphere (Netlify) con:
- **Impronta digitale** all'avvio (o PIN come fallback)
- **Sessione persistente** — nessun login ripetuto
- **Notifiche native** schedulate (task, abitudini, peso)

---

## Come aprire il progetto in Android Studio

1. Apri **Android Studio**
2. Clicca **Open** → seleziona questa cartella `android-app/`
3. Aspetta che Gradle scarichi le dipendenze (~2 min la prima volta)

---

## Cambia la URL (OBBLIGATORIO)

Apri `app/src/main/java/com/garsalapps/MainActivity.kt` e modifica la riga:

```kotlin
private val APP_URL = "https://garsal-apps.netlify.app"
```

Sostituisci con la tua URL Netlify reale.

---

## Build APK

1. Menu → **Build → Build Bundle(s) / APK(s) → Build APK(s)**
2. Attendi la compilazione
3. Clicca **locate** nel popup → trovi il file `.apk` in:
   `app/build/outputs/apk/debug/app-debug.apk`

---

## Installa sul telefono

1. Copia il file `.apk` sul telefono (USB, email, WhatsApp)
2. Sul telefono: **Impostazioni → Sicurezza → Sorgenti sconosciute** → abilita
3. Apri il file `.apk` → installa
4. Prima apertura: login Google normale
5. Dalla seconda apertura in poi: solo impronta digitale 🎉

---

## Notifiche schedulate

| Notifica | Orario |
|---|---|
| Task — controlla task di oggi | Ogni giorno alle 09:00 |
| Habit Stack — abitudini completate? | Ogni giorno alle 20:00 |
| Weight Quest — registra il peso | Ogni settimana alle 08:00 |

Per cambiare orari modifica `scheduleNotifications()` in `MainActivity.kt`.

---

## Struttura file

```
android-app/
├── app/
│   └── src/main/
│       ├── java/com/garsalapps/
│       │   ├── MainActivity.kt        ← WebView + Biometria + Notifiche
│       │   └── NotificationWorker.kt  ← Logica notifiche
│       ├── res/
│       │   ├── layout/activity_main.xml
│       │   ├── values/strings.xml
│       │   ├── values/themes.xml
│       │   └── drawable/ic_notification.xml
│       └── AndroidManifest.xml
├── build.gradle
├── settings.gradle
└── gradle.properties
```
