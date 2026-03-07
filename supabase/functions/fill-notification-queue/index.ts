// ============================================================
// Job 1 — fill-notification-queue
// Frequenza: ogni 6 ore (cron: "0 */6 * * *")
// Aggiornato: 2026-03-07 — supporto struttura habit (times[] + from-to)
//
// Gestisce due tipi di struttura in reminder_presets:
//
// TASKS (struttura legacy):
//   { "reminders": [1, 3], "due_at": "2026-03-10T10:00:00Z" }
//   → un fire_at per preset = due_at − offset_minutes
//
// HABITS (nuova struttura):
//   daily / daily_multiple:
//     { "reminders": [1, 3], "times": ["08:00","22:00"], "from-to": ["2026-03-01","2026-05-30"] }
//   weekly:
//     { "reminders": [1, 3], "days": [1,3,5], "times": ["08:00"], "from-to": ["2026-03-01","2026-05-30"] }
//   → fire_at per ogni giorno nel range × ogni orario × ogni preset
//      (per weekly: solo i giorni della settimana in `days`)
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
  reminders: number[]
  due_at:    string     // ISO timestamptz — scadenza task
}

interface HabitReminderPresets {
  reminders: number[]
  times:     string[]           // ["HH:MM", ...]
  'from-to': [string, string | null]  // [started_at, end_date | null]
  days?:     number[]           // [0-6] solo per weekly (0=domenica)
}

type ReminderPresetsJson = TaskReminderPresets | HabitReminderPresets

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
  fire_at: string
  label:   string
  time:    string   // HH:MM usato come riferimento (per task = ora di due_at)
}

// ---------------------------------------------------------------------------
// Handler principale
// ---------------------------------------------------------------------------
Deno.serve(async (_req) => {
  try {
    const now        = new Date()
    const horizon    = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000)
    const safeDelete = new Date(now.getTime() + SAFE_WINDOW_MS)

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

      // Detect struttura: habit (times[]) vs task (due_at)
      const isHabit = Array.isArray((rp as HabitReminderPresets).times)

      // Valida dati minimi
      if (!rp?.reminders?.length) {
        console.warn(`[fill-queue] regola ${rule.id} senza reminders, skip`)
        skipped++
        continue
      }

      let entries: QueueEntry[]

      if (isHabit) {
        const hrp = rp as HabitReminderPresets
        if (!hrp.times?.length || !hrp['from-to']?.[0]) {
          console.warn(`[fill-queue] regola habit ${rule.id} senza times o from-to, skip`)
          skipped++
          continue
        }
        entries = generateHabitEntries(hrp, presetsMap, now, horizon)
      } else {
        const trp = rp as TaskReminderPresets
        if (!trp.due_at) {
          console.warn(`[fill-queue] regola task ${rule.id} senza due_at, skip`)
          skipped++
          continue
        }
        entries = generateTaskEntries(trp, presetsMap, now, horizon)
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
      const title = rule.entity_title ? `🔔 ${rule.entity_title}` : `🔔 Promemoria`

      for (const entry of entries) {
        const body = isHabit
          ? buildHabitBody(entry, rule.entity_title)
          : buildTaskBody(entry, (rp as TaskReminderPresets).due_at)

        const { error: upsertError } = await sb
          .from('cm_notification_queue')
          .upsert(
            {
              rule_id:   rule.id,
              user_id:   rule.user_id,
              app:       rule.app,
              entity_id: rule.entity_id,
              title,
              body,
              channel:   rule.channel,
              fire_at:   entry.fire_at,
              status:    'pending',
            },
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
// Genera entry per un task (struttura legacy: due_at singolo)
// ---------------------------------------------------------------------------
function generateTaskEntries(
  rp:         TaskReminderPresets,
  presetsMap: Map<number, { label: string; offset_minutes: number }>,
  now:        Date,
  horizon:    Date,
): QueueEntry[] {
  const dueAt  = new Date(rp.due_at)
  const timeStr = `${String(dueAt.getUTCHours()).padStart(2,'0')}:${String(dueAt.getUTCMinutes()).padStart(2,'0')}`
  const results: QueueEntry[] = []

  for (const pid of rp.reminders) {
    const preset = presetsMap.get(pid)
    if (!preset) { console.warn(`[fill-queue] preset int_id=${pid} non trovato`); continue }
    const fireAt = new Date(dueAt.getTime() - preset.offset_minutes * 60 * 1000)
    if (fireAt > now && fireAt <= horizon) {
      results.push({ fire_at: fireAt.toISOString(), label: preset.label, time: timeStr })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Genera entry per un habit (nuova struttura: times[] + from-to + days?)
// ---------------------------------------------------------------------------
function generateHabitEntries(
  rp:         HabitReminderPresets,
  presetsMap: Map<number, { label: string; offset_minutes: number }>,
  now:        Date,
  horizon:    Date,
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
    const dayOfWeek = cursor.getUTCDay()  // 0=domenica ... 6=sabato

    // Weekly: salta se il giorno non è nella lista
    if (rp.days && !rp.days.includes(dayOfWeek)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1)
      continue
    }

    for (const timeStr of rp.times) {
      const [hh, mm] = timeStr.split(':').map(Number)
      const baseDate = new Date(cursor)
      baseDate.setUTCHours(hh, mm, 0, 0)

      for (const pid of rp.reminders) {
        const preset = presetsMap.get(pid)
        if (!preset) { console.warn(`[fill-queue] preset int_id=${pid} non trovato`); continue }

        const fireAt = new Date(baseDate.getTime() - preset.offset_minutes * 60 * 1000)
        if (fireAt > now && fireAt <= horizon) {
          results.push({ fire_at: fireAt.toISOString(), label: preset.label, time: timeStr })
        }
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  return results
}

// ---------------------------------------------------------------------------
// Body messages
// ---------------------------------------------------------------------------
function buildTaskBody(entry: QueueEntry, dueAt: string): string {
  return `${entry.label} prima — scad. ${formatDate(new Date(dueAt))}`
}

function buildHabitBody(entry: QueueEntry, entityTitle: string | null): string {
  const name = entityTitle ?? 'Abitudine'
  return `${entry.label} prima — ${name} ore ${entry.time}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDate(d: Date): string {
  const dd   = String(d.getUTCDate()).padStart(2, '0')
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  const hh   = String(d.getUTCHours()).padStart(2, '0')
  const min  = String(d.getUTCMinutes()).padStart(2, '0')
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`
}
