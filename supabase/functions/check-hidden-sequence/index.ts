// ============================================================
// check-hidden-sequence — verifica la sequenza codice hidden mode
// verify_jwt = true — richiede utente autenticato
//
// GET  → { length: N }            — numero di caselle da mostrare
// POST → { colors: [...] }        — verifica sequenza
//      ← { match: boolean }       — true se la sequenza è corretta
//
// La sequenza non viene mai inviata al browser.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL       = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function getSequence(): Promise<string[]> {
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const { data, error } = await sb
    .from('cm_settings')
    .select('value')
    .eq('key', 'hidden_mode_sequence')
    .limit(1)
    .single()
  if (error || !data?.value) return []
  return JSON.parse(data.value) as string[]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method === 'GET') {
    const seq = await getSequence()
    return new Response(
      JSON.stringify({ length: seq.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  if (req.method === 'POST') {
    const body = await req.json()
    const colors: string[] = body.colors ?? []
    const seq = await getSequence()

    const match =
      seq.length > 0 &&
      colors.length === seq.length &&
      colors.every((c, i) => c === seq[i])

    return new Response(
      JSON.stringify({ match }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders })
})
