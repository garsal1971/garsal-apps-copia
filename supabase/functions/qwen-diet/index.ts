// Follow the setup instructions on https://docs.deno.com/deploy/tutorials/guide#initialize-a-new-project
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { prompt, period_days } = await req.json()

    if (!prompt) {
      throw new Error('Prompt è obbligatorio')
    }

    const apiKey = Deno.env.get('QWEN_API_KEY')
    if (!apiKey) {
      throw new Error('QWEN_API_KEY non configurata in Supabase Secrets')
    }

    // Costruisci il prompt completo per Qwen
    const fullPrompt = `${prompt}

Genera un piano dietetico dettagliato per ${period_days || 7} giorni.
Includi:
- Colazione, pranzo, cena e spuntini per ogni giorno
- Quantità approssimative delle porzioni
- Alternative per variare il menu
- Consigli per l'idratazione
- Eventuali note nutrizionali

Formatta la risposta in HTML semplice (solo tag base come p, ul, li, strong) senza CSS inline complesso.`

    // Chiamata API a Qwen (DashScope)
    const response = await fetch('https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-plus',
        input: {
          messages: [
            { role: 'system', content: 'Sei un nutrizionista esperto che crea piani dietetici personalizzati. Rispondi in italiano.' },
            { role: 'user', content: fullPrompt }
          ]
        },
        parameters: {
          result_format: 'message',
          temperature: 0.7,
          max_tokens: 2000
        }
      })
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error('Errore API Qwen:', errorData)
      throw new Error(`Errore API Qwen: ${response.status} - ${errorData.message || 'Errore sconosciuto'}`)
    }

    const data = await response.json()
    
    // Estrai la risposta da Qwen
    const qwenResponse = data.output?.choices?.[0]?.message?.content || 'Nessuna risposta generata'

    return new Response(
      JSON.stringify({ 
        success: true, 
        plan: qwenResponse,
        model: 'qwen-plus'
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    )

  } catch (error) {
    console.error('Errore nella funzione qwen-diet:', error)
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error.message || 'Errore interno del server' 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    )
  }
})
