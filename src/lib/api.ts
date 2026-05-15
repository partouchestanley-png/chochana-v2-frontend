/**
 * Client API pour Chochana v2 — chat-frontend
 *
 * שושנה ז״ל — pour défendre les pauvres
 *
 * Backend v2 : POST /chat → { reply, conversationId, lang, ... }
 *
 * Compatibilité descendante : ce client conserve la forme de réponse
 * `ChatV2Response { ok, data: { response, trace, cached } }` attendue
 * par le composant UI existant, mais l'adapte au nouveau backend v2.
 */

const API_BASE =
  process.env.NEXT_PUBLIC_CHAT_API_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "https://chochana-v2-backend.onrender.com";

// =====================================================================
// Types — réponse compatible avec l'UI existante
// =====================================================================

export interface V2TraceStep {
  step: string;
  [key: string]: unknown;
}

export interface V2Trace {
  steps: V2TraceStep[];
  totalLatencyMs?: number;
}

export interface Citation {
  url: string;
  title: string;
  snippet?: string;
}

export interface ChatV2Response {
  ok: boolean;
  data?: {
    response: string;
    trace: V2Trace;
    cached: boolean;
    conversationId?: string;
    citations?: Citation[];
  };
  error?: { code: string; message: string };
}

export interface SendMessageV2Input {
  message: string;
  bypassCache?: boolean;
  conversationId?: string | null;
  userId?: string | null;
  lang?: string;
  attachments?: Array<{
    base64: string;
    mimeType: string;
    filename?: string;
  }>;
}

// =====================================================================
// Citations — extraction depuis le texte de réponse
// =====================================================================

export interface ExtractedCitation {
  url: string;
  title: string;
  snippet: string;
}

function buildSourceUrl(sourceName: string, reference: string): string | null {
  const ref = encodeURIComponent(reference.trim());
  const lower = sourceName.toLowerCase();
  if (lower.includes("légifrance") || lower.includes("legifrance")) {
    return `https://www.legifrance.gouv.fr/search/all?query=${ref}`;
  }
  if (lower.includes("judilibre")) {
    return `https://www.courdecassation.fr/recherche?search_api_fulltext=${ref}`;
  }
  if (lower.includes("eur-lex") || lower.includes("eurlex")) {
    return `https://eur-lex.europa.eu/search.html?qid=&text=${ref}&scope=EURLEX`;
  }
  if (lower.includes("service-public") || lower.includes("servicepublic")) {
    return `https://www.service-public.fr/particuliers/recherche?keyword=${ref}`;
  }
  return null;
}

export function extractCitations(text: string): ExtractedCitation[] {
  if (!text) return [];
  const seen = new Map<string, ExtractedCitation>();

  // 1) Markdown [Title](url)
  const mdRe = /\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(text)) !== null) {
    const title = m[1].trim();
    const url = m[2].trim();
    if (!seen.has(url)) seen.set(url, { url, title, snippet: "" });
  }

  // 2) Brackets contenant URL
  const bracketUrlRe = /\[([^\]]*?(https?:\/\/[^\s\]]+)[^\]]*?)\]/g;
  while ((m = bracketUrlRe.exec(text)) !== null) {
    const inner = m[1];
    const url = m[2].trim();
    if (seen.has(url)) continue;
    let title = inner.replace(url, "").replace(/[-—:]\s*$/, "").trim();
    if (!title) title = url;
    seen.set(url, { url, title, snippet: "" });
  }

  // 3) Brackets sourcées sans URL
  const bracketSourceRe = /\[([A-Za-zÀ-ÿ][^\]\n]{2,200})\]/g;
  while ((m = bracketSourceRe.exec(text)) !== null) {
    const inner = m[1].trim();
    if (/https?:\/\//.test(inner)) continue;
    const sourceMatch = inner.match(/^([A-Za-zÀ-ÿ][\wÀ-ÿ'-]+)[\s,]+(.+)$/);
    if (!sourceMatch) continue;
    const sourceName = sourceMatch[1];
    const reference = sourceMatch[2].trim().replace(/^[,\s]+/, "");
    const url = buildSourceUrl(sourceName, reference);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.set(url, {
      url,
      title: `${sourceName} — ${reference}`,
      snippet: inner,
    });
  }

  // 4) Bare URLs
  const bareRe = /(?<![[(])https?:\/\/[^\s)\]]+/g;
  while ((m = bareRe.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:]$/, "");
    if (!seen.has(url)) seen.set(url, { url, title: url, snippet: "" });
  }

  return Array.from(seen.values());
}

export function cleanResponseText(text: string): string {
  if (!text) return text;
  return text
    .replace(/^---\s*DRAFT\s+À\s+VÉRIFIER\s*---\s*/im, "")
    .replace(/^---\s*BROUILLON.*?---\s*/im, "")
    .trim();
}

// =====================================================================
// Envoi message — adaptateur vers backend v2 (POST /chat)
// =====================================================================

export async function sendChatMessageV2(
  input: SendMessageV2Input
): Promise<ChatV2Response> {
  const startTime = Date.now();
  try {
    const response = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: input.message,
        conversationId: input.conversationId ?? undefined,
        userId: input.userId ?? undefined,
        lang: input.lang ?? "fr",
        attachments: input.attachments ?? undefined,
      }),
    });

    const totalLatencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errJson = await response.json().catch(() => null);
      return {
        ok: false,
        error: {
          code: errJson?.code || `HTTP_${response.status}`,
          message: errJson?.error || response.statusText || "Erreur backend",
        },
      };
    }

    const json = await response.json();

    // Backend v2 renvoie { reply, conversationId, fromCache, fromCorpus, fromFamily, citations?, ... }
    const reply: string = json.reply || json.response || "";
    const cached: boolean = !!(json.fromCache || json.cached);
    const conversationId: string | undefined = json.conversationId;

    // Construction d'une trace minimale pour compat UI
    const steps: V2TraceStep[] = [];
    if (json.fromFamily) steps.push({ step: "family_hit" });
    if (json.fromCache) steps.push({ step: "cache_hit" });
    if (json.fromCorpus) steps.push({ step: "corpus_hit" });
    if (json.metadata?.memoryHit) steps.push({ step: "memory_hit" });
    if (json.provider || json.model) {
      steps.push({
        step: "llm",
        provider: json.provider,
        model: json.model,
        latencyMs: totalLatencyMs,
      });
    }

    // Extraire les citations (sources web) renvoyées par le backend v2
    const citations: Citation[] = Array.isArray(json.citations)
      ? json.citations
          .filter((c: any) => c && typeof c.url === "string" && c.url.length > 0)
          .map((c: any) => ({
            url: c.url,
            title: c.title || c.url,
            snippet: c.snippet || "",
          }))
      : [];

    return {
      ok: true,
      data: {
        response: reply,
        trace: { steps, totalLatencyMs },
        cached,
        conversationId,
        citations,
      },
    };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err?.message || "Erreur réseau",
      },
    };
  }
}

// =====================================================================
// Helpers trace
// =====================================================================

export interface TraceSummary {
  cached: boolean;
  totalLatencyMs: number;
  connectorsUsed: string[];
  connectorsFailed: string[];
  sourcesCount: number;
  hasMemoryHit: boolean;
}

export function summarizeTrace(
  data: ChatV2Response["data"]
): TraceSummary {
  const empty: TraceSummary = {
    cached: false,
    totalLatencyMs: 0,
    connectorsUsed: [],
    connectorsFailed: [],
    sourcesCount: 0,
    hasMemoryHit: false,
  };
  if (!data) return empty;

  const summary: TraceSummary = { ...empty, cached: !!data.cached };
  const steps = data.trace?.steps || [];
  for (const step of steps) {
    if (step.step === "memory_hit" || step.step === "family_hit") {
      summary.hasMemoryHit = true;
    }
  }
  summary.totalLatencyMs = data.trace?.totalLatencyMs ?? 0;
  return summary;
}

// =====================================================================
// Health check
// =====================================================================

export async function getChatHealth(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return response.json();
  } catch {
    return { ok: false };
  }
}

// =====================================================================
// TTS — non supporté en v2 backend (stub)
// =====================================================================

export interface PlayTTSOptions {
  voice?: "sage" | "nova" | "shimmer" | "alloy" | "echo" | "fable" | "onyx";
  format?: "mp3" | "opus" | "aac" | "flac";
  text: string;
}

export async function fetchTTSAudio(
  options: PlayTTSOptions
): Promise<{ ok: true; blob: Blob } | { ok: false; error: string }> {
  try {
    const base =
      process.env.NEXT_PUBLIC_API_BASE ?? "https://chochana-v2-backend.onrender.com";
    const resp = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: options.text,
        voice: options.voice ?? "nova",
      }),
    });
    if (!resp.ok) {
      let err = `TTS error ${resp.status}`;
      try { const j = await resp.json(); if (j?.error) err = j.error; } catch {}
      return { ok: false, error: err };
    }
    const blob = await resp.blob();
    return { ok: true, blob };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Réseau indisponible pour le TTS" };
  }
}

// =====================================================================
// Export PDF / DOCX — non supporté en v2 backend (stub gracieux)
// =====================================================================

export async function downloadExport(
  format: "pdf" | "docx",
  payload: { title: string; subtitle?: string; content: string }
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (format === "pdf") {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({ unit: "pt", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 56;
      const maxW = pageW - margin * 2;

      // En-tete PRIMUM FACTI
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(120, 95, 36);
      doc.text("PRIMUM FACTI · Chochana", margin, 40);
      doc.setDrawColor(200, 180, 140);
      doc.setLineWidth(0.5);
      doc.line(margin, 50, pageW - margin, 50);

      // Titre
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(40, 40, 40);
      const titleLines = doc.splitTextToSize(payload.title, maxW);
      doc.text(titleLines, margin, 90);

      let y = 90 + titleLines.length * 20 + 6;

      // Sous-titre
      if (payload.subtitle) {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(10);
        doc.setTextColor(120, 120, 120);
        doc.text(payload.subtitle, margin, y);
        y += 22;
      }

      // Corps
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(30, 30, 30);

      const paragraphs = payload.content.split(/\n{2,}/);
      for (const p of paragraphs) {
        const cleaned = p.replace(/^#+\s*/gm, "").replace(/[*_`]/g, "");
        const lines = doc.splitTextToSize(cleaned, maxW);
        for (const line of lines) {
          if (y > pageH - 60) {
            doc.addPage();
            y = 60;
          }
          doc.text(line, margin, y);
          y += 16;
        }
        y += 6;
      }

      // Pied
      const totalPages = (doc as any).internal.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        doc.setTextColor(150, 150, 150);
        doc.text(
          `PRIMUM FACTI · שושנה ז"ל · ${i}/${totalPages}`,
          pageW / 2,
          pageH - 30,
          { align: "center" }
        );
      }

      const filename = sanitizeFilename(payload.title, "pdf");
      doc.save(filename);
      return { ok: true };
    }

    // ---- DOCX ----
    const docxLib = await import("docx");
    const fileSaverMod = await import("file-saver");
    const saveAs = fileSaverMod.saveAs ?? (fileSaverMod as any).default?.saveAs;
    const {
      Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    } = docxLib;

    const paragraphs: any[] = [];
    // En-tete
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "PRIMUM FACTI · Chochana",
            bold: true,
            color: "785F24",
            size: 22,
          }),
        ],
        spacing: { after: 200 },
      })
    );
    // Titre
    paragraphs.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({ text: payload.title, bold: true, size: 32 }),
        ],
        spacing: { after: 120 },
      })
    );
    if (payload.subtitle) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: payload.subtitle,
              italics: true,
              size: 20,
              color: "888888",
            }),
          ],
          spacing: { after: 240 },
        })
      );
    }
    const blocks = payload.content.split(/\n{2,}/);
    for (const blk of blocks) {
      const cleaned = blk.replace(/^#+\s*/gm, "").replace(/[*_`]/g, "");
      for (const line of cleaned.split(/\n/)) {
        paragraphs.push(
          new Paragraph({
            children: [new TextRun({ text: line, size: 22 })],
          })
        );
      }
      paragraphs.push(new Paragraph({ children: [new TextRun("")] }));
    }
    // Pied
    paragraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: "PRIMUM FACTI · שושנה ז\"ל",
            italics: true,
            color: "BBBBBB",
            size: 16,
          }),
        ],
      })
    );

    const doc = new Document({
      creator: "PRIMUM FACTI",
      title: payload.title,
      sections: [{ children: paragraphs }],
    });
    const blob = await Packer.toBlob(doc);
    const filename = sanitizeFilename(payload.title, "docx");
    if (saveAs) {
      saveAs(blob, filename);
    } else {
      // Fallback download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }
    return { ok: true };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message ?? `Erreur génération ${format.toUpperCase()}`,
    };
  }
}

function sanitizeFilename(title: string, ext: string): string {
  const safe = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .substring(0, 60);
  return `${safe || "document_chochana"}.${ext}`;
}

// =====================================================================
// LEGACY — ancien endpoint /api/chat/message (kept for compat)
// =====================================================================

export interface ChatMessageResponse {
  ok: boolean;
  data?: {
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string;
    assistantText: string;
    taskKind: string;
    provider: string;
    model: string;
    latencyMs: number;
    tokensUsed: { input: number; output: number };
    citations?: Array<{ url: string; title: string; snippet: string }>;
    error: string | null;
  };
  error?: { code: string; message: string };
}

export interface SendMessageInput {
  sessionId: string | null;
  message: string;
  attachedImage?: { base64: string; mimeType: string };
  attachments?: Array<{
    base64: string;
    mimeType: string;
    filename?: string;
  }>;
}

export async function sendChatMessage(
  input: SendMessageInput
): Promise<ChatMessageResponse> {
  // Redirige vers v2 EN PRESERVANT le sessionId (mémoire conversationnelle)
  const v2 = await sendChatMessageV2({
    message: input.message,
    attachments: input.attachments,
    conversationId: input.sessionId,
  });
  if (!v2.ok || !v2.data) {
    return {
      ok: false,
      error: v2.error,
    };
  }
  return {
    ok: true,
    data: {
      sessionId: v2.data.conversationId || "",
      userMessageId: "",
      assistantMessageId: "",
      assistantText: v2.data.response,
      taskKind: "chat",
      provider: "chochana-v2",
      model: "chochana-v2",
      latencyMs: v2.data.trace?.totalLatencyMs || 0,
      tokensUsed: { input: 0, output: 0 },
      citations: (v2.data.citations || []).map((c) => ({
        url: c.url,
        title: c.title,
        snippet: c.snippet || "",
      })),
      error: null,
    },
  };
}

// =====================================================================
// Utils — file → base64
// =====================================================================

export function fileToBase64(
  file: File
): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const [header, base64] = result.split(",");
      const mimeMatch = (header || "").match(/^data:([^;]+);/);
      const mimeType = mimeMatch?.[1] || file.type || "image/jpeg";
      resolve({ base64: base64 || "", mimeType });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
