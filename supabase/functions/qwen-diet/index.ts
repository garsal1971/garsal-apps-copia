import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Gestione CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // 1. Recupera la chiave API dalle variabili d'ambiente di Supabase
    const apiKey = Deno.env.get('QWEN_API_KEY');
    
    // Debug: Se la chiave manca, restituisci errore 500 chiaro invece di 401 silenzioso
    if (!apiKey) {
      console.error('ERRORE CRITICO: QWEN_API_KEY non trovata nei secrets di Supabase!');
      return new Response(
        JSON.stringify({ error: 'Configurazione server errata: manca QWEN_API_KEY' }), 
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    const { prompt } = await req.json();

    if (!prompt) {
      throw new Error('Prompt mancante nella richiesta');
    }

    // 2. Prepara la chiamata alle API di Alibaba DashScope (Qwen)
    // URL ufficiale per Qwen-Turbo o Qwen-Plus
    const url = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
    
    const payload = {
      model: 'qwen-turbo', // O 'qwen-plus', 'qwen-max' a seconda dei tuoi crediti
      input: {
        messages: [
          { role: 'system', content: 'Sei un esperto nutrizionista. Crea piani dietetici dettagliati.' },
          { role: 'user', content: prompt }
        ]
      },
      parameters: {
        result_format: 'message'
      }
    };

    // 3. Esegui la fetch con l'header CORRETTO
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`, // <-- Qui era probabilmente l'errore
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Errore API Qwen:', data);
      throw new Error(data.message || 'Errore nella chiamata a Qwen');
    }

    // Estrai la risposta dal formato di Qwen
    const answer = data.output?.choices?.[0]?.message?.content || 'Nessuna risposta generata.';

    return new Response(
      JSON.stringify({ result: answer }),
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    console.error('Errore interno funzione:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
