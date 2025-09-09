// src/pii/pii.ts
// Local, deterministic PII redaction with an extra "layout-heading name detector" layer.
// Dependencies: pdfjs-dist (pure JS). No native addons.

import * as path from "node:path";
import { promises as fs } from "node:fs";
// Lazy-load pdfjs so we only pay the cost when redacting PDFs.
async function loadPdfJs(): Promise<PdfjsLike> {
  // Resolve via package.json dependency (node_modules) to satisfy lint rules.
  const mod = await import("pdfjs-dist");
  return mod as unknown as PdfjsLike;
}

// Minimal PDF.js typings for the subset we use
type PdfPage = {
  getTextContent(): Promise<{ items: Array<{ str: string }> }>;
  getViewport(opts: { scale: number }): { width: number };
};
type PdfDocument = {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
};
type PdfLoadingTask = { promise: Promise<PdfDocument> };
type PdfjsLike = { getDocument: (src: { data: Uint8Array } | { url: string }) => PdfLoadingTask };

/* ----------------------------- Types & Config ----------------------------- */

export type RedactionMode = "hash" | "mask" | "drop";
export type Kind =
  | "email"
  | "phone"
  | "url"
  | "linkedin"
  | "github"
  | "address"
  | "id"
  | "name"
  | "org"
  | "loc";
export type Span = {
  start: number;
  end: number;
  value: string;
  kind: Kind;
  source?: "regex" | "ner" | "flagger" | "layout";
  score?: number;
};
export type RedactionConfig = Partial<Record<Kind, RedactionMode>>;

export interface LLMFlagger {
  name(): string;
  flag(text: string): Promise<Array<{ start: number; end: number; label: Kind; score?: number }>>;
}

export interface Options {
  outBase?: string;
  modes?: RedactionConfig;
  useNER?: boolean; // kept for API parity; not used here
  flagger?: LLMFlagger | null; // optional extra safety net
  previewLimit?: number;
  detectNameFromLayout?: boolean; // NEW: enable heading-based name detection (PDF only)
}

export interface Result {
  redactedText: string;
  fileHashSha256: string;
  hits: Span[];
  counts: Record<string, number>;
  outRedactedPath?: string;
  outReportPath?: string;
}

/* ------------------------------- Utilities -------------------------------- */

function normalizeText(input: string): string {
  let s = input.normalize("NFKC");
  s = s.replace(/\s*\(at\)\s*/gi, "@").replace(/\s*\[at\]\s*/gi, "@");
  s = s.replace(/\s*\(dot\)\s*/gi, ".").replace(/\s*\[dot\]\s*/gi, ".");
  s = s.replace(/[ \t]+/g, " ").replace(/\r/g, "");
  return s;
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeTag(kind: Kind, value: string): Promise<string> {
  const h = (await sha256Hex(value)).slice(0, 8);
  return `[[${kind.toUpperCase()}:${h}]]`;
}

/* --------------------------- PDF text + layout ---------------------------- */

type PdfItem = { str: string; transform: number[]; fontName?: string };
type LayoutLine = {
  text: string;
  y: number;
  x: number;
  width: number;
  maxFont: number;
  avgFont: number;
  centered: boolean;
  bold: boolean;
  tokenCount: number;
  hasDigits: boolean;
  hasEmailOrPhone: boolean;
  score?: number;
};

function fontSizeFromTransform(t: number[]) {
  const sx = Math.hypot(t[0], t[1]);
  const sy = Math.hypot(t[2], t[3]);
  return Math.max(sx, sy);
}
function isBoldFontName(name: string) {
  const n = name?.toLowerCase?.() ?? "";
  return n.includes("bold") || n.includes("semibold") || n.includes("demi") || n.includes("black");
}
function looksLikeHeader(s: string) {
  const h = s.trim().toLowerCase();
  const headers = [
    "resume",
    "curriculum vitae",
    "cv",
    "summary",
    "experience",
    "work experience",
    "education",
    "skills",
    "projects",
    "certifications",
    "publications",
    "contact",
    "profile",
    "objective",
  ];
  return headers.some((w) => h === w || h.startsWith(w + " "));
}
const emailRe = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const phoneRe = /\+?[0-9][0-9()\s.-]{5,}/;

async function pdfExtractWithLayout(pdfPath: string): Promise<{
  text: string;
  firstPageLines: LayoutLine[];
  viewportWidth: number;
}> {
  // Read as Uint8Array
  const data: Uint8Array = await fs.readFile(pdfPath);

  // Pass Uint8Array to PDF.js (loaded on demand)
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data }).promise;

  // Build full text across pages (simple concat)
  let fullText = "";
  const numPages: number = doc.numPages;
  for (let i = 1; i <= numPages; i++) {
    const p = await doc.getPage(i);
    const c = await p.getTextContent();
    const items = (c.items || []) as Array<{ str: string }>;
    fullText += items.map((it) => it.str).join(" ") + "\n";
  }

  // Only need page 1 layout lines for name detection
  const page1 = await doc.getPage(1);
  const viewport = page1.getViewport({ scale: 1.0 });
  const content1 = await page1.getTextContent();
  const items1 = (content1.items || []) as PdfItem[];

  // Group first-page items into lines by baseline y
  const byY: Record<
    string,
    { str: string; x: number; y: number; fs: number; fontName?: string }[]
  > = {};
  for (const it of items1) {
    if (!it.str || !it.transform) continue;
    const t = it.transform;
    const y = t[5];
    const x = t[4];
    const fs = fontSizeFromTransform(t);
    const ky = String(Math.round(y));
    (byY[ky] ??= []).push({ str: it.str, x, y, fs, fontName: it.fontName });
  }

  const lines: LayoutLine[] = [];
  const keys = Object.keys(byY).map(Number).sort((a, b) => b - a); // top->bottom (higher y first)
  for (const ky of keys) {
    const runs = byY[ky].sort((a, b) => a.x - b.x);
    const text = runs.map((r) => r.str).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const maxFont = Math.max(...runs.map((r) => r.fs));
    const avgFont = runs.reduce((s, r) => s + r.fs, 0) / runs.length;
    const xMin = runs[0].x, xMax = runs[runs.length - 1].x;
    const width = Math.max(0, xMax - xMin);
    const pageCenter = viewport.width / 2;
    const lineCenter = xMin + width / 2;
    const centered = Math.abs(lineCenter - pageCenter) < viewport.width * 0.15;
    const bold = runs.some((r) => (r.fontName && isBoldFontName(r.fontName)) || false);
    const tokenCount = text.trim().split(/\s+/).filter(Boolean).length;
    const hasDigits = /\d/.test(text);
    const hasEmailOrPhone = emailRe.test(text) || phoneRe.test(text);
    lines.push({
      text,
      y: ky,
      x: xMin,
      width,
      maxFont,
      avgFont,
      centered,
      bold,
      tokenCount,
      hasDigits,
      hasEmailOrPhone,
    });
  }

  return { text: fullText, firstPageLines: lines, viewportWidth: viewport.width };
}

function chooseNameCandidate(
  firstPageLines: LayoutLine[],
  _viewportWidth: number,
): LayoutLine | null {
  if (!firstPageLines.length) return null;
  const topY = Math.max(...firstPageLines.map((l) => l.y));
  const bottomY = Math.min(...firstPageLines.map((l) => l.y));
  const meanF = firstPageLines.reduce((s, l) => s + l.maxFont, 0) / firstPageLines.length;
  const stdF = Math.sqrt(
    firstPageLines.reduce((s, l) => s + Math.pow(l.maxFont - meanF, 2), 0) /
      Math.max(1, firstPageLines.length),
  );
  const z = (f: number) => (stdF > 0 ? (f - meanF) / stdF : 0);

  const candidates = firstPageLines
    .filter((l) => l.tokenCount >= 1 && l.tokenCount <= 5)
    .filter((l) => !l.hasDigits && !l.hasEmailOrPhone)
    .filter((l) => !looksLikeHeader(l.text))
    .map((l) => {
      const yTopPct = (topY - l.y) / (topY - bottomY + 1e-6); // 0 at very top, 1 at bottom
      const allCaps = /^[\p{L}\s'.-]+$/u.test(l.text) && l.text === l.text.toUpperCase();
      let score = 2.5 * z(l.maxFont) + (l.centered ? 1.2 : 0) + (l.bold ? 0.6 : 0) - 1.0 * yTopPct;
      if (l.tokenCount >= 2 && l.tokenCount <= 4) score += 0.4;
      if (allCaps) score -= 0.2;
      return { ...l, score };
    })
    .sort((a, b) => (b.score! - a.score!));

  return candidates[0] ?? null;
}

// Find a line (candidate name) inside normalized text; tolerant to whitespace/case.
function locateCandidateInNormalized(
  normalizedText: string,
  candidateRaw: string,
): { start: number; end: number } | null {
  const candNorm = normalizeText(candidateRaw);
  const pattern = candNorm.trim().split(/\s+/).map(escapeRegex).join("\\s+");
  const re = new RegExp(pattern, "i");
  const m = re.exec(normalizedText);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

/* ------------------------------- Regex layer ------------------------------ */

const R = {
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  phone: /\+?[0-9]{1,3}[\s-]?\(?[0-9]{2,4}\)?[\s-]?[0-9]{3,4}\b/g,
  url: /\bhttps?:\/\/[^\s)]+/gi,
  linkedin: /\blinkedin\.com\/in\/[A-Za-z0-9._-]+/gi,
  github: /\bgithub\.com\/[A-Za-z0-9._-]+/gi,
  address: /\b\d{1,5}\s+[A-Za-z][A-Za-z\s.]+(?:Ave|Avenue|St|Street|Rd|Road|Blvd|Drive|Dr)\b/gi,
  id: /\b(?:SSN|SIN|NIN|PAN|AADHAAR)[:\s#-]?[A-Z0-9-]{4,}\b/gi,
};

function findRegexSpans(t: string): Span[] {
  const out: Span[] = [];
  const scan = (kind: Kind, re: RegExp) => {
    for (const m of t.matchAll(re)) {
      out.push({
        start: m.index!,
        end: m.index! + m[0].length,
        value: m[0],
        kind,
        source: "regex",
      });
    }
  };
  scan("email", R.email);
  scan("phone", R.phone);
  scan("url", R.url);
  scan("linkedin", R.linkedin);
  scan("github", R.github);
  scan("address", R.address);
  scan("id", R.id);
  return out.sort((a, b) => a.start - b.start);
}

/* ---------------------------- Redaction engine ---------------------------- */

const defaultModes: RedactionConfig = {
  email: "hash",
  phone: "hash",
  url: "hash",
  linkedin: "hash",
  github: "hash",
  address: "mask",
  id: "drop",
  name: "mask", // redact name by default
  org: "mask",
  loc: "mask",
};

function mergeAndDedupe(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of spans) {
    const top = out[out.length - 1];
    if (!top || s.start >= top.end) {
      out.push(s);
      continue;
    }
    const topLen = top.end - top.start;
    const sLen = s.end - s.start;
    const priorityMap: Record<string, number> = { regex: 3, flagger: 2, layout: 2, ner: 1 };
    const priority = (src?: string) => priorityMap[src ?? ""] ?? 0;
    const preferS = sLen < topLen || priority(s.source) > priority(top.source);
    if (preferS) out[out.length - 1] = s;
  }
  return out;
}

async function applyRedaction(
  text: string,
  spans: Span[],
  modes: RedactionConfig,
): Promise<{ redacted: string }> {
  let out = "";
  let last = 0;
  for (const s of spans) {
    out += text.slice(last, s.start);
    const m = modes[s.kind] ?? defaultModes[s.kind] ?? "hash";
    if (m === "drop") {
      // omit
    } else if (m === "mask") {
      out += "*".repeat(s.end - s.start);
    } else {
      out += await makeTag(s.kind, s.value);
    }
    last = s.end;
  }
  out += text.slice(last);
  return { redacted: out };
}

/* ------------------------------- Main API -------------------------------- */

export async function redactResumeFile(filePath: string, opts: Options = {}): Promise<Result> {
  const outBase = opts.outBase ?? filePath.replace(/\.[^.]+$/, "");
  const detectName = opts.detectNameFromLayout !== false; // default ON

  const ext = path.extname(filePath).toLowerCase();

  // 1) Extract text (PDF uses layout-aware fetch; TXT is direct)
  let rawText = "";
  let layoutCandidate: LayoutLine | null = null;
  if (ext === ".pdf") {
    const { text, firstPageLines, viewportWidth } = await pdfExtractWithLayout(filePath);
    rawText = text;
    if (detectName) {
      layoutCandidate = chooseNameCandidate(firstPageLines, viewportWidth);
    }
  } else {
  // ✅ Read using Node fs for UTF-8 string
  rawText = await fs.readFile(filePath, { encoding: "utf8" });
  }

  // 2) Normalize
  const normalized = normalizeText(rawText);

  // 3) Regex layer
  let spans: Span[] = findRegexSpans(normalized);

  // 4) NEW: Inject name span from layout (PDF heading) if we found a candidate
  if (layoutCandidate && layoutCandidate.text) {
    const loc = locateCandidateInNormalized(normalized, layoutCandidate.text);
    if (loc) {
      spans.push({
        start: loc.start,
        end: loc.end,
        value: normalized.slice(loc.start, loc.end),
        kind: "name",
        source: "layout",
        score: layoutCandidate.score,
      });
    }
  }

  // 5) Optional LLM flagger (e.g., Ollama) to add suspicious spans
  if (opts.flagger) {
    try {
      const flagged = await opts.flagger.flag(normalized);
      for (const f of flagged || []) {
        const start = Math.max(0, Math.min(normalized.length, f.start));
        const end = Math.max(start, Math.min(normalized.length, f.end));
        if (end > start) {
          spans.push({
            start,
            end,
            value: normalized.slice(start, end),
            kind: f.label,
            source: "flagger",
            score: f.score,
          });
        }
      }
    } catch {
      // fail-open; just skip flagger results
    }
  }

  // 6) Merge/dedupe and redact
  spans = mergeAndDedupe(spans);
  const modes = { ...defaultModes, ...(opts.modes || {}) };
  const { redacted } = await applyRedaction(normalized, spans, modes);

  // 7) Outputs + report
  const counts: Record<string, number> = {};
  for (const s of spans) counts[s.kind] = (counts[s.kind] || 0) + 1;

  const fileHashSha256 = await sha256Hex(rawText);
  const outRedactedPath = `${outBase}.redacted.txt`;
  const outReportPath = `${outBase}.pii.report.json`;

  await fs.writeFile(outRedactedPath, redacted, { encoding: "utf8" });
  await fs.writeFile(
    outReportPath,
    JSON.stringify(
      {
        counts,
        file_hash_sha256: fileHashSha256,
        modes,
        total_spans: spans.length,
        layout_name_candidate: layoutCandidate
          ? {
            text: layoutCandidate.text,
            score: layoutCandidate.score,
            y: layoutCandidate.y,
            maxFont: layoutCandidate.maxFont,
            centered: layoutCandidate.centered,
            bold: layoutCandidate.bold,
          }
          : null,
        preview: spans.slice(0, opts.previewLimit ?? 12),
      },
      null,
      2,
    ),
    { encoding: "utf8" },
  );

  return {
    redactedText: redacted,
    fileHashSha256,
    hits: spans,
    counts,
    outRedactedPath,
    outReportPath,
  };
}
