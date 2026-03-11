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
//   5. Elimina il messaggio cliccato e tutti i messaggi sibling (stesso occurrence_id)
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

async function editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`
  await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:      chatId,
      message_id:   messageId,
      text,
      reply_markup: { inline_keyboard: [] },
    }),
  })
}

// Elimina i messaggi Telegram degli item sibling (stesso rule_id, esclude quello corrente)
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

// Elimina i messaggi Telegram degli item con lo stesso occurrence_id
async function deleteSiblingsByOccurrence(occId: string, excludeQueueId: string, chatId: number): Promise<void> {
  const { data } = await sb
    .from('cm_notification_queue')
    .select('telegram_message_id')
    .eq('occurrence_id', occId)
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
// (usato per cancel: l'utente vuole eliminare tutti i promemoria futuri della regola)
async function cancelSiblingItems(ruleId: string, excludeQueueId: string): Promise<void> {
  const { error } = await sb
    .from('cm_notification_queue')
    .update({ status: 'cancelled' })
    .eq('rule_id', ruleId)
    .neq('id', excludeQueueId)
    .in('status', ['pending', 'snoozed', 'sending'])
  if (error) console.error('[telegram-webhook] errore cancelSiblingItems:', error)
}

// Cancella gli item pending/snoozed con lo stesso occurrence_id
// (usato per complete e snooze: opera solo sulla specifica occorrenza giorno+slot)
async function cancelByOccurrence(occId: string, excludeQueueId: string): Promise<void> {
  const { error } = await sb
    .from('cm_notification_queue')
    .update({ status: 'cancelled' })
    .eq('occurrence_id', occId)
    .neq('id', excludeQueueId)
    .in('status', ['pending', 'snoozed', 'sending'])
  if (error) console.error('[telegram-webhook] errore cancelByOccurrence:', error)
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

    // Leggi rule_id e occurrence_id per poter cancellare i promemoria correlati
    const { data: snoozeRow } = await sb
      .from('cm_notification_queue')
      .select('rule_id, occurrence_id')
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

    // Cancella i sibling dello stesso slot (occurrence_id) o fallback a rule_id
    if (snoozeRow) {
      const occId = snoozeRow.occurrence_id ?? snoozeRow.rule_id
      if (occId) {
        await deleteSiblingsByOccurrence(occId as string, queueId, chatId)
        await cancelByOccurrence(occId as string, queueId)
      }
    }
    await deleteMessage(chatId, messageId)

  } else if (action === 'cancel' && parts.length === 2) {
    const queueId = parts[1]

    // Leggi rule_id per poter cancellare tutti i promemoria futuri della regola
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

    // Cancella tutti i promemoria futuri della stessa regola (comportamento intenzionale)
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
      .select('metadata, entity_id, fire_at, rule_id, occurrence_id')
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

    if (!cu) {
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

    // Esegui ogni operazione nell'array (può essere vuoto per i task)
    for (const operation of (cu.operations ?? [])) {
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

    // Per i task, chiama l'RPC di completamento
    if (cu.app === 'tasks') {
      const taskId = queueRow.entity_id as string | undefined
      if (taskId) {
        const { data: rpcResult, error: rpcErr } = await sb.rpc('task_complete_via_telegram', {
          p_task_id: taskId,
          p_today:   localDateStr,
        })
        if (rpcErr) {
          console.error('[telegram-webhook] errore task_complete_via_telegram:', rpcErr)
          const errMsg = (rpcErr as { message?: string }).message ?? String(rpcErr)
          const shortErr = errMsg.length > 150 ? errMsg.slice(0, 147) + '…' : errMsg
          await answerCallbackQuery(callbackQueryId, `❌ ${shortErr}`)
          return json({ ok: false, error: errMsg })
        }
        // RPC può restituire { ok: false } senza errore Postgres
        const rpcData = rpcResult as { ok?: boolean; error?: string } | null
        if (rpcData?.ok === false) {
          console.warn('[telegram-webhook] task_complete_via_telegram ok=false:', rpcData)
          const shortErr = (rpcData.error ?? 'completamento non riuscito').slice(0, 150)
          await answerCallbackQuery(callbackQueryId, `❌ ${shortErr}`)
          return json({ ok: false, error: rpcData.error })
        }
        console.log('[telegram-webhook] task_complete_via_telegram:', JSON.stringify(rpcResult))
      }
    }

    // Per gli habit, calcola streak e assegna punti se lo stack è completato
    if (cu.app === 'habits') {
      const habitInsertOp = cu.operations.find(o => o.op === 'insert' && o.table === 'hb_completions')
      const habitId = habitInsertOp?.fields?.habit_id as string | undefined
      if (habitId) {
        const { data: rpcResult, error: rpcErr } = await sb.rpc('habit_post_completion', {
          p_habit_id:   habitId,
          p_local_date: localDateStr,
        })
        if (rpcErr) {
          console.error('[telegram-webhook] errore habit_post_completion:', rpcErr)
        } else {
          console.log('[telegram-webhook] habit_post_completion:', JSON.stringify(rpcResult))
        }
      }
    }

    // Segna l'item cliccato come cancelled (non deve essere reinviato)
    const { error: completeErr } = await sb
      .from('cm_notification_queue')
      .update({ status: 'cancelled' })
      .eq('id', queueId)
    if (completeErr) console.error('[telegram-webhook] errore update cancelled:', completeErr)

    const occId = (queueRow.occurrence_id as string | null) ?? (queueRow.rule_id as string)
    await cancelByOccurrence(occId, queueId)

    await answerCallbackQuery(callbackQueryId, '✅ Completato!')

    // 1. Elimina i messaggi Telegram della stessa occorrenza
    await deleteSiblingsByOccurrence(occId, queueId, chatId)

    // 2. Elimina i messaggi di reinvio precedenti della stessa entry
    //    (accumulati in metadata.telegram_message_ids da send-notifications)
    const allMsgIds = (queueRow.metadata as Record<string, unknown> | null)?.telegram_message_ids as number[] ?? []
    for (const oldMsgId of allMsgIds) {
      if (oldMsgId !== messageId) {
        await deleteMessage(chatId, oldMsgId)
      }
    }

    // 3. Elimina il messaggio cliccato
    await deleteMessage(chatId, messageId)

  } else {
    console.warn('[telegram-webhook] callback_data non riconosciuto:', callbackData)
    await answerCallbackQuery(callbackQueryId, '❓ Azione non riconosciuta')
  }

  return json({ ok: true })
})
