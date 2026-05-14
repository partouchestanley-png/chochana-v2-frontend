/**
 * Petit renderer Markdown léger (sans dépendance externe lourde).
 *
 * שושנה ז״ל
 */

/**
 * Convertit un Markdown simplifié en HTML safe.
 * Supporte : **gras**, *italique*, `code`, # titres, listes -, [lien](url)
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";

  // ── Doctrine d'identité Chochana ────────────────────────────────────
  // La signature שושנה ז״ל ne doit JAMAIS apparaître dans le chat
  // conversationnel. Elle est réservée au footer du site et aux exports
  // PDF/Word formels (ces exports prennent le texte source brut depuis
  // le backend, donc ce nettoyage ne les affecte pas).
  let cleaned = text
    // Lignes contenant uniquement la signature (avec espaces autour)
    .replace(/^\s*שושנה\s*ז״ל\s*$/gm, "")
    // Variante avec guillemets droits (parfois remplacés par le LLM)
    .replace(/^\s*שושנה\s*ז"ל\s*$/gm, "")
    // Forme inline en fin de texte
    .replace(/[\s\n]*שושנה\s*ז["״]ל[\s\n]*$/g, "")
    // Bloc 6 : doctrine Stanley — le moteur demande, il ne labélise pas.
    // On supprime le préfixe "Question :" du contenu pour qu'il ne reste
    // que la phrase pure (qui sera ensuite rendue en italique).
    .replace(/(^6\.\s+Question\s*\n)Question\s*:\s*/gim, "$1")
    // Nettoyer les sauts de ligne triples résiduels
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  // ── BLOCS VIDES ─ SUPPRESSION PURE (doctrine Stanley) ─────────────────
  // Si un bloc ULTRA v2 ne contient pas de contenu réel (juste le titre,
  // ou une phrase creuse type "aucun risque", "néant", "rien à signaler",
  // "non applicable"), on le supprime entièrement. Pas de mention "vide".
  //
  // L'évaluation peut figurer dans la phrase de synthèse globale du bloc 1
  // (Situation), pas dans un bloc dédié vide.
  // Patterns pour détecter qu'un bloc n'a rien de substantiel à dire.
  // On match plus largement : n'importe quelle phrase débutant par
  // "aucun/aucune/néant/non applicable/..." même si elle se termine par
  // un mot accessoire ("aucun risque particulier", "pas de point critique »).
  const EMPTY_PATTERNS: RegExp[] = [
    /^\s*$/,
    /^(aucun(?:e)?|n[ée]ant|rien\s+à\s+signaler|non\s+applicable|n[/.]?\s*a\.?|sans\s+objet|pas\s+(?:de|d')[\s\S]{0,40})\b[\s\S]{0,80}$/i,
  ];
  const BLOCK_TITLE_RE =
    /^(\d+)\.\s+(Situation|Probl[èe]me|Point\s+critique|Risques|Actions|Question)\s*$/im;

  // Approche : on découpe par blocs (chaque bloc commence par "N. Titre")
  // et on filtre ceux dont le contenu est creux.
  {
    const lines = cleaned.split("\n");
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const m = line.match(BLOCK_TITLE_RE);
      if (m) {
        // Début d'un bloc : on collecte jusqu'au prochain titre ou EOF
        const titleLine = line;
        const contentLines: string[] = [];
        let j = i + 1;
        while (j < lines.length && !lines[j].match(BLOCK_TITLE_RE)) {
          contentLines.push(lines[j]);
          j++;
        }
        const content = contentLines.join("\n").trim();
        // Bloc vide ? → on saute (titre + contenu non émis)
        // Première ligne (souvent la phrase tronçon à évaluer)
        const firstLine = contentLines
          .find((l) => l.trim().length > 0)
          ?.trim() ?? "";
        const isEmpty =
          content.length < 15 ||
          EMPTY_PATTERNS.some((p) => p.test(firstLine)) ||
          EMPTY_PATTERNS.some((p) => p.test(content));
        if (!isEmpty) {
          out.push(titleLine);
          out.push(...contentLines);
        }
        i = j;
      } else {
        out.push(line);
        i++;
      }
    }
    cleaned = out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  }

  // Échapper d'abord les caractères HTML
  let html = cleaned
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks ```...```
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Titres ### / ## / #
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // ── BLOC 6 (Question) ─ RENDU SPÉCIAL : pas de titre ────────────────────
  // Doctrine Stanley : le moteur demande, il ne labélise pas.
  // Aucune révélation de structure interne (pas de "6. Question").
  // On transforme la séquence "6. Question\n<phrase>" en :
  //   - séparateur discret (em-dash centré)
  //   - phrase suivante en italique sobre
  html = html.replace(
    /^6\.\s+Question\s*\n+([^\n][^\n]*(?:\n(?!\n)[^\n]*)*)/gim,
    '<div class="chochana-block-question" style="margin:1.5rem 0 0.5rem 0;text-align:center;color:#A8A29E">—</div>\n<p style="font-style:italic;color:#3F3A33;margin:0.5rem 0;line-height:1.55">$1</p>'
  );

  // Blocs Chochana ULTRA v2 : '1. Situation', '2. Problème', etc.
  // Ces lignes ne sont PAS des items de liste, ce sont des TITRES de section.
  // On les détecte spécifiquement et on les rend en <h3> avec un style fort.
  // NOTE : le bloc 6 "Question" est exclu (déjà traité ci-dessus en italique).
  const CHOCHANA_BLOCK_TITLES = [
    "Situation",
    "Problème",
    "Probleme",
    "Point critique",
    "Risques",
    "Actions",
    // "Question" volontairement absent : traité ci-dessus comme italique
  ];
  const blockTitleAlt = CHOCHANA_BLOCK_TITLES.map((t) =>
    t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join("|");
  const blockHeadingRe = new RegExp(
    `^(\\d+)\\.\\s+(${blockTitleAlt})\\s*$`,
    "gmi"
  );
  html = html.replace(
    blockHeadingRe,
    '<h3 class="chochana-block-heading" style="font-family:Georgia,Cambria,serif;font-weight:700;font-size:1rem;color:#1F1A14;margin:1.25rem 0 0.5rem 0;padding-bottom:0.25rem;border-bottom:1px solid #E5DFD2">$1. $2</h3>'
  );

  // Listes avec - ou *
  html = html.replace(/^[\-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Listes numérotées (résiduelles, hors blocs Chochana déjà traités au-dessus)
  html = html.replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>");

  // Gras et italique
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Liens [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#2F7A4F;text-decoration:underline">$1</a>'
  );

  // Paragraphes : double saut de ligne → </p><p>
  const blocks = html.split(/\n\n+/);
  html = blocks
    .map((b) => {
      const trimmed = b.trim();
      if (!trimmed) return "";
      // Si déjà un block element, on laisse
      if (/^<(h[1-6]|ul|ol|pre|li)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  return html;
}
