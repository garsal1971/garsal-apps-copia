// ============================================================
// telegram-webhook — gestisce i callback_query dai bottoni inline
//
// Telegram invia un POST a questo endpoint ogni volta che l'utente
// clicca un bottone inline su un messaggio del bot.
//
// Azioni supportate (callback_data):
//   snooze:<minutes>:<queue_id>  — sospende il promemoria per N minuti
//   cancel:<queue_id>            — annulla definitivamente il promemoria
//   complete:<queue_id>          — segna l'abitudine come completata
//
// Flusso:
//   1. Verifica header di sicurezza X-Telegram-Bot-Api-Secret-Token
//   2. Parsa il body JSON di Telegram (callback_query)
//   3. Aggiorna cm_notification_queue (status + fire_at)
//   4. Risponde a Telegram con answerCallbackQuery (obbligatorio)
//   5. Modifica il messaggio originale via editMessageText
//      (rimuove i bottoni + aggiunge riga di stato)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN  = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const WEBHOOK_SECRET      = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? ''

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Bot-Api-Secret-Token',
}

// ---------------------------------------------------------------------------
// Helpers Telegram API
// ---------------------------------------------------------------------------

async function answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`
  await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  })
}

async function editMessageText(
  chatId: number,
  messageId: number,
  text: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`
  await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:      chatId,
      message_id:   messageId,
      text,
      parse_mode:   'HTML',
      reply_markup: { inline_keyboard: [] },  // rimuove i bottoni
    }),
  })
}

// Formatta un'ora in formato HH:MM italiano
function formatTime(date: Date): string {
  return date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
}

// Formatta data e ora in formato italiano (dd/mm/yyyy HH:MM)
function formatDateTime(date: Date): string {
  const dd   = String(date.getDate()).padStart(2, '0')
  const mm   = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = date.getFullYear()
  return `${dd}/${mm}/${yyyy} ${formatTime(date)}`
}

// ---------------------------------------------------------------------------
// Handler principale
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  // ── Preflight CORS (per debug da browser) ────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  // ── Sicurezza: verifica il secret token inviato da Telegram ──────────────
  if (WEBHOOK_SECRET) {
    const incomingSecret = req.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? ''
    if (incomingSecret !== WEBHOOK_SECRET) {
      console.warn('[telegram-webhook] secret token non valido')
      return new Response('Forbidden', { status: 403 })
    }
  }

  // ── Solo POST ────────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  let update: Record<string, unknown>
  try {
    update = await req.json()
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    })

  // ── Gestisci solo callback_query ─────────────────────────────────────────
  const cq = update.callback_query as Record<string, unknown> | undefined
  if (!cq) {
    // Telegram potrebbe inviare altri tipi di update (messaggi, ecc.) — ignorali
    return json({ ok: true })
  }

  const callbackQueryId = cq.id as string
  const callbackData    = cq.data as string | undefined
  const message         = cq.message as Record<string, unknown> | undefined
  const chatId          = (message?.chat as Record<string, unknown>)?.id as number | undefined
  const messageId       = message?.message_id as number | undefined
  const originalText    = message?.text as string | undefined

  console.log(`[telegram-webhook] callback_data="${callbackData}" chat=${chatId} msg=${messageId}`)

  if (!callbackData || !chatId || !messageId) {
    await answerCallbackQuery(callbackQueryId, '❌ Dati non validi')
    return json({ ok: false, error: 'missing fields' })
  }

  // ── Parsing del callback_data ─────────────────────────────────────────────
  // Formati: "snooze:<minutes>:<uuid>" | "cancel:<uuid>" | "complete:<uuid>"
  const parts = callbackData.split(':')
  const action = parts[0]

  if (action === 'snooze' && parts.length === 3) {
    const minutes  = parseInt(parts[1], 10)
    const queueId  = parts[2]

    if (isNaN(minutes) || minutes <= 0) {
      await answerCallbackQuery(callbackQueryId, '❌ Durata sospensione non valida')
      return json({ ok: false, error: 'invalid minutes' })
    }

    const newFireAt = new Date(Date.now() + minutes * 60 * 1000)

    const { error } = await sb
      .from('cm_notification_queue')
      .update({ status: 'snoozed', fire_at: newFireAt.toISOString() })
      .eq('id', queueId)

    if (error) {
      console.error('[telegram-webhook] errore snooze:', error)
      await answerCallbackQuery(callbackQueryId, '❌ Errore durante la sospensione')
      return json({ ok: false, error: String(error) })
    }

    // Etichetta leggibile per la durata
    let label: string
    if (minutes < 60)        label = `${minutes} min`
    else if (minutes < 1440) label = `${minutes / 60} h`
    else                     label = 'domani'

    const newText = `${originalText ?? ''}\n\n⏸ <i>Sospeso — nuovo invio alle ${formatDateTime(newFireAt)}</i>`
    await answerCallbackQuery(callbackQueryId, `⏸ Sospeso per ${label}`)
    await editMessageText(chatId, messageId, newText)

  } else if (action === 'cancel' && parts.length === 2) {
    const queueId = parts[1]

    const { error } = await sb
      .from('cm_notification_queue')
      .update({ status: 'cancelled' })
      .eq('id', queueId)

    if (error) {
      console.error('[telegram-webhook] errore cancel:', error)
      await answerCallbackQuery(callbackQueryId, '❌ Errore durante l\'annullamento')
      return json({ ok: false, error: String(error) })
    }

    const newText = `${originalText ?? ''}\n\n❌ <i>Promemoria annullato</i>`
    await answerCallbackQuery(callbackQueryId, '❌ Promemoria annullato')
    await editMessageText(chatId, messageId, newText)

  } else if (action === 'complete' && parts.length === 2) {
    const queueId = parts[1]

    // Leggi la queue entry per ottenere metadata.completion_update
    const { data: queueRow, error: fetchErr } = await sb
      .from('cm_notification_queue')
      .select('metadata, entity_id, fire_at')
      .eq('id', queueId)
      .maybeSingle()

    if (fetchErr || !queueRow) {
      console.error('[telegram-webhook] errore lettura queue:', fetchErr)
      await answerCallbackQuery(callbackQueryId, '❌ Errore: promemoria non trovato')
      return json({ ok: false, error: 'queue row not found' })
    }

    const cu = (queueRow.metadata as Record<string, unknown> | null)?.completion_update as {
      app?:        string
      operations?: Array<{
        op:      string
        table:   string
        fields?: Record<string, unknown>
      }>
    } | undefined

    if (!cu?.operations?.length) {
      await answerCallbackQuery(callbackQueryId, '❌ Dati completamento non disponibili')
      return json({ ok: false, error: 'no completion_update in metadata' })
    }

    // Risolvi i template variables
    // {{fire_date_local}}: data locale (Europe/Rome) del fire_at
    // {{slot_time}}: HH:MM dal fire_at locale
    const fireAt       = new Date(queueRow.fire_at as string)
    const localDateStr = fireAt.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }) // YYYY-MM-DD
    const localTimeStr = fireAt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }) // HH:MM

    function resolveTemplates(val: unknown): unknown {
      if (typeof val !== 'string') return val
      return val
        .replace('{{fire_date_local}}', localDateStr)
        .replace('{{slot_time}}', localTimeStr)
    }

    // Esegui ogni operazione nell'array
    for (const operation of cu.operations) {
      if (operation.op === 'insert' && operation.fields) {
        const resolved: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(operation.fields)) {
          resolved[k] = resolveTemplates(v)
        }
        const { error: insertErr } = await sb.from(operation.table).insert(resolved)
        if (insertErr) {
          console.error('[telegram-webhook] errore insert completamento:', insertErr)
          await answerCallbackQuery(callbackQueryId, '❌ Errore durante il completamento')
          return json({ ok: false, error: String(insertErr) })
        }
      }
    }

    // Annulla le notifiche pending della stessa queue entry
    await sb
      .from('cm_notification_queue')
      .update({ status: 'cancelled' })
      .eq('id', queueId)

    const nowStr = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
    const newText = `${originalText ?? ''}\n\n✅ <i>Completato alle ${nowStr}</i>`
    await answerCallbackQuery(callbackQueryId, '✅ Completato!')
    await editMessageText(chatId, messageId, newText)

  } else {
    console.warn('[telegram-webhook] callback_data non riconosciuto:', callbackData)
    await answerCallbackQuery(callbackQueryId, '❓ Azione non riconosciuta')
  }

  return json({ ok: true })
})
