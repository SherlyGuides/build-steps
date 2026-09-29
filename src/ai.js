// "✨ Improve with AI": asks the Build Steps AI proxy (server/rephrase_proxy.py, on the
// Lesson Foundry EC2 server) for three rewrites of a step's instruction. The proxy holds the
// Gemini API key, so no key is ever in this public app.

export const AI_URL = "https://51-21-180-129.sslip.io/rephrase";
const HEALTH_URL = AI_URL.replace(/\/rephrase$/, "/health");

// A server that cannot be reached at all makes the phone wait a long time, so check quickly
// first and say so instead of spinning.
async function reachable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return (await fetch(HEALTH_URL, { signal: controller.signal, cache: "no-store" })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves to [{ label, text }] or throws an Error with a message for the user. */
export async function suggestInstructions({ instruction, parts, move, grade, step }) {
  if (!navigator.onLine) throw new Error("You are offline. AI suggestions need the internet.");
  if (!(await reachable())) throw new Error("The AI server is not reachable right now, so no suggestions. You can still type the instruction yourself.");
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
    throw new Error("The AI took too long to answer. Try again.");
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The AI could not answer right now. Try again.");
  if (!Array.isArray(data.suggestions) || !data.suggestions.length) throw new Error("No suggestions came back. Try again.");
  return data.suggestions;
}
