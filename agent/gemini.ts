/**
 * @file Google Gemini client for the AI review agent.
 * Extracts the first JSON object from the model's response text.
 */

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
}

export async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) },
  );

  const data = (await res.json()) as GeminiResponse;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response: ' + JSON.stringify(data).slice(0, 200));

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in Gemini response: ' + text.slice(0, 300));
  return m[0];
}
