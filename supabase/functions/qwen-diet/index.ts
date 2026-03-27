import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Recupera la chiave: prima dai secret, poi fallback hardcoded se manca
    // SOSTITUISCI 'sk-...' CON LA TUA CHIAVE REALE SE I SECRET NON FUNZIONANO
    let apiKey = Deno.env.get('QWEN_API_KEY') || 'sk-6e392204983a40d2997ebc9f87048e25';

    if (!apiKey || apiKey.includes('INSERISCI')) {
      throw new Error('Chiave API Qwen mancante o non configurata correttamente.');
    }

    const { prompt } = await req.json()

    if (!prompt) {
      throw new Error('Nessun prompt fornito')
    }

    // 2. Chiamata corretta alle API di Alibaba DashScope (Qwen)
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

    const data = await response.json()

    if (!response.ok) {
      console.error('Errore API Qwen:', data)
      throw new Error(data.message || `Errore HTTP ${response.status}`)
    }

    return new Response(JSON.stringify({ 
      success: true, 
      content: data.output?.choices?.[0]?.message?.content || 'Nessuna risposta generata' 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('Errore interno funzione:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
