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
    // --- INSERISCI LA TUA CHIAVE QUI SOTTO ---
    const QWEN_API_KEY = "sk-..." // Incolla qui la tua chiave completa che inizia con sk-
    // -----------------------------------------

    const { prompt } = await req.json()

    if (!prompt) {
      throw new Error('Prompt mancante')
    }

    const response = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${"sk-6e392204983a40d2997ebc9f87048e25"}`
      },
      body: JSON.stringify({
        model: "qwen-plus", // O il modello che preferisci (es. qwen-turbo, qwen-max)
        messages: [
          { role: "system", content: "Sei un esperto nutrizionista. Crea un piano dietetico dettagliato basato sulla richiesta dell'utente." },
          { role: "user", content: prompt }
        ]
      })
    })

    const data = await response.json()

    if (!response.ok) {
      console.error("Errore API Qwen:", data)
      throw new Error(data.error?.message || `Errore HTTP ${response.status}`)
    }

    return new Response(JSON.stringify({ result: data.choices[0].message.content }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    })

  } catch (error) {
    console.error("Errore nella funzione qwen-diet:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    })
  }
})
