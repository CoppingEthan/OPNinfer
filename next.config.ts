import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Normally `.next`. The override exists so a SECOND dev server — the
  // operator console, which is this same app with OPNINFER_MODE=console — can
  // run beside the portal one without the two overwriting each other's
  // webpack chunks (the documented "500 on every route" failure). Unset in
  // every build and deploy, so this is a no-op there.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Native/dynamic-require packages webpack shouldn't bundle — leave them as
  // runtime requires. `archiver` (backup zipping) uses Node built-ins + dynamic
  // requires; `sharp` (vision image downscaling) and `better-sqlite3` (OWUI
  // migration import) are native addons.
  // `@anthropic-ai/claude-agent-sdk` spawns a native CLI binary that ships in
  // a platform package it resolves BY NAME at runtime — keep it a runtime
  // require, and see outputFileTracingIncludes below.
  serverExternalPackages: ["archiver", "sharp", "better-sqlite3", "@anthropic-ai/claude-agent-sdk"],
  // The standalone build ships only what the tracer can follow from imports.
  // The Agent SDK's Claude Code CLI is a native binary in
  // `@anthropic-ai/claude-agent-sdk-<platform>` (linux-x64 on the servers),
  // resolved by name at runtime, so the tracer never copies it and the SDK
  // refuses to start ("Claude Code executable not found") — the Sandbox
  // passed every dev harness and failed on its first production chat with
  // "missing CLI binary" (2026-09-02). Pinned by standalone-trace.test.ts.
  //
  // The glob ends `sdk@*`, NOT `sdk*` (2026-09-05): the looser form also
  // matched the platform package's OWN store directory
  // (`@anthropic-ai+claude-agent-sdk-linux-x64@<version>`), and since the
  // tracer dereferences pnpm's symlinks it copied the 327 MB binary TWICE —
  // once inside the SDK's store directory and once as the standalone entry —
  // for ~0.7 GB of app image. `sdk@*` keeps only the SDK's own directory,
  // which is where node resolves the platform package from at runtime (it
  // walks up to the sibling `node_modules/@anthropic-ai/` scope), so the
  // copy that is actually used survives and the duplicate goes.
  // Same class of problem for the PDF viewer: /api/pdfjs reads the worker,
  // the character maps and the standard-font metrics out of node_modules at
  // RUNTIME, so nothing imports them and the tracer ships none of them. In dev
  // that is invisible; in production every document would fail to open.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@*/**",
      "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
      "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/standard_fonts/**",
      "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/package.json",
    ],
  },
  experimental: {
    // When middleware runs on a route, Next clones the request body to replay
    // it downstream, capping the clone at 10 MB by DEFAULT and SILENTLY
    // TRUNCATING beyond that (busboy then throws "Unexpected end of form").
    // Our middleware matches the upload routes (/api/files, /api/avatar,
    // /api/stt, /api/admin/backup/restore), so this cap must stay ABOVE the
    // admin's max-upload limit (setting `max_upload_bytes`, default 50 MB via
    // OPNINFER_MAX_UPLOAD_BYTES, ceiling 2 GB) or large uploads truncate.
    // 256 MB gives headroom; raise both together if an admin ever needs a
    // bigger max upload.
    middlewareClientMaxBodySize: 256 * 1024 * 1024,
  },
  // Allow the dev server to be reached from other devices on the LAN (spec:
  // testing from an external machine). Add your host's LAN IPs here.
  allowedDevOrigins: ["10.0.1.201", "10.0.1.202", "10.8.0.2"],
  // Self-contained server bundle for a small production Docker image. Gated on
  // an env flag (set in the Dockerfile) because the standalone trace-copy uses
  // symlinks that fail under unprivileged Windows local builds.
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
