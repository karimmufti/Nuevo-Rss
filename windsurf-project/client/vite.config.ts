/**
 * WHAT: Vite configuration file — tells the Vite build tool how to run our React app.
 * WHY:  Vite needs to know we're using React so it can handle JSX/TSX files.
 *       This is the minimal config needed — just the React plugin.
 * HOW:  Vite reads this file automatically when you run `npm run dev` in the client folder.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  // Plugins extend Vite's capabilities. The React plugin adds:
  // - Fast Refresh (hot module replacement for React components)
  // - JSX/TSX transformation (converts JSX syntax into JavaScript)
  plugins: [react()],

  // Allow the client to import shared code from the workspace root.
  // We keep the source-of-truth Article type in ../shared so the client and server
  // both compile against the exact same interface.
  server: {
    fs: {
      allow: [".."],
    },
  },
});
