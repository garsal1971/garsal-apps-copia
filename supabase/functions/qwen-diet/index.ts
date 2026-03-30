import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // LOG: Inizio richiesta
    console.log('[DEBUG Edge] Ricevuta richiesta:', req.method, req.url)
    
    // LOG: Headers ricevuti
    const authHeader = req.headers.get('Authorization')
    console.log('[DEBUG Edge] Authorization header:', authHeader ? authHeader.substring(0, 20) + '...' : 'ASSENTE')
    
    // 1. Verifica autenticazione utente
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: authHeader ?? '' },
        },
      }
    )
    
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser()
    
    if (authError || !user) {
      console.log('[DEBUG Edge] Autenticazione fallita:', authError?.message || 'Utente non trovato')
      throw new Error('Utente non autenticato. Effettua il login.')
    }
    
    console.log('[DEBUG Edge] Utente autenticato:', user.id, user.email)

    // 2. Recupera la chiave API dalle variabili d'ambiente sicure (Secrets)
    const apiKey = Deno.env.get('QWEN_API_KEY');

    if (!apiKey) {
      console.log('[DEBUG Edge] QWEN_API_KEY assente')
      throw new Error('Chiave API Qwen mancante. Configurare il secret QWEN_API_KEY su Supabase.');
    }
    
    console.log('[DEBUG Edge] QWEN_API_KEY presente')

    const { prompt } = await req.json()

    if (!prompt) {
      console.log('[DEBUG Edge] Prompt assente')
      throw new Error('Nessun prompt fornito')
    }
    
    console.log('[DEBUG Edge] Prompt ricevuto, lunghezza:', prompt.length)

    // 3. Chiamata corretta alle API di Alibaba DashScope (Qwen)
    console.log('[DEBUG Edge] Chiamata API Qwen in corso...')
    const response = await fetch('https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-turbo', // O 'qwen-plus' se hai accesso
        input: {
          messages: [
            { role: 'system', content: 'Sei un esperto nutrizionista. Crea un piano dietetico dettagliato.' },
            { role: 'user', content: prompt }
          ]
        },
        parameters: {
          result_format: 'message'
        }
      })
    })

    console.log('[DEBUG Edge] Risposta API Qwen status:', response.status)
    const data = await response.json()

    if (!response.ok) {
      console.error('[DEBUG Edge] Errore API Qwen:', data)
      throw new Error(data.message || `Errore HTTP ${response.status}`)
    }

    console.log('[DEBUG Edge] Successo! Risposta generata.')
    return new Response(JSON.stringify({ 
      success: true, 
      content: data.output?.choices?.[0]?.message?.content || 'Nessuna risposta generata',
      userId: user.id
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('[DEBUG Edge] Errore interno funzione:', error.message)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
