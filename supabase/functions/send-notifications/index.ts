// ============================================================
// Job 2 — send-notifications
// Frequenza: ogni 5 minuti (cron: "*/5 * * * *")
//
// Logica semplificata:
//   Trova i row status='pending' con fire_at nel range [now-5min, now+5min].
//   Per ciascuno invia la notifica Telegram.
//   Invio OK  → status = 'sent'
//   Invio KO  → status = 'failed'  (nessun retry)
//   Scrive sempre in cm_notification_log.
//
// Stati attivi: pending | sent | failed | cancelled
// Stati dismessi: sending (nessun retry), snoozed (sostituito da INSERT nuovo row)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------
interface QueueItem {
  id:                   string
  rule_id:              string
  user_id:              string
  app:                  string
  entity_id:            string
  title:                string
  body:                 string
  channel:              string
  fire_at:              string
  status:               string
  created_at:           string
  telegram_message_id?: number | null
  metadata?:            { completion_update?: Record<string, unknown>; telegram_cancel_button?: boolean } | null
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
async function sendTelegram(
  chatId: string,
  text: string,
  replyMarkup?: object
): Promise<{ ok: boolean; response: string; message_id?: number }> {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  }
  if (replyMarkup) {
    payload.reply_markup = replyMarkup
  }
  const res      = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  })
  const bodyText = await res.text()
  let message_id: number | undefined
  try {
    const parsed = JSON.parse(bodyText)
    message_id = parsed?.result?.message_id
  } catch {
    // ignore parse error
  }
  return { ok: res.ok, response: bodyText, message_id }
}

// Costruisce la inline keyboard con le opzioni snooze + annulla
// Se completeButton è true aggiunge il pulsante "✅ Fatto" come prima riga
function buildInlineKeyboard(itemId: string, completeButton = false, cancelButton = true): object {
  const rows: object[][] = []
  if (completeButton) {
    rows.push([{ text: '✅ Fatto', callback_data: `complete:${itemId}` }])
  }
  rows.push([
    { text: '⏸ 30min',  callback_data: `snooze:30:${itemId}`   },
    { text: '⏸ 1h',     callback_data: `snooze:60:${itemId}`   },
  ])
  rows.push([
    { text: '⏸ 3h',     callback_data: `snooze:180:${itemId}`  },
    { text: '⏸ Domani', callback_data: `snooze:1440:${itemId}` },
  ])
  const lastRow: object[] = []
  if (cancelButton) lastRow.push({ text: '❌ Annulla promemoria', callback_data: `cancel:${itemId}` })
  lastRow.push({ text: '🗑 Chiudi', callback_data: `dismiss:${itemId}` })
  rows.push(lastRow)
  return { inline_keyboard: rows }
}

// ---------------------------------------------------------------------------
// Handler principale
// ---------------------------------------------------------------------------
Deno.serve(async (_req) => {
  try {
    const nowDate   = new Date()
    const now       = nowDate.toISOString()
    const WINDOW_MS = 5 * 60 * 1000
    const windowMin = new Date(nowDate.getTime() - WINDOW_MS).toISOString()
    const windowMax = new Date(nowDate.getTime() + WINDOW_MS).toISOString()

    // Trova i row pending nella finestra ±5 minuti
    const { data: items, error: fetchError } = await sb
      .from('cm_notification_queue')
      .select('*')
      .eq('status', 'pending')
      .gte('fire_at', windowMin)
      .lte('fire_at', windowMax)
      .order('fire_at', { ascending: true })

    if (fetchError) throw fetchError

    let sent   = 0
    let failed = 0

    // Cache impostazioni utente per evitare query ripetute
    const settingsCache = new Map<string, { telegram_chat_id: string | null; telegram_enabled: boolean } | null>()

    async function getUserSettings(userId: string) {
      if (settingsCache.has(userId)) return settingsCache.get(userId)!
      const { data } = await sb
        .from('cm_user_notification_settings')
        .select('telegram_chat_id, telegram_enabled')
        .eq('user_id', userId)
        .single()
      settingsCache.set(userId, data ?? null)
      return data ?? null
    }

    for (const item of (items as QueueItem[]) ?? []) {
      const settings    = await getUserSettings(item.user_id)
      let responseText  = ''
      let errorMsg      = ''
      let telegramOk    = false
      let telegramMsgId: number | undefined

      if (
        item.channel === 'telegram' &&
        settings?.telegram_enabled &&
        settings?.telegram_chat_id
      ) {
        const message     = `${item.title}\n${item.body}`
        const hasComplete = !!(item.metadata?.completion_update)
        const hasCancel   = item.metadata?.telegram_cancel_button ?? true
        const replyMarkup = buildInlineKeyboard(item.id, hasComplete, hasCancel)
        const result      = await sendTelegram(settings.telegram_chat_id, message, replyMarkup)
        telegramOk        = result.ok
        responseText      = result.response
        telegramMsgId     = result.message_id
        if (!result.ok) errorMsg = `Telegram API error: ${result.response}`
      } else {
        errorMsg = 'Canale non configurato o disabilitato'
      }

      const newStatus = telegramOk ? 'sent' : 'failed'
      const updatePayload: Record<string, unknown> = { status: newStatus }
      if (telegramMsgId) updatePayload.telegram_message_id = telegramMsgId

      await sb
        .from('cm_notification_queue')
        .update(updatePayload)
        .eq('id', item.id)

      if (telegramOk) sent++
      else failed++
    }

    const total = (items as QueueItem[])?.length ?? 0
    console.log(`[send-notif] done — total:${total} sent:${sent} failed:${failed} window:[${windowMin},${windowMax}]`)

    return new Response(
      JSON.stringify({ ok: true, total, sent, failed }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('[send-notif] fatal:', err)
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
