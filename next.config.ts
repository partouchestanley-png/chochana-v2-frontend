import type { NextConfig } from "next";

/**
 * chat-frontend — frontend totalement séparé du frontend PRIMUM FACTI principal.
 *
 * שושנה ז״ל
 *
 * Aucun import depuis ../frontend/. Aucune dépendance partagée.
 * Déploiement Vercel séparé sur sous-domaine chat.primum-facti.com.
 */
const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  images: { unoptimized: true },
  // Force le navigateur à récupérer le HTML root à chaque chargement.
  // Sans ça, Safari iOS peut servir un vieux bundle de plusieurs heures et
  // le frontend exécute du code obsolète (problème identifié le 6 mai).
  // Les bundles JS hashés restent cachables (le hash change à chaque build).
  async headers() {
    return [
      {
        source: "/",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, proxy-revalidate",
          },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
      {
        source: "/index",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, proxy-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
