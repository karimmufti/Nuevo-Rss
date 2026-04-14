/**
 * WHAT: React entry point — the very first JavaScript that runs for our UI.
 * WHY:  React needs to be told WHERE in the HTML to render (the #root div) and WHAT to render
 *       (our App component). This file does exactly that — nothing more.
 * HOW:  Vite loads this file via the <script> tag in index.html. It grabs the #root div,
 *       creates a React root, and renders our <App /> component inside it.
 */

// React is the UI library. ReactDOM is the bridge between React and the browser's DOM.
// They're separate packages because React can also render to other targets (mobile, terminal, etc.).
import React from "react";
import ReactDOM from "react-dom/client";

// Our main application component — this is where all the UI lives.
import App from "./App";

// document.getElementById("root") finds the <div id="root"> in index.html.
// The "!" at the end is TypeScript's non-null assertion — we're telling TypeScript
// "I guarantee this element exists, don't warn me about it being null."
// ReactDOM.createRoot() creates a React rendering root attached to that div.
// .render() tells React to draw our <App /> component inside it.
ReactDOM.createRoot(document.getElementById("root")!).render(
  // React.StrictMode is a development-only wrapper that enables extra checks:
  // - Warns about deprecated APIs
  // - Detects side effects by intentionally double-rendering components
  // It doesn't affect the production build at all.
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
