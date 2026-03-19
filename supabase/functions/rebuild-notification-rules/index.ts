// ============================================================
// Edge Function: rebuild-notification-rules
// Scopo: ricrea da zero tutte le righe in cm_notification_rules
//        leggendo i task attivi da ts_tasks.
//
// NON deve essere chiamata dal frontend: va invocata manualmente
// dalla console Supabase o via curl con il service_role_key.
//
// Logica:
//   1. Carica tutti gli utenti che hanno impostazioni notifica
//      (cm_user_notification_settings) → ottiene user_id/telegram_chat_id
//   2. Carica la mappa label → int_id da cm_reminder_presets
//   3. Carica tutti i task attivi (non 'terminated') da ts_tasks
//      che hanno almeno un promemoria impostato
//   4. Per ogni task:
//      a. Mappa le label dei promemoria → int_id
//      b. Calcola due_at = next_occurrence_date ?? start_date
//      c. Upsert in cm_notification_rules (user_id preso dai settings)
//   5. Elimina le regole orfane (task terminati / senza promemoria)
//   6. Se richiesto (also_fill_queue=true), chiama fill-notification-queue
//
// Parametri (body JSON, tutti opzionali):
//   dry_run        boolean  (default false) — stampa cosa farebbe, senza scrivere
//   also_fill_queue boolean (default true)  — richiama fill-queue al termine
//   user_id        string   (opzionale)     — limita l'operazione a un singolo utente
//
// Esempio di chiamata dalla console Supabase:
//   POST /functions/v1/rebuild-notification-rules
//   Headers: Authorization: Bearer <SERVICE_ROLE_KEY>
//   Body: {}
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------

interface UserNotifSettings {
  user_id:          string
  telegram_chat_id: string | null
  telegram_enabled: boolean
}

interface ReminderPreset {
  int_id:         number
  label:          string
  offset_minutes: number
}

interface Task {
  id:                   string
  type:                 string
  title:                string
  status:               string
  reminders:            string[] | null
  start_date:           string | null
  next_occurrence_date: string | null
}

interface ExistingRule {
  id:               string
  entity_id:        string
  reminder_presets: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Handler principale
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  try {
    // Leggi parametri opzionali dal body
    let dry_run         = false
    let also_fill_queue = true
    let filter_user_id: string | null = null

    try {
      const body = await req.json()
      if (typeof body.dry_run        === 'boolean') dry_run         = body.dry_run
      if (typeof body.also_fill_queue === 'boolean') also_fill_queue = body.also_fill_queue
      if (typeof body.user_id        === 'string')   filter_user_id  = body.user_id
    } catch { /* body assente o non JSON → usa default */ }

    console.log(`[rebuild-rules] avvio — dry_run=${dry_run} also_fill_queue=${also_fill_queue} filter_user_id=${filter_user_id ?? 'tutti'}`)

    // -----------------------------------------------------------------------
    // 1. Carica utenti con notifiche configurate
    // -----------------------------------------------------------------------
    let settingsQuery = sb
      .from('cm_user_notification_settings')
      .select('user_id, telegram_chat_id, telegram_enabled')

    if (filter_user_id) {
      settingsQuery = settingsQuery.eq('user_id', filter_user_id)
    }

    const { data: settingsRows, error: settingsErr } = await settingsQuery

    if (settingsErr) throw settingsErr

    const allUsers = (settingsRows as UserNotifSettings[]) ?? []
    console.log(`[rebuild-rules] utenti con impostazioni notifica: ${allUsers.length}`)

    if (allUsers.length === 0) {
      return json({ ok: true, message: 'Nessun utente con impostazioni notifica trovato.', upserted: 0, deleted: 0, skipped: 0 })
    }

    // -----------------------------------------------------------------------
    // 2. Carica preset label → int_id
    // -----------------------------------------------------------------------
    const { data: presetsRows, error: presetsErr } = await sb
      .from('cm_reminder_presets')
      .select('int_id, label, offset_minutes')

    if (presetsErr) throw presetsErr

    // Mappa label → int_id
    const labelToIntId = new Map<string, number>()
    for (const p of (presetsRows as ReminderPreset[]) ?? []) {
      labelToIntId.set(p.label, p.int_id)
    }
    console.log(`[rebuild-rules] preset caricati: ${labelToIntId.size}`)

    // -----------------------------------------------------------------------
    // 3. Carica task attivi con promemoria
    // -----------------------------------------------------------------------
    const { data: tasksData, error: tasksErr } = await sb
      .from('ts_tasks')
      .select('id, type, title, status, reminders, start_date, next_occurrence_date')
      .not('status', 'eq', 'terminated')
      .not('reminders', 'is', null)

    if (tasksErr) throw tasksErr

    // Filtra solo task con array reminders non vuoto
    const tasks = ((tasksData as Task[]) ?? []).filter(
      t => Array.isArray(t.reminders) && t.reminders.length > 0
    )

    console.log(`[rebuild-rules] task attivi con promemoria: ${tasks.length}`)

    // Set degli entity_id validi (per pulizia regole orfane)
    const validEntityIds = new Set(tasks.map(t => String(t.id)))

    // -----------------------------------------------------------------------
    // 4. Per ogni utente: carica regole esistenti, upsert, pulisci orfane
    // -----------------------------------------------------------------------
    let totalUpserted = 0
    let totalDeleted  = 0
    let totalSkipped  = 0
    const warnings: string[] = []

    for (const user of allUsers) {
      console.log(`[rebuild-rules] elaborazione utente ${user.user_id}`)

      // Carica regole esistenti per i task di questo utente
      const { data: existingRules, error: existErr } = await sb
        .from('cm_notification_rules')
        .select('id, entity_id, reminder_presets')
        .eq('user_id', user.user_id)
        .eq('app', 'tasks')

      if (existErr) {
        console.error(`[rebuild-rules] errore caricamento regole utente ${user.user_id}:`, existErr)
        warnings.push(`Errore lettura regole utente ${user.user_id}: ${existErr.message}`)
        continue
      }

      const existingMap = new Map<string, ExistingRule>()
      for (const r of (existingRules as ExistingRule[]) ?? []) {
        existingMap.set(r.entity_id, r)
      }

      // ── Elimina regole orfane (task terminati o non più in lista) ──
      const orphanIds: string[] = []
      for (const [entityId, rule] of existingMap) {
        if (!validEntityIds.has(entityId)) {
          orphanIds.push(rule.id)
        }
      }

      if (orphanIds.length > 0) {
        console.log(`[rebuild-rules] utente ${user.user_id}: ${orphanIds.length} regole orfane da eliminare`)
        if (!dry_run) {
          const { error: delErr, count: delCount } = await sb
            .from('cm_notification_rules')
            .delete({ count: 'exact' })
            .in('id', orphanIds)

          if (delErr) {
            console.error(`[rebuild-rules] errore eliminazione orfane:`, delErr)
            warnings.push(`Errore eliminazione orfane utente ${user.user_id}: ${delErr.message}`)
          } else {
            totalDeleted += delCount ?? 0
          }
        } else {
          totalDeleted += orphanIds.length  // dry_run: conta comunque
        }
      }

      // ── Upsert regole per i task con promemoria ──
      for (const task of tasks) {
        const entityId = String(task.id)

        // Mappa label → int_id, scarta quelle senza preset
        const unmapped: string[] = []
        const reminderIds: number[] = []
        for (const label of task.reminders!) {
          const intId = labelToIntId.get(label)
          if (intId == null) {
            unmapped.push(label)
          } else {
            reminderIds.push(intId)
          }
        }

        if (unmapped.length > 0) {
          const msg = `Task ${task.id} (${task.title}): label senza preset corrispondente: ${unmapped.join(', ')}`
          console.warn(`[rebuild-rules] ⚠️ ${msg}`)
          warnings.push(msg)
        }

        if (reminderIds.length === 0) {
          console.log(`[rebuild-rules] task ${task.id}: nessun int_id valido, skip`)
          totalSkipped++
          continue
        }

        // due_at: next_occurrence_date ?? start_date
        const dueAt = task.next_occurrence_date ?? task.start_date ?? null

        if (!dueAt) {
          // free_repeat o task senza data: crea ugualmente la regola,
          // fill-queue la salterà ma la regola sarà pronta quando la data viene impostata
          console.log(`[rebuild-rules] task ${task.id} (${task.type}): nessuna due_at, skip`)
          totalSkipped++
          continue
        }

        // Controlla se la data è già passata (inutile creare regole per scadenze passate)
        const dueAtDate = new Date(dueAt)
        if (dueAtDate < new Date()) {
          // Per task ricorrenti: potrebbe avere una prossima occorrenza futura
          // ma se next_occurrence_date è nel passato, skip
          const isRecurring = ['recurring', 'simple_recurring', 'multiple'].includes(task.type)
          if (!isRecurring) {
            console.log(`[rebuild-rules] task ${task.id}: due_at nel passato (${dueAt}), skip`)
            totalSkipped++
            continue
          }
          // Per i ricorrenti, la lasciamo passare — fill-queue deciderà
        }

        // Preserva telegram_complete_button dalla regola esistente (default: true)
        const existing = existingMap.get(entityId)
        const existingPresets = existing?.reminder_presets as Record<string, unknown> | undefined
        const telegramBtn = existingPresets?.telegram_complete_button !== false  // default true

        const reminderPresets: Record<string, unknown> = {
          reminders: reminderIds,
          due_at:    dueAt,
        }
        if (task.type !== 'workflow' && telegramBtn) {
          reminderPresets.telegram_complete_button = true
        }

        const rule = {
          user_id:          user.user_id,
          app:              'tasks',
          entity_id:        entityId,
          entity_type:      task.type,
          entity_title:     task.title ?? null,
          reminder_presets: reminderPresets,
          channel:          'telegram',
          enabled:          true,
        }

        console.log(`[rebuild-rules] ${dry_run ? '[dry_run] ' : ''}upsert task ${task.id} (${task.title}) — reminders=${JSON.stringify(reminderIds)} due_at=${dueAt}`)

        if (!dry_run) {
          let error: unknown

          if (existing?.id) {
            // UPDATE
            ;({ error } = await sb
              .from('cm_notification_rules')
              .update(rule)
              .eq('id', existing.id))
          } else {
            // INSERT
            ;({ error } = await sb
              .from('cm_notification_rules')
              .insert(rule))
          }

          if (error) {
            const errMsg = (error as { message?: string }).message ?? JSON.stringify(error)
            console.error(`[rebuild-rules] errore upsert task ${task.id}:`, errMsg)
            warnings.push(`Errore upsert task ${task.id}: ${errMsg}`)
          } else {
            totalUpserted++
          }
        } else {
          totalUpserted++  // dry_run: conta comunque
        }
      }
    }

    // -----------------------------------------------------------------------
    // 5. Opzionale: richiama fill-notification-queue
    // -----------------------------------------------------------------------
    let fillResult: unknown = null
    if (also_fill_queue && !dry_run) {
      console.log('[rebuild-rules] chiamo fill-notification-queue...')
      try {
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/fill-notification-queue`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
        })
        fillResult = await resp.json()
        console.log('[rebuild-rules] fill-queue result:', fillResult)
      } catch (fillErr) {
        const msg = `Errore chiamata fill-queue: ${(fillErr as Error).message}`
        console.warn(`[rebuild-rules] ⚠️ ${msg}`)
        warnings.push(msg)
      }
    }

    // -----------------------------------------------------------------------
    // Risposta finale
    // -----------------------------------------------------------------------
    const result = {
      ok:          true,
      dry_run,
      upserted:    totalUpserted,
      deleted:     totalDeleted,
      skipped:     totalSkipped,
      users:       allUsers.length,
      tasks_found: tasks.length,
      warnings:    warnings.length > 0 ? warnings : undefined,
      fill_queue:  fillResult,
    }

    console.log(`[rebuild-rules] completato —`, result)
    return json(result)

  } catch (err) {
    console.error('[rebuild-rules] fatal:', err)
    return json({ ok: false, error: String(err) }, 500)
  }
})

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
