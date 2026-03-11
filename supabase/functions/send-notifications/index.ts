// ============================================================
// Job 2 — send-notifications
// Frequenza: ogni 5 minuti (cron: "*/5 * * * *")
//
// Logica con contatore (send_count, max 5 tentativi):
//
//   FASE 0 — snoozed → pending (wake-up)
//     Trova elementi status='snoozed' con fire_at <= now.
//     Li riporta a 'pending' così la Fase 1 li processa nello stesso run.
//
//   FASE 1 — pending → sending
//     Legge status='pending' con fire_at <= now.
//     Imposta status='sending', send_count=1 e invia la notifica.
//
//   FASE 2 — sending → sending | sent
//     Legge status='sending' con send_count < 5.
//     Incrementa send_count e reinvia.
//     Se send_count raggiunge 5 → imposta status='sent'.
//
//   FASE 3 — digest
//     Raccoglie gli elementi appena diventati 'sent' in questo run.
//     Invia UNA sola notifica Telegram per utente con il riepilogo
//     di tutti quei messaggi. Lo status 'sent' NON viene modificato.
//
// Max 50 notifiche per run (25 pending + 25 sending) per evitare timeout.
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
  send_count:           number
  created_at:           string
  telegram_message_id?: number | null
  metadata?:            { completion_update?: Record<string, unknown> } | null
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
  const res  = await fetch(url, {
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
function buildInlineKeyboard(itemId: string, completeButton = false): object {
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
  rows.push([{ text: '❌ Annulla promemoria', callback_data: `cancel:${itemId}` }])
  return { inline_keyboard: rows }
}

// ---------------------------------------------------------------------------
// Handler principale
// ---------------------------------------------------------------------------
Deno.serve(async (_req) => {
  try {
    const now = new Date().toISOString()

    // ── FASE 0: snoozed → pending (wake-up) ──────────────────────────────
    // Gli item sospesi dall'utente tornano a 'pending' quando fire_at <= now.
    // La Fase 1 li raccoglierà nello stesso run.
    const { error: snoozeWakeError } = await sb
      .from('cm_notification_queue')
      .update({ status: 'pending' })
      .eq('status', 'snoozed')
      .lte('fire_at', now)

    if (snoozeWakeError) throw snoozeWakeError

    // ── FASE 1: elementi pending ──────────────────────────────────────────
    const { data: pendingItems, error: pendingError } = await sb
      .from('cm_notification_queue')
      .select('*')
      .eq('status', 'pending')
      .lte('fire_at', now)
      .order('fire_at', { ascending: true })
      .limit(25)

    if (pendingError) throw pendingError

    // ── FASE 2: elementi sending (da riprovare) ───────────────────────────
    const { data: sendingItems, error: sendingError } = await sb
      .from('cm_notification_queue')
      .select('*')
      .eq('status', 'sending')
      .lt('send_count', 5)
      .order('fire_at', { ascending: true })
      .limit(25)

    if (sendingError) throw sendingError

    const allItems: QueueItem[] = [
      ...(pendingItems ?? []),
      ...(sendingItems ?? []),
    ]

    let sent   = 0
    let failed = 0

    // Raccoglie gli item che diventano 'sent' in questo run per il digest
    const justSentItems: QueueItem[] = []

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

    // ── Processa ogni item ─────────────────────────────────────────────────
    for (const item of allItems) {
      const newCount  = (item.send_count ?? 0) + 1
      const newStatus = newCount >= 5 ? 'sent' : 'sending'

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
        const message      = `${item.title}\n${item.body}`
        const hasComplete  = !!(item.metadata?.completion_update)
        const replyMarkup  = buildInlineKeyboard(item.id, hasComplete)
        const result       = await sendTelegram(settings.telegram_chat_id, message, replyMarkup)
        telegramOk         = result.ok
        responseText       = result.response
        telegramMsgId      = result.message_id
        if (!result.ok) errorMsg = `Telegram API error: ${result.response}`
      } else {
        errorMsg = 'Canale non configurato o disabilitato'
      }

      // Aggiorna status, contatore e (se disponibile) il message_id Telegram nella queue.
      // Accumula tutti gli ID inviati in metadata.telegram_message_ids per poterli
      // cancellare tutti al click su Fatto (anche quelli di reinvii precedenti).
      const updatePayload: Record<string, unknown> = { status: newStatus, send_count: newCount }
      if (telegramMsgId) {
        updatePayload.telegram_message_id = telegramMsgId
        const existingMeta = (item.metadata ?? {}) as Record<string, unknown>
        const existingIds  = (existingMeta.telegram_message_ids ?? []) as number[]
        updatePayload.metadata = {
          ...existingMeta,
          telegram_message_ids: [...existingIds, telegramMsgId],
        }
      }
      await sb
        .from('cm_notification_queue')
        .update(updatePayload)
        .eq('id', item.id)
        .in('status', ['pending', 'sending'])

      // Scrivi nel log storico
      await sb.from('cm_notification_log').insert({
        queue_id:  item.id,
        user_id:   item.user_id,
        app:       item.app,
        entity_id: item.entity_id,
        title:     item.title,
        channel:   item.channel,
        fired_at:  now,
        status:    telegramOk ? 'sent' : 'failed',
        response:  responseText || null,
        error_msg: errorMsg     || null,
      })

      if (telegramOk) sent++
      else failed++

      // Tieni traccia degli item appena promossi a 'sent'
      if (newStatus === 'sent') {
        justSentItems.push(item)
      }
    }

    // ── FASE 3: digest per gli item appena diventati 'sent' ───────────────
    // Raggruppa per user_id e invia UN solo messaggio per utente.
    // Il digest NON include bottoni inline (aggruppa più item).
    // Lo status 'sent' non viene modificato.
    let digestSent = 0

    if (justSentItems.length > 0) {
      const byUser = new Map<string, QueueItem[]>()
      for (const item of justSentItems) {
        const list = byUser.get(item.user_id) ?? []
        list.push(item)
        byUser.set(item.user_id, list)
      }

      for (const [userId, items] of byUser) {
        const settings = await getUserSettings(userId)
        if (settings?.telegram_enabled && settings?.telegram_chat_id) {
          const lines = items.map(i => `• <b>${i.title}</b>\n  ${i.body}`)
          const digestText =
            `📋 <b>Riepilogo notifiche (${items.length})</b>\n\n` +
            lines.join('\n\n')
          await sendTelegram(settings.telegram_chat_id, digestText)
          digestSent++
        }
      }
    }

    const total = allItems.length
    console.log(
      `[send-notif] done — total:${total} sent:${sent} failed:${failed}` +
      ` digest-users:${digestSent} digest-items:${justSentItems.length}`
    )

    return new Response(
      JSON.stringify({ ok: true, total, sent, failed, digest_users: digestSent, digest_items: justSentItems.length }),
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
