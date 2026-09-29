// "✨ Improve with AI": asks the Build Steps AI proxy (server/rephrase_proxy.py, on the
// Lesson Foundry EC2 server) for three rewrites of a step's instruction. The proxy holds the
// Gemini API key, so no key is ever in this public app.

export const AI_URL = "https://51-21-180-129.sslip.io/rephrase";

/** Resolves to [{ label, text }] or throws an Error with a message for the user. */
export async function suggestInstructions({ instruction, parts, move, grade, step }) {
  if (!navigator.onLine) throw new Error("You are offline. AI suggestions need the internet.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  let response;
  try {
    response = await fetch(AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction, parts, move, grade, step }),
      signal: controller.signal,
    });
  } catch {
    throw new Error("The AI service could not be reached. Check the internet and try again.");
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The AI could not answer right now. Try again.");
  if (!Array.isArray(data.suggestions) || !data.suggestions.length) throw new Error("No suggestions came back. Try again.");
  return data.suggestions;
}
