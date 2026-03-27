// Netlify Function: proxy verso Anthropic API
// Evita blocchi firewall aziendali: il browser chiama /.netlify/functions/claude-diet
// e questa funzione server-side chiama api.anthropic.com
//
// Variabile d'ambiente richiesta in Netlify:
//   ANTHROPIC_API_KEY = sk-ant-...

const MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6'];
const MAX_RETRIES = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callAnthropic(apiKey, prompt, model) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model,
            max_tokens: 8000,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    const data = await res.json();
    return { status: res.status, data };
}

exports.handler = async function(event) {
    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            },
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY non configurata nelle variabili d\'ambiente Netlify.' } })
        };
    }

    let reqBody;
    try {
        reqBody = JSON.parse(event.body || '{}');
    } catch (e) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: { message: 'Body JSON non valido.' } })
        };
    }

    const prompt = reqBody.prompt;
    if (!prompt) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: { message: 'Campo "prompt" mancante.' } })
        };
    }

    let lastError = null;

    // Prova ogni modello con retry su 529 Overloaded
    for (const model of MODELS) {
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                const { status, data } = await callAnthropic(apiKey, prompt, model);

                if (status === 529 || (data.error && data.error.type === 'overloaded_error')) {
                    // Server sovraccarico: aspetta e riprova (backoff: 3s, 6s, 12s)
                    const wait = 3000 * Math.pow(2, attempt);
                    lastError = `Overloaded (${model}, tentativo ${attempt + 1}/${MAX_RETRIES}) — attendo ${wait/1000}s`;
                    await sleep(wait);
                    continue;
                }

                // Qualsiasi altra risposta (200 o errore non-overload) → restituisci
                return {
                    statusCode: status,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    body: JSON.stringify(data)
                };
            } catch (e) {
                lastError = e.message;
                await sleep(2000);
            }
        }
        // Tutti i retry falliti su questo modello → prova il prossimo
    }

    return {
        statusCode: 529,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: { message: 'API Anthropic sovraccarica. Riprova tra qualche minuto. (' + lastError + ')' } })
    };
};
