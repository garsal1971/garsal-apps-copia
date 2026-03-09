// ============================================================
// telegram-webhook — gestisce i callback_query dai bottoni inline
// verify_jwt = false (vedi config.toml) — Telegram non invia JWT
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
//   5. Elimina il messaggio cliccato e tutti i messaggi sibling (stesso rule_id)
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

async function deleteMessage(chatId: number, messageId: number): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`
  await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, message_id: messageId }),
  })
}

// Elimina i messaggi Telegram di tutti gli item sibling (stesso rule_id)
async function deleteSiblingMessages(ruleId: string, excludeQueueId: string, chatId: number): Promise<void> {
  const { data } = await sb
    .from('cm_notification_queue')
    .select('telegram_message_id')
    .eq('rule_id', ruleId)
    .neq('id', excludeQueueId)
    .not('telegram_message_id', 'is', null)
  if (!data) return
  for (const row of data) {
    if (row.telegram_message_id) {
      await deleteMessage(chatId, row.telegram_message_id as number)
    }
  }
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

// Cancella tutti gli altri item pendenti/snoozed della stessa regola
// (chiamata dopo ogni azione dell'utente per rimuovere notifiche duplicate)
async function cancelSiblingItems(ruleId: string, excludeQueueId: string): Promise<void> {
  const { error } = await sb
    .from('cm_notification_queue')
    .update({ status: 'cancelled' })
    .eq('rule_id', ruleId)
    .neq('id', excludeQueueId)
    .in('status', ['pending', 'snoozed', 'sending'])
  if (error) console.error('[telegram-webhook] errore cancelSiblingItems:', error)
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

    // Leggi rule_id per poter cancellare i promemoria correlati
    const { data: snoozeRow } = await sb
      .from('cm_notification_queue')
      .select('rule_id')
      .eq('id', queueId)
      .maybeSingle()

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

    await answerCallbackQuery(callbackQueryId, `⏸ Sospeso per ${label}`)

    // Elimina i messaggi sibling + cancella dalla coda, poi elimina il messaggio cliccato
    if (snoozeRow?.rule_id) {
      await deleteSiblingMessages(snoozeRow.rule_id as string, queueId, chatId)
      await cancelSiblingItems(snoozeRow.rule_id as string, queueId)
    }
    await deleteMessage(chatId, messageId)

  } else if (action === 'cancel' && parts.length === 2) {
    const queueId = parts[1]

    // Leggi rule_id per poter cancellare i promemoria correlati
    const { data: cancelRow } = await sb
      .from('cm_notification_queue')
      .select('rule_id')
      .eq('id', queueId)
      .maybeSingle()

    const { error } = await sb
      .from('cm_notification_queue')
      .update({ status: 'cancelled' })
      .eq('id', queueId)

    if (error) {
      console.error('[telegram-webhook] errore cancel:', error)
      await answerCallbackQuery(callbackQueryId, '❌ Errore durante l\'annullamento')
      return json({ ok: false, error: String(error) })
    }

    await answerCallbackQuery(callbackQueryId, '❌ Promemoria annullato')

    // Elimina i messaggi sibling + cancella dalla coda, poi elimina il messaggio cliccato
    if (cancelRow?.rule_id) {
      await deleteSiblingMessages(cancelRow.rule_id as string, queueId, chatId)
      await cancelSiblingItems(cancelRow.rule_id as string, queueId)
    }
    await deleteMessage(chatId, messageId)

  } else if (action === 'complete' && parts.length === 2) {
    const queueId = parts[1]

    // Leggi la queue entry per ottenere metadata.completion_update
    const { data: queueRow, error: fetchErr } = await sb
      .from('cm_notification_queue')
      .select('metadata, entity_id, fire_at, rule_id')
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

    // Leggi slot_time dal metadata (orario reale del habit, es. "08:00")
    const metadata  = queueRow.metadata as Record<string, unknown> | null
    const slotTime  = metadata?.slot_time as string | undefined

    // Risolvi i template variables
    // {{fire_date_local}}: data locale (Europe/Rome) del fire_at
    // {{slot_time}}: orario del slot habit (da metadata) — fallback a fire_at locale
    const fireAt       = new Date(queueRow.fire_at as string)
    const localDateStr = fireAt.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }) // YYYY-MM-DD
    const localTimeStr = slotTime
      ?? fireAt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })

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

    // Cancella le entry pending/sending dello stesso slot (rule_id + slot_time + giorno UTC)
    // Evita di cancellare altri slot dello stesso habit (es. 08:00 vs 22:00)
    const fireDay    = (queueRow.fire_at as string).slice(0, 10) // YYYY-MM-DD
    const cancelBase = sb
      .from('cm_notification_queue')
      .update({ status: 'cancelled' })
      .eq('rule_id', queueRow.rule_id as string)
      .in('status', ['pending', 'sending'])
      .gte('fire_at', `${fireDay}T00:00:00.000Z`)
      .lte('fire_at', `${fireDay}T23:59:59.999Z`)

    await (slotTime
      ? cancelBase.filter('metadata->>slot_time', 'eq', slotTime)
      : cancelBase)

    await answerCallbackQuery(callbackQueryId, '✅ Completato!')

    // Elimina i messaggi sibling + cancella dalla coda, poi elimina il messaggio cliccato
    await deleteSiblingMessages(queueRow.rule_id as string, queueId, chatId)
    await cancelSiblingItems(queueRow.rule_id as string, queueId)
    await deleteMessage(chatId, messageId)

  } else {
    console.warn('[telegram-webhook] callback_data non riconosciuto:', callbackData)
    await answerCallbackQuery(callbackQueryId, '❓ Azione non riconosciuta')
  }

  return json({ ok: true })
})
