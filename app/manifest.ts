import type { MetadataRoute } from "next";

// Lets a phone install ICEPik to its home screen. The colour is --surface
// (#1a1e22), the same as the viewport's theme-color in layout.tsx. The icons
// come from scripts/render-icons.mjs.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ICEPik",
    short_name: "ICEPik",
    description: "Report and verify ICE sightings in real time.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#1a1e22",
    background_color: "#1a1e22",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
