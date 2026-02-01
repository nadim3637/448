export const config = {
  runtime: 'edge',
};

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export default async function handler(req: Request) {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { 
        status: 405,
        headers: { "Content-Type": "application/json" }
      });
    }

    let body;
    try {
        body = await req.json();
    } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
    }

    const { messages, model, tools, tool_choice, key } = body;

    // Validate model on server side as well
    let modelToUse = model;
    if (!modelToUse || modelToUse.includes("gemini")) {
        modelToUse = "llama3-8b-8192";
    }

    // 1. Determine API Key
    let apiKey = key;
    if (!apiKey) {
        // Fallback to ENV
        const keysRaw = process.env.GROQ_API_KEYS;
        if (keysRaw) {
            const keys = keysRaw.split(",").map(k => k.trim()).filter(Boolean);
            if (keys.length > 0) {
                apiKey = keys[Math.floor(Math.random() * keys.length)];
            }
        }
    }

    if (!apiKey) {
        return new Response(JSON.stringify({ error: "Server Configuration Error: No valid GROQ keys found (ENV or Body)." }), { 
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }

    // 2. Call Groq
    const payload: any = {
      model: modelToUse || "llama3-8b-8192",
      messages,
      temperature: 0.7,
      max_tokens: 4096
    };

    if (tools) payload.tools = tools;
    if (tool_choice) payload.tool_choice = tool_choice;

    const groqRes = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    // Check if the response is ok
    if (!groqRes.ok) {
        const errorText = await groqRes.text();
        return new Response(JSON.stringify({ error: "Groq API Error", detail: errorText }), { 
            status: groqRes.status,
            headers: { "Content-Type": "application/json" }
        });
    }

    // Forward the response
    const data = await groqRes.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: "Server Internal Error", detail: err.message }), { 
        status: 500,
        headers: { "Content-Type": "application/json" }
    });
  }
}
