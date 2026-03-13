// ============================================================
// telegram-webhook — gestisce i callback_query dai bottoni inline
// verify_jwt = false (vedi config.toml) — Telegram non invia JWT
//
// Telegram invia un POST a questo endpoint ogni volta che l'utente
// clicca un bottone inline su un messaggio del bot.
//
// Azioni supportate (callback_data):
//   snooze:<minutes>:<queue_id>  — reinserisce il promemoria con nuovo fire_at
//   cancel:<queue_id>            — annulla i pending della stessa occorrenza (senza completamento)
//   complete:<queue_id>          — annulla i pending della stessa occorrenza + esegue completamento
//
// Flusso snooze:
//   1. Legge il row originale per copiarne i campi
//   2. Cancella i pending siblings (stesso occurrence_id) per evitare duplicati
//   3. INSERT nuovo row pending con il nuovo fire_at
//   4. Elimina il messaggio Telegram corrente
//
// Flusso cancel:
//   Cancella tutti i pending con stesso occurrence_id. Nessun completamento.
//
// Flusso complete:
//   Cancella tutti i pending con stesso occurrence_id. Esegue l'azione di completamento.
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

// Cancella gli item pending con lo stesso occurrence_id
// (usato per complete e snooze: opera solo sulla specifica occorrenza giorno+slot)
async function cancelByOccurrence(occId: string, excludeQueueId: string): Promise<void> {
  const { error } = await sb
    .from('cm_notification_queue')
    .update({ status: 'cancelled' })
    .eq('occurrence_id', occId)
    .neq('id', excludeQueueId)
    .eq('status', 'pending')
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

    // Leggi il row originale per copiarne i campi nel nuovo insert
    const { data: original } = await sb
      .from('cm_notification_queue')
      .select('rule_id, user_id, app, entity_id, title, body, channel, occurrence_id, metadata')
      .eq('id', queueId)
      .maybeSingle()

    if (!original) {
      await answerCallbackQuery(callbackQueryId, '❌ Promemoria non trovato')
      return json({ ok: false, error: 'queue row not found' })
    }

    // Cancella i pending siblings (stesso occurrence_id) per non duplicare
    await cancelByOccurrence(original.occurrence_id as string, queueId)
    await deleteSiblingsByOccurrence(original.occurrence_id as string, queueId, chatId)

    // Inserisce un nuovo row pending con il nuovo fire_at
    const { error: insertErr } = await sb
      .from('cm_notification_queue')
      .insert({
        rule_id:       original.rule_id,
        user_id:       original.user_id,
        app:           original.app,
        entity_id:     original.entity_id,
        title:         original.title,
        body:          original.body,
        channel:       original.channel,
        fire_at:       newFireAt.toISOString(),
        status:        'pending',
        occurrence_id: original.occurrence_id,
        metadata:      original.metadata,
      })

    if (insertErr) {
      console.error('[telegram-webhook] errore snooze insert:', insertErr)
      await answerCallbackQuery(callbackQueryId, '❌ Errore durante la sospensione')
      return json({ ok: false, error: String(insertErr) })
    }

    // Etichetta leggibile per la durata
    let label: string
    if (minutes < 60)        label = `${minutes} min`
    else if (minutes < 1440) label = `${minutes / 60} h`
    else                     label = 'domani'

    await answerCallbackQuery(callbackQueryId, `⏸ Sospeso per ${label}`)
    await deleteMessage(chatId, messageId)

  } else if (action === 'cancel' && parts.length === 2) {
    const queueId = parts[1]

    // Leggi occurrence_id e rule_id per cancellare solo la stessa occorrenza
    const { data: cancelRow } = await sb
      .from('cm_notification_queue')
      .select('rule_id, occurrence_id')
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

    // Cancella TUTTI i row della stessa occorrenza, qualsiasi stato (no completamento)
    const cancelOccId = cancelRow?.occurrence_id as string | null
    if (cancelOccId) {
      await deleteSiblingsByOccurrence(cancelOccId, queueId, chatId)
      const { error: cancelAllErr } = await sb
        .from('cm_notification_queue')
        .update({ status: 'cancelled' })
        .eq('occurrence_id', cancelOccId)
        .neq('id', queueId)
      if (cancelAllErr) console.error('[telegram-webhook] errore cancelAll:', cancelAllErr)
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

    // Cancella i pending della stessa occorrenza + segna il row cliccato come cancelled
    const occId = queueRow.occurrence_id as string | null
    if (occId) {
      await cancelByOccurrence(occId, queueId)
      await deleteSiblingsByOccurrence(occId, queueId, chatId)
    }
    await sb
      .from('cm_notification_queue')
      .update({ status: 'cancelled' })
      .eq('id', queueId)

    await answerCallbackQuery(callbackQueryId, '✅ Completato!')
    await deleteMessage(chatId, messageId)

  } else {
    console.warn('[telegram-webhook] callback_data non riconosciuto:', callbackData)
    await answerCallbackQuery(callbackQueryId, '❓ Azione non riconosciuta')
  }

  return json({ ok: true })
})
