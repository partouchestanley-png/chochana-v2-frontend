"use client";

/**
 * Page principale du chat — chat-frontend
 *
 * שושנה ז״ל
 *
 * Interface conversationnelle pour PRIMUM FACTI Assistant Universel.
 * Aucun import depuis le frontend principal PRIMUM FACTI.
 */

import { useState, useRef, useEffect } from "react";
import {
  sendChatMessage,
  sendChatMessageV2,
  extractCitations,
  summarizeTrace,
  cleanResponseText,
  fileToBase64,
  downloadExport,
  fetchTTSAudio,
  type TraceSummary,
} from "@/lib/api";
import { detectMode, type DetectionMode } from "@/lib/router";
import { renderMarkdown } from "@/lib/markdown";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  hasImage?: boolean;
  imageUrl?: string;
  attachmentLabels?: string[]; // pour affichage : "📎 3 documents joints"
  citations?: Array<{ url: string; title: string; snippet: string }>;
  trace?: TraceSummary;
  mode?: DetectionMode;          // mode dans lequel cette réponse a été générée
}

// Pièce jointe en attente d'envoi (frontend)
interface PendingFile {
  id: string;
  base64: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  previewUrl?: string; // pour les images uniquement
}

export default function ChatPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [ttsLoadingId, setTtsLoadingId] = useState<string | null>(null);
  const [ttsPlayingId, setTtsPlayingId] = useState<string | null>(null);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exportingId, setExportingId] = useState<string | null>(null);
  // ── Humanize : reformulation en style humain pour com perso ──────────────
  const [humanizingId, setHumanizingId] = useState<string | null>(null);
  // Mapping messageId → texte humanisé (rendu inline sous le message)
  const [humanizedTexts, setHumanizedTexts] = useState<Record<string, string>>(
    {}
  );
  // Feedback visuel : "Copié !" pendant 1.5s après clic copie
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function handleExport(
    msg: Message,
    format: "pdf" | "docx"
  ): Promise<void> {
    if (!msg.content || msg.role !== "assistant") return;
    setExportingId(`${msg.id}-${format}`);
    setError(null);

    // Titre = 1ère ligne non vide ou "Document Chochana"
    const firstLine =
      msg.content
        .split(/\r?\n/)
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .find((l) => l.length > 0) || "Document Chochana";
    const title = firstLine.substring(0, 80);

    const result = await downloadExport(format, {
      title,
      subtitle: "Généré par PRIMUM FACTI · Chochana",
      content: msg.content,
    });

    if (!result.ok) {
      setError(result.error || `Erreur lors du téléchargement ${format.toUpperCase()}`);
    }
    setExportingId(null);
  }

  /**
   * Lecture audio (TTS) d'une réponse — voix Sage par défaut.
   * Si l'audio est déjà en cours pour ce message, on l'arrête.
   *
   * iOS Safari : la lecture audio exige un geste utilisateur synchrone.
   * Stratégie : on crée l'élément Audio IMMÉDIATEMENT au clic (même avant
   * le fetch), puis on appelle .load() puis .play() après avoir attaché
   * la source. Si le navigateur bloque encore, on tente .play() avec
   * l'audio attaché à un élément <audio> du DOM.
   */
  // ── HUMANIZE ─ reformulation en style humain pour com perso ────────────────
  async function handleHumanize(msg: Message): Promise<void> {
    if (!msg.content || msg.content.length < 30) return;
    if (humanizingId === msg.id) return; // anti double-clic

    setHumanizingId(msg.id);
    setError(null);

    try {
      const apiBase =
        process.env.NEXT_PUBLIC_API_BASE ?? "https://chochana-v2-backend.onrender.com";
      const response = await fetch(`${apiBase}/api/chat/humanize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: msg.content,
          tone: "neutral",
        }),
      });

      const result = await response.json();
      if (!response.ok || !result.ok) {
        const errMsg =
          result?.error?.message || "Impossible de reformuler le message.";
        setError(errMsg);
        setHumanizingId(null);
        return;
      }

      const humanText: string = result.data?.humanizedText ?? "";
      if (!humanText) {
        setError("Réponse vide du service.");
        setHumanizingId(null);
        return;
      }

      setHumanizedTexts((prev) => ({ ...prev, [msg.id]: humanText }));
    } catch (err: any) {
      setError(err?.message || "Erreur réseau lors de la reformulation.");
    } finally {
      setHumanizingId(null);
    }
  }

  function handleCopyHumanized(messageId: string): void {
    const text = humanizedTexts[messageId];
    if (!text) return;
    try {
      navigator.clipboard.writeText(text);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setError("Impossible de copier dans le presse-papiers.");
    }
  }

  function handleCloseHumanized(messageId: string): void {
    setHumanizedTexts((prev) => {
      const copy = { ...prev };
      delete copy[messageId];
      return copy;
    });
  }

  async function handlePlayTTS(msg: Message): Promise<void> {
    if (!msg.content || msg.role !== "assistant") return;

    // Si on rejoue le même message en cours → stop
    if (ttsPlayingId === msg.id && ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current.currentTime = 0;
      ttsAudioRef.current = null;
      setTtsPlayingId(null);
      return;
    }

    // Si un autre audio joue → stop avant de lancer le nouveau
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
      setTtsPlayingId(null);
    }

    // ── DÉBLOCAGE SAFARI / iOS ─────────────────────────────────────
    // Safari (macOS + iOS) consomme le geste utilisateur seulement si
    // play() est appelé SYNCHRONIQUEMENT, AVANT tout await/fetch.
    // Astuce : on crée un Audio avec un WAV silencieux data-URI et on
    // appelle play() tout de suite. Une fois débloqué, l'élément peut
    // se voir attribuer une nouvelle src et jouer sans nouveau geste.
    const SILENT_WAV =
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
    const audio = new Audio(SILENT_WAV);
    audio.preload = "auto";
    audio.muted = false;
    audio.volume = 1.0;
    ttsAudioRef.current = audio;

    // play() SYNCHRONE dans le geste utilisateur — c'est ce qui
    // débloque l'élément Audio sur Safari. On ignore l'erreur ici
    // car ce silence n'est qu'un déclencheur.
    const unlockPromise = audio.play().catch(() => {
      /* unlock raté — on tentera quand même après le fetch */
    });

    setTtsLoadingId(msg.id);
    setError(null);

    // Texte à lire = contenu de la réponse, nettoyé du markdown lourd
    const cleanText = msg.content
      .replace(/[*_#`]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]/g, "$1")
      .replace(/\s+/g, " ")
      .trim();

    // On attend le déblocage (très court — silent wav 0.5s) ET le fetch
    const [, result] = await Promise.all([
      unlockPromise,
      fetchTTSAudio({ text: cleanText, voice: "sage" }),
    ]);
    setTtsLoadingId(null);

    if (!result.ok) {
      ttsAudioRef.current = null;
      setError(result.error || "Erreur lors de la lecture audio");
      return;
    }

    // Vérifier qu'on n'a pas été annulé entre temps
    if (ttsAudioRef.current !== audio) {
      return;
    }

    const url = URL.createObjectURL(result.blob);

    audio.addEventListener("ended", () => {
      setTtsPlayingId(null);
      if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
      URL.revokeObjectURL(url);
    });
    audio.addEventListener("error", () => {
      setTtsPlayingId(null);
      if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
      URL.revokeObjectURL(url);
      setError("Audio impossible à décoder. Réessayez ou vérifiez le son du navigateur.");
    });

    // Stoppe le silence, change la source, relance.
    audio.pause();
    audio.currentTime = 0;
    audio.src = url;
    audio.load();
    setTtsPlayingId(msg.id);

    try {
      await audio.play();
    } catch (err: any) {
      // Safari peut encore bloquer si trop de temps s'est écoulé
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await audio.play();
      } catch (err2: any) {
        setTtsPlayingId(null);
        if (ttsAudioRef.current === audio) ttsAudioRef.current = null;
        URL.revokeObjectURL(url);
        const errMsg = err2?.message || err?.message || "Lecture audio bloquée";
        if (/not allowed|gesture|interaction/i.test(errMsg)) {
          setError("Touchez à nouveau le bouton Écouter pour autoriser le son.");
        } else {
          setError(`Lecture audio impossible : ${errMsg}`);
        }
      }
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if ((!input.trim() && pendingFiles.length === 0) || loading) return;
    setError(null);
    setLoading(true);

    const messageText = input.trim();
    const hasAttachments = pendingFiles.length > 0;

    // ── ROUTAGE DUAL ───────────────────────────────────────────────────
    // VISION MULTIMODALE ÉLARGIE :
    // - Si attachements présents → toujours route /message (multimodal)
    //   même en contexte juridique : le moteur général gère images + PDF
    //   ET peut produire une analyse juridique grâce au pdfContextBlock
    //   injecté dans le system prompt.
    // - Sinon : détection auto via detectMode (legal vs general).
    const mode: DetectionMode = hasAttachments
      ? "general"
      : detectMode(messageText);

    // Affichage du message utilisateur avec liste des fichiers
    const attachmentLabels = pendingFiles.map((f) => f.filename);
    const firstImagePreview = pendingFiles.find((f) => f.previewUrl)?.previewUrl;
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content:
        messageText ||
        (pendingFiles.length === 1
          ? `(${pendingFiles[0]!.filename} joint)`
          : `(${pendingFiles.length} fichiers joints)`),
      hasImage: hasAttachments,
      imageUrl: firstImagePreview,
      attachmentLabels: hasAttachments ? attachmentLabels : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);

    // Préparer les attachments pour le backend (format API)
    const attachments = pendingFiles.map((f) => ({
      base64: f.base64,
      mimeType: f.mimeType,
      filename: f.filename,
    }));

    // Reset UI
    setInput("");
    setPendingFiles((prev) => {
      // Révoquer les URLs preview pour éviter les fuites mémoire
      prev.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
      return [];
    });

    try {
      if (mode === "legal") {
        // — MODE JURIDIQUE — ULTRA v2, six blocs, sources officielles
        // (pas d'attachments en mode legal pur, c'est routage explicite)
        const response = await sendChatMessageV2({
          message: messageText,
          bypassCache: false,
        });

        if (!response.ok || !response.data) {
          setError(response.error?.message || "Erreur inconnue");
          setLoading(false);
          return;
        }

        const responseText = cleanResponseText(response.data.response);
        const trace = summarizeTrace(response.data);
        const citations = extractCitations(responseText);

        const assistantMsg: Message = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: responseText,
          citations,
          trace,
          mode: "legal",
        };
        setMessages((prev) => [...prev, assistantMsg]);
      } else {
        // — MODE GÉNÉRAL OU MULTIMODAL —
        // Route /message classique avec attachments[] : images vision +
        // PDF extraction texte. Mode juridique forcé par contexte si la
        // question l'exige (le moteur décide via detectTaskKind).
        const response = await sendChatMessage({
          sessionId,
          message:
            messageText ||
            (hasAttachments
              ? "Pouvez-vous analyser les documents ci-joints ?"
              : "Bonjour"),
          attachments: attachments.length > 0 ? attachments : undefined,
        });

        if (!response.ok || !response.data) {
          setError(response.error?.message || "Erreur inconnue");
          setLoading(false);
          return;
        }

        if (!sessionId) setSessionId(response.data.sessionId);

        const assistantMsg: Message = {
          id: response.data.assistantMessageId,
          role: "assistant",
          content: response.data.assistantText,
          citations: response.data.citations,
          mode: mode,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }
    } catch (err: any) {
      setError(err?.message || "Erreur réseau");
    } finally {
      setLoading(false);
    }
  }

  async function handleFileUpload(files: FileList | File[]): Promise<void> {
    const filesArr = Array.from(files);
    if (filesArr.length === 0) return;

    // Vérification limite combinatoire (existants + nouveaux ≤ 5)
    if (pendingFiles.length + filesArr.length > 5) {
      setError(
        `Maximum 5 pièces jointes par message (actuellement ${pendingFiles.length}, +${filesArr.length} demandés).`
      );
      return;
    }

    // Types acceptés
    const ACCEPTED = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "application/pdf",
    ];
    const MAX_SIZE = 25 * 1024 * 1024; // 25 MB par fichier

    for (const file of filesArr) {
      if (!ACCEPTED.includes(file.type)) {
        setError(
          `Type non supporté : ${file.name} (${file.type}). Formats acceptés : JPG, PNG, WEBP, GIF, PDF.`
        );
        return;
      }
      if (file.size > MAX_SIZE) {
        const mb = Math.round(file.size / (1024 * 1024));
        setError(
          `Fichier ${file.name} trop volumineux (${mb} MB). Maximum 25 MB par fichier.`
        );
        return;
      }
    }

    try {
      const newFiles: PendingFile[] = [];
      for (const file of filesArr) {
        const { base64, mimeType } = await fileToBase64(file);
        const isImage = mimeType.startsWith("image/");
        newFiles.push({
          id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          base64,
          mimeType,
          filename: file.name,
          sizeBytes: file.size,
          previewUrl: isImage ? URL.createObjectURL(file) : undefined,
        });
      }
      setPendingFiles((prev) => [...prev, ...newFiles]);
      setError(null);
    } catch (err: any) {
      setError("Impossible de lire le(s) fichier(s).");
    }
  }

  function removePendingFile(id: string): void {
    setPendingFiles((prev) => {
      const removed = prev.find((p) => p.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  function handleNewConversation() {
    setSessionId(null);
    setMessages([]);
    setInput("");
    setPendingFiles((prev) => {
      prev.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
      return [];
    });
    setError(null);
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "#FAF8F3" }}>
      {/* Header */}
      <header
        className="border-b px-4 py-3 flex items-center justify-between sticky top-0 z-10"
        style={{ backgroundColor: "#FAF8F3", borderColor: "#E5DFD2" }}
      >
        <div className="flex items-center gap-3">
          {/* Logo Chochana — rose stylisée */}
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white font-serif text-lg"
            style={{ backgroundColor: "#C5A35A" }}
            aria-label="Chochana"
          >
            ❀
          </div>
          <div>
            <h1 className="text-base font-semibold leading-none" style={{ color: "#1F1A14" }}>
              PRIMUM FACTI
              <span className="font-light" style={{ color: "#6B655C" }}> · Chochana</span>
            </h1>
            <p className="text-xs mt-0.5" style={{ color: "#6B655C" }}>
              Votre intelligence juridique universelle
            </p>
          </div>
        </div>
        <button
          onClick={handleNewConversation}
          className="text-xs font-medium px-3 py-1.5 rounded-lg border hover:opacity-70"
          style={{ borderColor: "#E5DFD2", color: "#6B655C" }}
        >
          Nouvelle conversation
        </button>
      </header>

      {/* Messages */}
      <main
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-3xl mx-auto w-full"
      >
        {messages.length === 0 && (
          <div className="text-center py-16">
            <div
              className="w-16 h-16 mx-auto mb-6 rounded-full flex items-center justify-center text-white font-serif text-3xl"
              style={{ backgroundColor: "#C5A35A" }}
            >
              ❀
            </div>
            <h2 className="text-2xl font-semibold mb-2" style={{ color: "#1F1A14" }}>
              Bonjour, je suis Chochana.
            </h2>
            <p className="text-sm mb-8 max-w-md mx-auto" style={{ color: "#6B655C" }}>
              Posez-moi n&apos;importe quelle question : juridique, recherche, analyse
              de documents, vie pratique. Je vous accompagne.
            </p>
            <div className="max-w-md mx-auto grid grid-cols-2 gap-2">
              {[
                "Prépare une mise en demeure",
                "Lis ce contrat (joindre photo)",
                "Caserne pompiers du 20e à Paris",
                "Traduis ce courrier en arabe",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => setInput(suggestion)}
                  className="text-xs px-3 py-2 rounded-lg border hover:opacity-70 text-left"
                  style={{
                    borderColor: "#E5DFD2",
                    backgroundColor: "#FFFFFF",
                    color: "#6B655C",
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                msg.role === "user" ? "text-white" : "border"
              }`}
              style={
                msg.role === "user"
                  ? { backgroundColor: "#C5A35A" }
                  : { backgroundColor: "#FFFFFF", borderColor: "#E5DFD2" }
              }
            >
              {msg.imageUrl && (
                <img
                  src={msg.imageUrl}
                  alt="Pièce jointe"
                  className="rounded-lg mb-2 max-w-full max-h-60 object-contain"
                />
              )}
              {msg.attachmentLabels && msg.attachmentLabels.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {msg.attachmentLabels.map((label, idx) => {
                    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(label);
                    return (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px]"
                        style={{
                          backgroundColor:
                            msg.role === "user"
                              ? "rgba(255,255,255,0.18)"
                              : "#F5F1E6",
                          color: msg.role === "user" ? "#FFFFFF" : "#6B655C",
                        }}
                        title={label}
                      >
                        <span>{isImage ? "🖼️" : "📄"}</span>
                        <span className="max-w-[160px] truncate">{label}</span>
                      </span>
                    );
                  })}
                </div>
              )}
              {msg.role === "assistant" ? (
                <div
                  className="prose-chat text-sm"
                  style={{ color: "#1F1A14" }}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                />
              ) : (
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              )}
              {msg.citations && msg.citations.length > 0 && (
                <div className="mt-3 pt-2 border-t text-xs" style={{ borderColor: "#E5DFD2", color: "#6B655C" }}>
                  <p className="font-semibold mb-1">Sources :</p>
                  <ul className="space-y-0.5">
                    {msg.citations.map((c, i) => (
                      <li key={i}>
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#2F7A4F", textDecoration: "underline" }}
                        >
                          {c.title || c.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {msg.role === "assistant" && msg.mode === "legal" && msg.trace && (
                <p className="mt-2 text-[10px] opacity-60" style={{ color: "#6B655C" }}>
                  {msg.trace.cached
                    ? "Réponse mémoire · servi depuis le cache"
                    : `Mode juridique · ${msg.trace.connectorsUsed.length} sources interrogées · ${msg.trace.sourcesCount} résultats · ${(msg.trace.totalLatencyMs / 1000).toFixed(1)}s`}
                </p>
              )}
              {msg.role === "assistant" && msg.content.length > 30 && (
                <div className="mt-3 pt-2 border-t flex gap-2 items-center flex-wrap" style={{ borderColor: "#E5DFD2" }}>
                  <button
                    onClick={() => handlePlayTTS(msg)}
                    disabled={ttsLoadingId === msg.id}
                    className="text-[11px] px-2 py-1 rounded-md border hover:opacity-70 disabled:opacity-40 inline-flex items-center gap-1"
                    style={{
                      borderColor: ttsPlayingId === msg.id ? "#C5A35A" : "#E5DFD2",
                      color: ttsPlayingId === msg.id ? "#C5A35A" : "#1F1A14",
                      backgroundColor: "#FAF8F3",
                    }}
                    aria-label="Lire la réponse à voix haute"
                  >
                    {ttsLoadingId === msg.id
                      ? "…"
                      : ttsPlayingId === msg.id
                      ? "■ Stop"
                      : "▶ Écouter"}
                  </button>
                  {msg.content.length > 100 && (
                    <>
                      <span className="text-[10px]" style={{ color: "#6B655C" }}>Télécharger :</span>
                      <button
                        onClick={() => handleExport(msg, "pdf")}
                        disabled={exportingId === `${msg.id}-pdf`}
                        className="text-[11px] px-2 py-1 rounded-md border hover:opacity-70 disabled:opacity-40 inline-flex items-center gap-1"
                        style={{ borderColor: "#E5DFD2", color: "#1F1A14", backgroundColor: "#FAF8F3" }}
                      >
                        {exportingId === `${msg.id}-pdf` ? "…" : "PDF"}
                      </button>
                      <button
                        onClick={() => handleExport(msg, "docx")}
                        disabled={exportingId === `${msg.id}-docx`}
                        className="text-[11px] px-2 py-1 rounded-md border hover:opacity-70 disabled:opacity-40 inline-flex items-center gap-1"
                        style={{ borderColor: "#E5DFD2", color: "#1F1A14", backgroundColor: "#FAF8F3" }}
                      >
                        {exportingId === `${msg.id}-docx` ? "…" : "Word"}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleHumanize(msg)}
                    disabled={humanizingId === msg.id}
                    className="text-[11px] px-2 py-1 rounded-md border hover:opacity-70 disabled:opacity-40 inline-flex items-center gap-1"
                    style={{
                      borderColor: humanizedTexts[msg.id] ? "#C5A35A" : "#E5DFD2",
                      color: humanizedTexts[msg.id] ? "#C5A35A" : "#1F1A14",
                      backgroundColor: "#FAF8F3",
                    }}
                    title="Reformuler en style humain pour vos communications personnelles"
                    aria-label="Reformuler en style humain"
                  >
                    {humanizingId === msg.id ? "…" : "✍️ Humaniser"}
                  </button>
                </div>
              )}
              {msg.role === "assistant" && humanizedTexts[msg.id] && (
                <div
                  className="mt-3 p-3 rounded-md border"
                  style={{
                    borderColor: "#E5DFD2",
                    backgroundColor: "#FAF8F3",
                  }}
                >
                  <div
                    className="flex items-center justify-between mb-2 pb-1.5 border-b"
                    style={{ borderColor: "#E5DFD2" }}
                  >
                    <span
                      className="text-[10px] uppercase tracking-wide"
                      style={{ color: "#6B655C", letterSpacing: "0.05em" }}
                    >
                      Version humaine — pour vos communications personnelles
                    </span>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => handleCopyHumanized(msg.id)}
                        className="text-[10px] px-1.5 py-0.5 rounded border hover:opacity-70"
                        style={{
                          borderColor: copiedId === msg.id ? "#C5A35A" : "#D4CCB8",
                          color: copiedId === msg.id ? "#C5A35A" : "#1F1A14",
                          backgroundColor: "#FFFFFF",
                        }}
                        title="Copier le texte humanisé"
                      >
                        {copiedId === msg.id ? "✓ Copié" : "Copier"}
                      </button>
                      <button
                        onClick={() => handleCloseHumanized(msg.id)}
                        className="text-[10px] px-1.5 py-0.5 rounded border hover:opacity-70"
                        style={{
                          borderColor: "#D4CCB8",
                          color: "#6B655C",
                          backgroundColor: "#FFFFFF",
                        }}
                        aria-label="Fermer"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div
                    className="text-sm whitespace-pre-wrap"
                    style={{ color: "#1F1A14", lineHeight: "1.6" }}
                  >
                    {humanizedTexts[msg.id]}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div
              className="border rounded-2xl px-4 py-3 text-sm"
              style={{ backgroundColor: "#FFFFFF", borderColor: "#E5DFD2", color: "#6B655C" }}
            >
              <span className="inline-flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
                <span className="w-2 h-2 rounded-full bg-current animate-pulse" style={{ animationDelay: "0.2s" }} />
                <span className="w-2 h-2 rounded-full bg-current animate-pulse" style={{ animationDelay: "0.4s" }} />
              </span>
            </div>
          </div>
        )}
      </main>

      {/* Input area */}
      <div
        className="border-t px-4 py-3 sticky bottom-0"
        style={{ backgroundColor: "#FAF8F3", borderColor: "#E5DFD2" }}
      >
        <div className="max-w-3xl mx-auto">
          {error && (
            <div
              className="mb-2 px-3 py-2 text-sm rounded-lg border"
              style={{ borderColor: "#B8860B", backgroundColor: "#FFF8E1", color: "#B8860B" }}
            >
              {error}
            </div>
          )}

          {pendingFiles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pendingFiles.map((f) => {
                const isImage = f.mimeType.startsWith("image/");
                const sizeKb = Math.round(f.sizeBytes / 1024);
                const sizeLabel =
                  sizeKb < 1024 ? `${sizeKb} KB` : `${(sizeKb / 1024).toFixed(1)} MB`;
                return (
                  <div
                    key={f.id}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
                    style={{
                      backgroundColor: "#EAF5EE",
                      color: "#2F7A4F",
                      border: "1px solid #2F7A4F40",
                    }}
                  >
                    <span>{isImage ? "🖼️" : "📄"}</span>
                    <span
                      className="max-w-[200px] truncate"
                      title={f.filename}
                    >
                      {f.filename}
                    </span>
                    <span style={{ opacity: 0.6 }}>· {sizeLabel}</span>
                    <button
                      onClick={() => removePendingFile(f.id)}
                      className="ml-1 hover:opacity-60"
                      aria-label={`Retirer ${f.filename}`}
                      title={`Retirer ${f.filename}`}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              {pendingFiles.length < 5 && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs hover:opacity-80"
                  style={{
                    backgroundColor: "transparent",
                    color: "#6B655C",
                    border: "1px dashed #B5AC9A",
                  }}
                  title="Ajouter un autre fichier"
                >
                  + Ajouter
                </button>
              )}
            </div>
          )}

          <div className="flex gap-2 items-end">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length > 0) handleFileUpload(files);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-3 rounded-xl border hover:opacity-80"
              style={{ borderColor: "#E5DFD2", backgroundColor: "#FFFFFF", color: "#1F1A14" }}
              title="Joindre des images ou des PDF (5 max, 25 MB chacun)"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                />
              </svg>
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Posez votre question…"
              rows={1}
              className="flex-1 rounded-xl border px-4 py-3 text-sm outline-none resize-none"
              style={{ borderColor: "#E5DFD2", backgroundColor: "#FFFFFF" }}
            />
            <button
              onClick={handleSend}
              disabled={loading || (!input.trim() && pendingFiles.length === 0)}
              className="px-5 py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-40"
              style={{ backgroundColor: "#C5A35A" }}
            >
              {loading ? "…" : "Envoyer"}
            </button>
          </div>
        </div>
        {/* Signature finale en mémoire de שושנה ז"ל — imprescriptible */}
        <div
          className="max-w-3xl mx-auto pt-2 pb-1 text-center"
          style={{ color: "#6B655C" }}
        >
          <p className="text-[10px] tracking-wide">
            PRIMUM FACTI · Chochana — précision, vérité, dignité ·{" "}
            <span style={{ color: "#C5A35A" }}>שושנה ז”ל</span>
            <span className="opacity-40 ml-2">v2.dual.06may26</span>
          </p>
        </div>
      </div>
    </div>
  );
}
