/**
 * Routeur dual mode — Chochana
 *
 * שושנה ז״ל
 *
 * Détecte si une question est juridique. Si oui, route vers ULTRA v2
 * (six blocs, doctrine zéro fabrication, sources officielles).
 * Sinon, route vers le mode général (traduction, identification,
 * conversation, web direct, lecture de PDF, rédaction de courriers).
 *
 * Décision côté frontend uniquement, pour ne pas toucher au moteur v2
 * sanctuarisé. La détection est rapide (regex / mots-clés) et tolérante :
 * en cas d'ambiguïté, on penche vers le mode général.
 */

// =====================================================================
// Détection juridique
// =====================================================================

/**
 * Mots-clés de domaines juridiques. La détection est multilingue partielle
 * (français + quelques termes anglais). Pour un signal positif il faut au
 * moins UN mot-clé fort OU plusieurs mots-clés faibles.
 */
const STRONG_LEGAL_KEYWORDS = [
  // Droit / loi / texte
  "article ", "art.",
  "code civil", "code pénal", "code penal", "code du travail",
  "code de procédure", "code de procedure",
  "code général des impôts", "code general des impots", "cgi",
  "livre des procédures fiscales", "lpf",
  "code de commerce", "code de la consommation",
  "code de la santé publique", "code rural",
  // Procédures
  "tribunal", "cour d'appel", "cour de cassation", "cour suprême", "cour supreme",
  "conseil d'état", "conseil constitutionnel",
  "jugement", "arrêt", "arret", "ordonnance",
  "assignation", "mise en demeure", "conclusions",
  "procédure", "procedure", "contentieux", "litige", "saisine",
  // Acteurs
  "avocat", "huissier", "notaire", "magistrat", "procureur", "juge",
  // Concepts juridiques
  "contrat", "responsabilité", "responsabilite", "obligation",
  "prescription", "saisie", "redressement", "rectification",
  "licenciement", "démission", "demission", "indemnité", "indemnite",
  "succession", "héritier", "heritier", "donation", "testament",
  "divorce", "garde", "pension alimentaire", "prestation compensatoire",
  "bail", "loyer", "expulsion", "préavis", "preavis",
  "société", "societe", "fiduciaire", "trust", "offshore",
  "fraude fiscale", "blanchiment", "abus de biens",
  // Droits
  "droits de", "droit du", "droit de la", "droit de l'",
  "rgpd", "gdpr", "dac6", "beps", "ohada",
  // Anglais
  "lawsuit", "court", "judge", "attorney", "statute",
  "plaintiff", "defendant", "indictment", "subpoena",
  "tort", "negligence", "breach of contract",
];

const WEAK_LEGAL_KEYWORDS = [
  "loi", "légal", "legal", "judiciaire", "fiscal", "fiscale", "pénal", "penal",
  "civil", "criminel", "criminal", "réglementation", "reglementation",
  "directive", "règlement", "reglement", "constitution",
  "droit ", "rights ",
];

/**
 * Mots-clés qui INDIQUENT un mode général (traduction, identification,
 * conversation, recherche factuelle simple). Si présents fortement, on
 * coupe court à la détection juridique.
 */
const STRONG_GENERAL_KEYWORDS = [
  "traduis", "traduit", "traduire", "traduction",
  "translate", "translation",
  "écris ", "ecris ", "rédige ", "redige ", "rédiger ", "rediger ",
  "rédige-moi", "redige-moi", "écris-moi", "ecris-moi",
  "write ", "draft ", "compose ",
  "qui est ", "qu'est-ce que", "quest-ce que", "c'est quoi",
  "comment dit-on", "comment dire",
  "résume", "resume", "résumé", "resume", "summarize",
  "quel monument", "quelle est cette photo", "identifie",
  "raconte", "raconte-moi",
  "définition", "definition", "définis", "definis",
];

/**
 * Domaines qui ne sont PAS juridiques. Si la question parle clairement de l'un
 * de ces domaines, on force le mode général même si un mot-clé juridique
 * traverse par hasard. Garde-fou anti faux-positif.
 */
const NON_LEGAL_DOMAINS = [
  // Sport
  "football", "foot", "soccer", "basket", "tennis", "rugby", "cyclisme",
  "natation", "athlétisme", "athletisme", "olympique", "olympiques",
  "coupe du monde", "ligue des champions", "euro", "champions league",
  "joueur", "joueurs", "équipe", "equipe", "club", "stade",
  "ronaldo", "messi", "mbappé", "mbappe", "zidane", "ribery",
  // Géographie / monuments / culture
  "monument", "capitale", "continent", "montagne", "fleuve", "océan", "ocean",
  "tour eiffel", "statue de la liberté", "colisée", "colisee", "pyramide",
  // Sciences
  "photosynthèse", "photosynthese", "gravité", "gravite", "évolution", "evolution",
  "astronomie", "étoile", "etoile", "planète", "planete", "galaxie",
  // Cuisine
  "recette", "plat", "cuisine", "ingrédient", "ingredient",
  // Média / culture pop
  "film", "acteur", "actrice", "réalisateur", "realisateur", "chanteur", "chanteuse",
  "musique", "album", "chanson", "romancier", "romancière", "romanciere",
  // Météo
  "météo", "meteo", "température", "temperature", "climat",
];

/**
 * Détection juridique. Retourne :
 *   - "legal" si la question relève clairement du droit
 *   - "general" si elle relève clairement du mode général
 *   - "ambiguous" sinon (fallback : on choisira "general" pour ne pas forcer
 *     les six blocs sur des questions où ils ne servent pas)
 */
export type DetectionMode = "legal" | "general" | "ambiguous";

export function detectMode(question: string): DetectionMode {
  if (!question || question.trim().length < 3) return "general";

  const q = question.toLowerCase().normalize("NFC");

  // 0. GARDE-FOU : domaine clairement non juridique → general d'office
  // Même si un mot juridique traverse par hasard.
  for (const dom of NON_LEGAL_DOMAINS) {
    if (q.includes(dom)) return "general";
  }

  // 1. Mots-clés généraux forts en début ou dans la phrase → general
  for (const kw of STRONG_GENERAL_KEYWORDS) {
    if (q.includes(kw)) {
      // Mais si en plus il y a un mot-clé juridique fort, on penche legal
      // (ex : "rédige une assignation" = legal malgré "rédige")
      const hasStrongLegal = STRONG_LEGAL_KEYWORDS.some((lk) => q.includes(lk));
      if (!hasStrongLegal) return "general";
    }
  }

  // 2. Mots-clés juridiques forts → legal
  for (const kw of STRONG_LEGAL_KEYWORDS) {
    if (q.includes(kw)) return "legal";
  }

  // 3. Plusieurs mots-clés juridiques faibles → legal
  let weakCount = 0;
  for (const kw of WEAK_LEGAL_KEYWORDS) {
    if (q.includes(kw)) weakCount++;
    if (weakCount >= 2) return "legal";
  }

  // 4. Patterns spécifiques : "j'ai un problème avec...", "mes droits sur..."
  if (/mes droits|mon droit|ai-je le droit|a-t-il le droit|a-t-elle le droit/i.test(q)) {
    return "legal";
  }
  if (/j'ai un (problème|probleme|litige|conflit|différend|differend) (avec|contre|à propos|a propos)/i.test(q)) {
    return "legal";
  }
  if (/recours|poursuivre|porter plainte|déposer plainte|deposer plainte/i.test(q)) {
    return "legal";
  }

  // 5. Une seule occurrence faible → ambiguous (on traitera en général)
  if (weakCount === 1) return "ambiguous";

  // 6. Aucun signal juridique → general
  return "general";
}

/**
 * Convertit le mode détecté en endpoint à appeler.
 * - "legal"               → /api/chat/v2/message
 * - "general", "ambiguous" → /api/chat/message (mode général multimodal)
 */
export function endpointForMode(mode: DetectionMode): "v2" | "general" {
  return mode === "legal" ? "v2" : "general";
}
