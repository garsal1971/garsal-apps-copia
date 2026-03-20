// ============================================================
// Job 1 — fill-notification-queue
// Frequenza: ogni 6 ore (cron: "0 */6 * * *")
// Aggiornato: 2026-03-11 — refactoring occorrenze e body unificato
//
// Concetti chiave:
//   REGOLA  = 1 row in cm_notification_rules (configurazione persistente)
//   OCCORRENZA = entity + data specifica + ora specifica
//             → da una regola habit si generano N occorrenze (una per giorno × slot)
//             → da una regola task si genera 1 occorrenza (la data di scadenza)
//   NOTIFICA = 1 row in cm_notification_queue
//             → per ogni occorrenza si generano K notifiche (una per preset reminder)
//             → tutte le notifiche della stessa occorrenza condividono occurrence_id
//             → si distinguono solo per fire_at (= ora occorrenza − offset preset)
//
// Formato occurrence_id (uniforme per task e habit):
//   "{rule_id}:{YYYY-MM-DD}:{HH:MM}"
//
// Formato body (uniforme per task e habit):
//   "{entity_title} — {preset_label} prima — DD/MM/YYYY[ ore HH:MM]"
//   (l'ora è omessa se è 00:00, ossia task senza orario specifico)
//
// Strutture reminder_presets:
//
// TASKS:
//   { "reminders": [1, 3], "due_at": "2026-03-10T10:00:00Z" }
//
// HABITS (daily / daily_multiple):
//   { "reminders": [1, 3], "times": ["08:00","22:00"], "from-to": ["2026-03-01","2026-05-30"] }
// HABITS (weekly):
//   { "reminders": [1, 3], "days": [1,3,5], "times": ["08:00"], "from-to": ["2026-03-01","2026-05-30"] }
//
// Idempotente: UPSERT su conflict (rule_id, fire_at)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Orizzonte massimo: genera notifiche solo entro 7 giorni da ora
const HORIZON_DAYS   = 7
// Finestra di sicurezza: non toccare entry che sparano entro 2 minuti
const SAFE_WINDOW_MS = 2 * 60 * 1000

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------
interface TaskReminderPresets {
  reminders:               number[]
  due_at:                  string     // ISO timestamptz — scadenza task
  telegram_complete_button?: boolean
}

interface QuickReminderPresets {
  fire_at:                string   // ISO datetime — ora esatta della notifica
  telegram_snooze_button?: boolean
  telegram_cancel_button?: boolean
}

interface HabitReminderPresets {
  reminders: number[]
  times:     string[]           // ["HH:MM", ...]
  'from-to': [string, string | null]  // [started_at, end_date | null]
  days?:     number[]           // [0-6] solo per weekly (0=domenica)
  telegram_complete_button?: boolean
  completion_update?: {
    app:        string
    operations: Array<{
      op:     string
      table:  string
      fields?: Record<string, unknown>
      set?:   Record<string, unknown>
      where?: Record<string, unknown>
    }>
  }
}

type ReminderPresetsJson = TaskReminderPresets | HabitReminderPresets | QuickReminderPresets

interface Rule {
  id:               string
  user_id:          string
  app:              string
  entity_id:        string
  entity_title:     string | null
  entity_type:      string | null   // frequency per habit: 'daily'|'daily_multiple'|'weekly'
  reminder_presets: ReminderPresetsJson
  channel:          string
}

interface Preset {
  int_id:         number
  label:          string
  offset_minutes: number
}

interface QueueEntry {
  fire_at:         string
  label:           string
  time:            string   // HH:MM — ora dell'occorrenza (slot habit o ora di due_at per task)
  occurrence_id:   string   // ruleId:YYYY-MM-DD:HH:MM (stesso formato per task e habit)
  occurrence_date: string   // YYYY-MM-DD — data dell'occorrenza (per buildBody)
}

// ---------------------------------------------------------------------------
// Handler principale
// ---------------------------------------------------------------------------
Deno.serve(async (_req) => {
  try {
    const now        = new Date()
    const horizon    = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000)
    const safeDelete = new Date(now.getTime() + SAFE_WINDOW_MS)

    // 0. Pulizia: elimina notifiche in stato terminale
    // NOTA: 'sent' NON è incluso qui perché i messaggi Telegram con bottone "Fatto"
    // devono rimanere accessibili finché l'utente non clicca il bottone.
    // I 'sent' vengono puliti separatamente con un cutoff di 7 giorni.
    const TERMINAL_STATUSES = ['failed', 'cancelled', 'completed']
    const { error: cleanErr, count: cleanCount } = await sb
      .from('cm_notification_queue')
      .delete({ count: 'exact' })
      .in('status', TERMINAL_STATUSES)

    if (cleanErr) {
      console.error('[fill-queue] pulizia stati terminali error:', cleanErr)
    } else {
      console.log(`[fill-queue] pulizia stati terminali: ${cleanCount ?? 0} righe eliminate`)
    }

    // Pulizia separata per 'sent' più vecchi di 7 giorni (evita crescita tabella)
    const sentCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { error: sentCleanErr, count: sentCleanCount } = await sb
      .from('cm_notification_queue')
      .delete({ count: 'exact' })
      .eq('status', 'sent')
      .lt('fire_at', sentCutoff)

    if (sentCleanErr) {
      console.error('[fill-queue] pulizia sent vecchi error:', sentCleanErr)
    } else {
      console.log(`[fill-queue] pulizia sent >7gg: ${sentCleanCount ?? 0} righe eliminate`)
    }

    // 1. Carica tutti i preset → mappa int_id → {label, offset_minutes}
    const { data: presetsRows, error: presetsError } = await sb
      .from('cm_reminder_presets')
      .select('int_id, label, offset_minutes')

    if (presetsError) throw presetsError

    const presetsMap = new Map<number, { label: string; offset_minutes: number }>()
    for (const p of (presetsRows as Preset[]) ?? []) {
      presetsMap.set(p.int_id, { label: p.label, offset_minutes: p.offset_minutes })
    }
    console.log(`[fill-queue] preset caricati: ${presetsMap.size}`)

    // 2. Carica tutte le regole attive
    const { data: rules, error: rulesError } = await sb
      .from('cm_notification_rules')
      .select('id, user_id, app, entity_id, entity_title, entity_type, reminder_presets, channel')
      .eq('enabled', true)

    if (rulesError) throw rulesError

    let inserted = 0
    let skipped  = 0
    let deleted  = 0
    let errors   = 0

    for (const rule of (rules as Rule[]) ?? []) {
      const rp = rule.reminder_presets

      // Detect struttura: quick (app='quick') | habit (times[]) | task (due_at)
      const isQuick = rule.app === 'quick'
      const isHabit = !isQuick && Array.isArray((rp as HabitReminderPresets).times)

      let entries: QueueEntry[]

      if (isQuick) {
        const qrp = rp as QuickReminderPresets
        if (!qrp.fire_at) {
          console.warn(`[fill-queue] regola quick ${rule.id} senza fire_at, skip`)
          skipped++
          continue
        }
        entries = generateQuickEntry(qrp, now, horizon, rule.id)
      } else if (!rp?.reminders?.length) {
        console.warn(`[fill-queue] regola ${rule.id} senza reminders, skip`)
        skipped++
        continue
      } else if (isHabit) {
        const hrp = rp as HabitReminderPresets
        if (!hrp.times?.length || !hrp['from-to']?.[0]) {
          console.warn(`[fill-queue] regola habit ${rule.id} senza times o from-to, skip`)
          skipped++
          continue
        }
        entries = generateHabitEntries(hrp, presetsMap, now, horizon, rule.id)
      } else {
        const trp = rp as TaskReminderPresets
        if (!trp.due_at) {
          console.warn(`[fill-queue] regola task ${rule.id} senza due_at, skip`)
          skipped++
          continue
        }
        entries = generateTaskEntries(trp, presetsMap, now, horizon, rule.id)
      }

      // 3. Elimina entry pending stale per questa regola
      const { error: delErr, count: delCount } = await sb
        .from('cm_notification_queue')
        .delete({ count: 'exact' })
        .eq('rule_id', rule.id)
        .eq('status', 'pending')
        .gt('fire_at', safeDelete.toISOString())

      if (delErr) {
        console.error(`[fill-queue] delete error rule=${rule.id}:`, delErr)
        errors++
      } else {
        deleted += delCount ?? 0
      }

      // 4. Upsert le nuove entry
      const title = isQuick
        ? (rule.entity_title ? `⚡ ${rule.entity_title}` : `⚡ Notifica`)
        : (rule.entity_title ? `🔔 ${rule.entity_title}` : `🔔 Promemoria`)

      for (const entry of entries) {
        const body = buildBody(entry, rule.entity_title, isQuick)

        // Metadata per-entry: include slot_time per filtrare la cancellazione per slot
        // Le notifiche quick non hanno completion_update — snooze/cancel sempre visibili
        let entryMetadata: Record<string, unknown> | null = null
        if (isQuick) {
          const qrp = rp as QuickReminderPresets
          entryMetadata = {
            telegram_snooze_button: qrp.telegram_snooze_button ?? true,
            telegram_cancel_button: qrp.telegram_cancel_button ?? true,
          }
        } else if (isHabit) {
          const hrp = rp as HabitReminderPresets
          if (hrp.telegram_complete_button && hrp.completion_update) {
            // Clone per non mutare l'originale dal DB
            const cu = JSON.parse(JSON.stringify(hrp.completion_update)) as {
              app?: string
              operations?: Array<{ op: string; table: string; fields?: Record<string, unknown> }>
            }

            // Backward-compat: regole create prima del 2026-03-15 mancano di period_key.
            // Lo iniettiamo in base alla frequency (rule.entity_type) così il webhook
            // non tenta mai di inserire in hb_completions senza period_key.
            const hbOp = cu.operations?.find(o => o.op === 'insert' && o.table === 'hb_completions')
            if (hbOp?.fields && !hbOp.fields.period_key) {
              const freq = rule.entity_type
              hbOp.fields.period_key = freq === 'daily_multiple'
                ? '{{fire_date_local}}-{{slot_time}}'
                : freq === 'weekly'
                  ? '{{monday_of_week}}-{{day_of_week_n}}'
                  : '{{fire_date_local}}'
            }

            entryMetadata = {
              completion_update: cu,
              slot_time: entry.time,   // es. "08:00" — orario del slot habit
            }
          }
        } else if ((rp as TaskReminderPresets).telegram_complete_button) {
          entryMetadata = {
            completion_update: { app: 'tasks' },
          }
        }

        const queueEntry: Record<string, unknown> = {
          rule_id:       rule.id,
          user_id:       rule.user_id,
          app:           rule.app,
          entity_id:     rule.entity_id,
          title,
          body,
          channel:       rule.channel,
          fire_at:       entry.fire_at,
          status:        'pending',
          occurrence_id: entry.occurrence_id,
        }
        if (entryMetadata) queueEntry.metadata = entryMetadata

        const { error: upsertError } = await sb
          .from('cm_notification_queue')
          .upsert(
            queueEntry,
            { onConflict: 'rule_id,fire_at', ignoreDuplicates: true }
          )

        if (upsertError) {
          console.error(`[fill-queue] upsert error rule=${rule.id} fire_at=${entry.fire_at}:`, upsertError)
          errors++
        } else {
          inserted++
        }
      }

      if (entries.length === 0) skipped++
    }

    const total = (rules as Rule[])?.length ?? 0
    console.log(
      `[fill-queue] done — rules:${total} inserted:${inserted} deleted:${deleted} skipped:${skipped} errors:${errors}`
    )

    return new Response(
      JSON.stringify({ ok: true, total, inserted, deleted, skipped, errors }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('[fill-queue] fatal:', err)
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

// ---------------------------------------------------------------------------
// Genera entry per un task (struttura: due_at singolo)
// Una regola task → una occorrenza (la data di scadenza) → K notifiche (una per preset)
// Tutte le notifiche della stessa occorrenza condividono occurrence_id, differiscono per fire_at
// ---------------------------------------------------------------------------
function generateTaskEntries(
  rp:         TaskReminderPresets,
  presetsMap: Map<number, { label: string; offset_minutes: number }>,
  now:        Date,
  horizon:    Date,
  ruleId:     string,
): QueueEntry[] {
  const dueAt   = new Date(rp.due_at)
  const dateStr = dueAt.toISOString().slice(0, 10)  // YYYY-MM-DD
  const timeStr = `${String(dueAt.getUTCHours()).padStart(2,'0')}:${String(dueAt.getUTCMinutes()).padStart(2,'0')}`
  // occurrence_id uniforme con habit: ruleId:YYYY-MM-DD:HH:MM
  const occurrenceId = `${ruleId}:${dateStr}:${timeStr}`
  const results: QueueEntry[] = []

  for (const pid of rp.reminders) {
    const preset = presetsMap.get(pid)
    if (!preset) { console.warn(`[fill-queue] preset int_id=${pid} non trovato`); continue }
    const fireAt = new Date(dueAt.getTime() - preset.offset_minutes * 60 * 1000)
    if (fireAt > now && fireAt <= horizon) {
      results.push({
        fire_at:         fireAt.toISOString(),
        label:           preset.label,
        time:            timeStr,
        occurrence_id:   occurrenceId,
        occurrence_date: dateStr,
      })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Genera entry per un habit (struttura: times[] + from-to + days?)
// Una regola habit → N occorrenze (una per giorno × slot) → K notifiche per occorrenza
// Tutte le notifiche dello stesso slot condividono occurrence_id, differiscono per fire_at
// ---------------------------------------------------------------------------
function generateHabitEntries(
  rp:         HabitReminderPresets,
  presetsMap: Map<number, { label: string; offset_minutes: number }>,
  now:        Date,
  horizon:    Date,
  ruleId:     string,
): QueueEntry[] {
  const [fromStr, toStr] = rp['from-to']

  // Intervallo valido: intersezione tra [from, to] e [now, horizon]
  const fromDate = new Date(fromStr)
  fromDate.setUTCHours(0, 0, 0, 0)

  const toDate = toStr ? new Date(toStr) : horizon
  toDate.setUTCHours(23, 59, 59, 999)

  const startDay = new Date(Math.max(fromDate.getTime(), now.getTime()))
  const endDay   = new Date(Math.min(toDate.getTime(), horizon.getTime()))

  if (startDay > endDay) return []   // fuori range

  const results: QueueEntry[] = []

  // Cursor giorno per giorno (UTC)
  const cursor = new Date(startDay)
  cursor.setUTCHours(0, 0, 0, 0)

  while (cursor <= endDay) {
    const dayOfWeek    = cursor.getUTCDay()  // 0=domenica ... 6=sabato
    const cursorDateStr = cursor.toISOString().slice(0, 10) // YYYY-MM-DD

    // Weekly: salta se il giorno non è nella lista
    if (rp.days && !rp.days.includes(dayOfWeek)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1)
      continue
    }

    for (const timeStr of rp.times) {
      const [hh, mm] = timeStr.split(':').map(Number)
      const baseDate = new Date(cursor)
      baseDate.setUTCHours(hh, mm, 0, 0)

      // occurrence_id identifica univocamente questo giorno + slot
      const occurrenceId = `${ruleId}:${cursorDateStr}:${timeStr}`

      for (const pid of rp.reminders) {
        const preset = presetsMap.get(pid)
        if (!preset) { console.warn(`[fill-queue] preset int_id=${pid} non trovato`); continue }

        const fireAt = new Date(baseDate.getTime() - preset.offset_minutes * 60 * 1000)
        if (fireAt > now && fireAt <= horizon) {
          results.push({
            fire_at:         fireAt.toISOString(),
            label:           preset.label,
            time:            timeStr,
            occurrence_id:   occurrenceId,
            occurrence_date: cursorDateStr,
          })
        }
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return results
}

// ---------------------------------------------------------------------------
// Genera entry per una notifica quick (fire_at diretto, nessun offset preset)
// Una regola quick → 1 occorrenza → 1 notifica
// ---------------------------------------------------------------------------
function generateQuickEntry(
  rp:      QuickReminderPresets,
  now:     Date,
  horizon: Date,
  ruleId:  string,
): QueueEntry[] {
  const fireAt  = new Date(rp.fire_at)
  if (fireAt <= now || fireAt > horizon) return []
  const dateStr = rp.fire_at.slice(0, 10)   // YYYY-MM-DD
  const timeStr = rp.fire_at.slice(11, 16)  // HH:MM
  return [{
    fire_at:         fireAt.toISOString(),
    label:           '',
    time:            timeStr,
    occurrence_id:   `${ruleId}:${dateStr}:${timeStr}`,
    occurrence_date: dateStr,
  }]
}

// ---------------------------------------------------------------------------
// Body unificato — stesso formato per task e habit
//   "{entity_title} — {preset_label} prima — DD/MM/YYYY[ ore HH:MM]"
//   L'ora è omessa se è 00:00 (task con solo data, nessun orario specifico)
// ---------------------------------------------------------------------------
function buildBody(entry: QueueEntry, entityTitle: string | null, isQuick = false): string {
  if (isQuick) return entityTitle ?? 'Notifica'
  const name     = entityTitle ?? 'Promemoria'
  const datePart = formatDateStr(entry.occurrence_date)
  const timePart = entry.time !== '00:00' ? ` ore ${entry.time}` : ''
  return `${name} — ${entry.label} prima — ${datePart}${timePart}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Converte YYYY-MM-DD → DD/MM/YYYY
function formatDateStr(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}
