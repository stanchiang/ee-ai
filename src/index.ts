/*  Cloudflare Worker – Image‑to‑Circuit Chat
    Emits five ASCII‑only blocks:
      SUMMARY · SCHEMATIC · PCB · BOM
    (retains all original ASCII‑diagram constraints)
*/
import type { Ai } from "@cloudflare/ai";

export interface Env { AI: Ai }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Expected POST", { status: 405 });
    }

    /* ────── request body ────── */
    const { history, images = [], text } = (await request.json()) as {
      history: { role: string; content: string }[];
      images?: string[];
      text: string;
    };

    /* helper: stream one AI turn into ctrl */
    const streamOne = async (
      msgParts: any[],
      ctrl: ReadableStreamDefaultController
    ) => {
      const messages = [
        ...history,
        { role: "user", content: msgParts },
        {
          role: "system",
          content: [
            "You are a helpful electrical engineer.",
            "",
            "⚠️ If the request is vague, always make simple, sensible assumptions.",
            "⚠️ Treat the entire conversation as a single ongoing design session. Extend from the last circuit you produced instead of starting from scratch.",
            "",
            "⚙️ **OUTPUT FORMAT (MANDATORY)** – reply with these five ASCII‑only blocks *in order*:",
            "=== SUMMARY ===",
            "(concise natural‑language explanation, ≤ 10 lines)",
            "=== SCHEMATIC ===",
            "(ASCII circuit diagram of a complete, functional electronic circuit)",
            "=== PCB ===",
            "(ASCII representation of the PCB layout)",
            "=== BOM ===",
            "(plain ASCII list:  Ref   Value   Part‑type)",
            "",
            "Inside *SCHEMATIC* (and PCB):",
            " • Use only printable ASCII – no code fences, no HTML.",
            " • Label every component with its type and value (e.g., R1 1 kΩ, C1 10 µF, 555 Timer).",
            " • Show connections with lines; box or nest multi‑pin ICs when appropriate.",
            " • Use standard components (resistors, capacitors, ICs, transistors, diodes, etc.).",
            "",
            "Absolutely NOTHING outside the five blocks.  If you must refuse, output exactly: ERROR",
            "",
            "📷 Image rule: if the user supplies a photo, assume it shows the target device and design a circuit that reproduces its main function.",
          ].join("\n"),
        },
      ];

      const aiStream = await env.AI.run(
        "@cf/meta/llama-4-scout-17b-16e-instruct",
        { messages, stream: true, max_tokens: 9999, seed: 1 }
      );
      const reader = aiStream.getReader();
      const enc = new TextEncoder();
      const dec = new TextDecoder("utf-8");

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        /* incoming chunk:  data: {"response":"..."}\n\n  */
        const str = dec.decode(value, { stream: false });
        const m = str.match(/^data:\s*(\{.*})/);
        if (!m) {              // passthrough anything unexpected
          ctrl.enqueue(value);
          continue;
        }
        const obj = JSON.parse(m[1]);

        /* strip any accidental ``` fenced blocks */
        obj.response = obj.response.replace(/```[\s\S]*?```/g, "");

        ctrl.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
      }
    };

    /* ────── combined SSE response ────── */
    const stream = new ReadableStream({
      start: async (ctrl) => {
        /* image turns (one per image) */
        for (const url of images) {
          const safeText =
            text.trim() ||
            "Design schematic / PCB / BOM for this device.";
          await streamOne(
            [
              { type: "image_url", image_url: { url } },
              { type: "text", text: safeText }
            ],
            ctrl
          );
          ctrl.enqueue(new TextEncoder().encode('data: {"response":"\\n"}\n\n'));
        }

        /* pure‑text turn (if no images) */
        if (images.length === 0) {
          await streamOne([{ type: "text", text }], ctrl);
        }

        ctrl.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        ctrl.close();
      }
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "access-control-allow-origin": "*"
      }
    });
  }
} satisfies ExportedHandler<Env>;
