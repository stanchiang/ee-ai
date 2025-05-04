/* Cloudflare Worker – Image‑to‑Circuit Chat
Emits five ASCII‑only blocks:
SUMMARY · SCHEMATIC · PCB · BOM
(retains all original ASCII‑diagram constraints)
*/
import type { Ai } from "@cloudflare/ai";

export interface Env { AI: Ai }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "POST") {
      const url = new URL(request.url);
      
      if (url.pathname === "/api/translate") {
        const { language, content } = await request.json() as { language: string; content: { schematic: string; pcb: string; bom: string } };
        
        const messages = [
          {
            role: "system",
            content: `You are a technical translator. Translate the following circuit specification into ${language}. 
            Maintain the technical accuracy while making it natural in the target language.
            Format the output as a clear technical document with sections for Schematic, PCB, and BOM.
            Use appropriate technical terminology in the target language.
            
            IMPORTANT: Only output the translation. Do not include any introductory text, explanations, or closing remarks.
            The output should start directly with the translated content.`
          },
          {
            role: "user",
            content: `Translate this circuit specification:

Schematic:
${content.schematic}

PCB:
${content.pcb}

BOM:
${content.bom}`
          }
        ];

        const aiStream = await env.AI.run(
          "@cf/meta/llama-4-scout-17b-16e-instruct",
          { messages, stream: true, max_tokens: 9999 }
        );

        const stream = new ReadableStream({
          async start(controller) {
            const reader = aiStream.getReader();
            const encoder = new TextEncoder();
            
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
                break;
              }
              
              const str = new TextDecoder().decode(value);
              const m = str.match(/^data:\s*(\{.*})/);
              if (m) {
                const obj = JSON.parse(m[1]);
                controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n'));
              }
            }
          }
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          }
        });
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
              "⚠️ Always make realistic, sensible assumptions.",
              "",
              "⚙️ **OUTPUT FORMAT (MANDATORY)** – reply with these five ASCII‑only blocks *in order*:",
              "=== SUMMARY ===",
              "(concise natural‑language explanation, ≤ 10 lines)",
              "=== SCHEMATIC ===",
              "(ASCII circuit diagram of a complete, functional electronic circuit with arrows)",
              "=== PCB ===",
              "(ASCII representation of the PCB layout)",
              "=== BOM ===",
              "(plain ASCII list:  Ref   Value   Part‑type)",
              "",
              "Inside *SCHEMATIC* (and PCB):",
              " • Use only printable ASCII – no code fences, no HTML.",
              " • Label every component with its type and value (e.g., R1 1 kΩ, C1 10 µF, 555 Timer).",
              " • Show connections with lines; box or nest multi‑pin ICs when appropriate.",
              " • Use standard components (resistors, capacitors, ICs, transistors, diodes, etc.).",
              "",
              "IMPORTANT RULES:",
              "1. If the user asks a question about the existing design (e.g., 'What does R1 do?', 'How does this circuit work?', 'Explain this component'),",
              "   ONLY output the SUMMARY section with your answer. Do NOT redraw the schematic, PCB, or BOM.",
              "2. If the user wants to modify or create a new design, output all five blocks as usual.",
              "3. If you must refuse, output exactly: ERROR",
              "",
              "📷 Image rule: if the user supplies a photo, assume it shows the target device and design a circuit that reproduces its main function.",
            ].join("\n"),
          },
        ];

        const aiStream = await env.AI.run(
          "@cf/meta/llama-4-scout-17b-16e-instruct",
          { messages, stream: true, max_tokens: 9999, seed: 1}
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

    return new Response("Expected POST", { status: 405 });
  }
} satisfies ExportedHandler<Env>;