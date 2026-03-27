// Netlify Function: proxy verso Anthropic API
// Evita blocchi firewall aziendali: il browser chiama /.netlify/functions/claude-diet
// e questa funzione server-side chiama api.anthropic.com
//
// Variabile d'ambiente richiesta in Netlify:
//   ANTHROPIC_API_KEY = sk-ant-...

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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY non configurata nelle variabili d\'ambiente Netlify.' } })
        };
    }

    let reqBody;
    try {
        reqBody = JSON.parse(event.body || '{}');
    } catch (e) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: { message: 'Body JSON non valido.' } })
        };
    }

    const prompt = reqBody.prompt;
    if (!prompt) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: { message: 'Campo "prompt" mancante.' } })
        };
    }

    try {
        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-opus-4-6',
                max_tokens: 8000,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await anthropicRes.json();

        return {
            statusCode: anthropicRes.status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify(data)
        };
    } catch (e) {
        return {
            statusCode: 502,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: { message: 'Errore chiamata Anthropic: ' + e.message } })
        };
    }
};
