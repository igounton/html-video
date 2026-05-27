/**
 * HTTP server for the project studio (RFC-05 §UI).
 * Serves @html-video/project-studio static UI + project / template REST APIs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { CliContext } from './context.js';
import { AssetStore } from '@html-video/core';
import { detectAll, findAgent, spawnAgent } from '@html-video/runtime';

interface StudioHandle {
  url: string;
  port: number;
  close: () => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveUiRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'project-studio', 'public'),
    resolve(here, '..', 'public'),
    resolve(here, '..', '..', 'storyboard-ui', 'public'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0]!;
}

export async function startStudioServer(ctx: CliContext, port: number): Promise<StudioHandle> {
  const uiRoot = resolveUiRoot();

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://x');
      const m = req.method ?? 'GET';

      // ============== API ==============

      // List projects
      if (url.pathname === '/api/projects' && m === 'GET') {
        const list = await ctx.orchestrator.list();
        return json(res, 200, { projects: list });
      }

      // Create project
      if (url.pathname === '/api/projects' && m === 'POST') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.create({
          name: (body.name as string) ?? 'Untitled',
          ...(body.intent !== undefined && { intent: body.intent as string }),
          preferences: (body.preferences as Record<string, unknown>) ?? {},
        });
        return json(res, 200, { project });
      }

      // Get / update / delete single project
      const projMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch && projMatch[1]) {
        const id = projMatch[1];
        if (m === 'GET') {
          return json(res, 200, { project: await ctx.orchestrator.load(id) });
        }
        if (m === 'DELETE') {
          await ctx.orchestrator.remove(id);
          return json(res, 200, { ok: true });
        }
      }

      // List engines + templates
      if (url.pathname === '/api/templates' && m === 'GET') {
        return json(res, 200, {
          templates: ctx.templates.list().map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            engine: t.engine,
            category: t.category,
            tags: t.tags,
            best_for: t.best_for,
            inputs_schema: t.inputs.schema,
            inputs_examples: t.inputs.examples,
            license: t.license,
            preview: t.preview,
            output: t.output,
          })),
        });
      }

      // Add asset (multipart-style via JSON for v0.1: paths or inline content)
      const addAssetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets$/);
      if (addAssetMatch && addAssetMatch[1] && m === 'POST') {
        const id = addAssetMatch[1];
        const ct = req.headers['content-type'] ?? '';
        let project;
        if (ct.startsWith('multipart/form-data')) {
          // Save uploaded file to /tmp then add
          const saved = await receiveMultipartFile(req, ct);
          project = await ctx.orchestrator.addFileAsset(id, saved.filePath);
        } else {
          const body = await readBody(req);
          if (body.kind === 'text') {
            project = await ctx.orchestrator.addInlineAsset(
              id,
              (body.content as string) ?? '',
              'text',
              body.caption as string | undefined,
            );
          } else if (body.kind === 'data') {
            project = await ctx.orchestrator.addInlineAsset(
              id,
              (body.content as string) ?? '',
              'data',
              body.caption as string | undefined,
            );
          } else if (body.kind === 'file' && body.path) {
            project = await ctx.orchestrator.addFileAsset(id, body.path as string);
          } else {
            return json(res, 400, { error: 'Provide kind=text|data|file with content/path' });
          }
        }
        return json(res, 200, { project });
      }

      // Remove asset
      const rmAssetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/);
      if (rmAssetMatch && rmAssetMatch[1] && rmAssetMatch[2] && m === 'DELETE') {
        const project = await ctx.orchestrator.removeAsset(rmAssetMatch[1], rmAssetMatch[2]);
        return json(res, 200, { project });
      }

      // Set template
      const tplMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/template$/);
      if (tplMatch && tplMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setTemplate(tplMatch[1], body.template_id as string);
        // Auto-seed preview with the template's own example.html so the user sees
        // something immediately (before any chat-driven rewrite).
        const tmpl = ctx.templates.get(body.template_id as string);
        const exampleHtmlPath = join(tmpl.__dir!, tmpl.source_entry);
        if (existsSync(exampleHtmlPath)) {
          const html = await readFile(exampleHtmlPath, 'utf8');
          await ctx.orchestrator.writePreviewHtmlRaw(project.id, html);
        }
        return json(res, 200, { project: await ctx.orchestrator.load(project.id) });
      }

      // Set agent (runtime selection)
      const agentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/agent$/);
      if (agentMatch && agentMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setAgent(
          agentMatch[1],
          (body.agent_id as string) || null,
        );
        return json(res, 200, { project });
      }

      // Set variables (whole bag)
      const varsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/variables$/);
      if (varsMatch && varsMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setVariables(
          varsMatch[1],
          (body.variables as Record<string, unknown>) ?? {},
        );
        return json(res, 200, { project });
      }

      // Render preview HTML (legacy; v0.3+ uses chat-driven path)
      const prevMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/preview$/);
      if (prevMatch && prevMatch[1] && m === 'POST') {
        const { project, htmlPath } = await ctx.orchestrator.renderPreviewHtml(prevMatch[1]);
        return json(res, 200, {
          project,
          preview_url: `/preview/${project.id}`,
          html_path: htmlPath,
        });
      }

      // Get raw preview HTML (frontend reads to parse data-hv-text nodes)
      const rawGetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/raw-html$/);
      if (rawGetMatch && rawGetMatch[1] && m === 'GET') {
        const project = await ctx.orchestrator.load(rawGetMatch[1]);
        if (!project.lastPreviewHtmlPath || !existsSync(project.lastPreviewHtmlPath)) {
          return json(res, 404, { error: 'No preview HTML yet — pick a template or send a chat first' });
        }
        const html = await readFile(project.lastPreviewHtmlPath, 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(html);
        return;
      }

      // Write raw preview HTML (frontend posts back the modified HTML
      // after the user edits a data-hv-text field in the middle column)
      if (rawGetMatch && rawGetMatch[1] && m === 'PUT') {
        const project = await ctx.orchestrator.load(rawGetMatch[1]);
        const ct = req.headers['content-type'] ?? '';
        let html: string;
        if (ct.includes('application/json')) {
          const body = await readBody(req);
          html = (body.html as string) ?? '';
        } else {
          html = await readBodyText(req);
        }
        if (!html || !/<\/html>/i.test(html)) {
          return json(res, 400, { error: 'Body must be a complete HTML document' });
        }
        await ctx.orchestrator.writePreviewHtmlRaw(project.id, html);
        return json(res, 200, { project: await ctx.orchestrator.load(project.id) });
      }

      // Export MP4
      const expMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
      if (expMatch && expMatch[1] && m === 'POST') {
        const { project, outputPath } = await ctx.orchestrator.exportMp4({
          projectId: expMatch[1],
        });
        return json(res, 200, { project, output_path: outputPath });
      }

      // Agents (detected on each call; cheap)
      if (url.pathname === '/api/agents' && m === 'GET') {
        const agents = await detectAll();
        return json(res, 200, { agents });
      }

      // Messages: GET history (in-memory only v0.2)
      const msgsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/messages$/);
      if (msgsMatch && msgsMatch[1] && m === 'GET') {
        const arr = MESSAGES.get(msgsMatch[1]) ?? [];
        return json(res, 200, { messages: arr });
      }

      // Messages: POST = send + stream agent reply via SSE
      // v0.5: accepts multipart (text + files) OR JSON. Files become real
      // project assets via AssetStore; their paths are passed to the agent
      // prompt as attachments.
      if (msgsMatch && msgsMatch[1] && m === 'POST') {
        const id = msgsMatch[1];
        const ct = req.headers['content-type'] ?? '';
        let userText = '';
        const attachments: Attachment[] = [];

        const project0 = await ctx.orchestrator.load(id);
        if (ct.startsWith('multipart/form-data')) {
          const parts = await receiveMultipart(req, ct);
          for (const p of parts) {
            if (p.kind === 'field' && p.name === 'content') {
              userText = p.value;
            } else if (p.kind === 'file') {
              const updatedProject = await ctx.orchestrator.addFileAsset(id, p.tmpPath);
              const newAsset = updatedProject.assets[updatedProject.assets.length - 1];
              if (newAsset) {
                attachments.push({
                  path: newAsset.path ?? p.tmpPath,
                  kind: newAsset.type as Attachment['kind'],
                  filename: p.filename,
                  size: newAsset.metadata.sizeBytes ?? 0,
                });
              }
            }
          }
        } else {
          const body = await readBody(req);
          userText = (body.content as string) ?? '';
        }

        if (!userText && attachments.length === 0) {
          return json(res, 400, { error: 'content or attachments required' });
        }

        // Re-fetch project after potential addFileAsset side-effects
        const project = await ctx.orchestrator.load(id);
        const tmpl = project.templateId ? ctx.templates.get(project.templateId) : null;
        if (!tmpl) {
          return json(res, 400, { error: 'pick a template first' });
        }

        const agentId = project.agentId ?? 'claude';
        const agentDef = findAgent(agentId);
        if (!agentDef) {
          return json(res, 400, { error: `agent "${agentId}" not registered` });
        }

        // Append user message to history (with attachment summary)
        const attachmentSummary = attachments.length > 0
          ? `\n\n📎 ${attachments.length} attachment(s): ${attachments.map((a) => a.filename).join(', ')}`
          : '';
        const history = MESSAGES.get(id) ?? [];
        history.push({
          role: 'user',
          content: userText + attachmentSummary,
          ts: Date.now(),
        });
        MESSAGES.set(id, history);

        // Compose prompt
        const exampleHtmlPath = join(tmpl.__dir!, tmpl.source_entry);
        const exampleHtml = existsSync(exampleHtmlPath)
          ? await readFile(exampleHtmlPath, 'utf8')
          : '';
        const projectDir = await ctx.projects.ensureDir(id);
        const priorHtmlPath = join(projectDir, 'preview.html');
        const priorHtml = existsSync(priorHtmlPath)
          ? await readFile(priorHtmlPath, 'utf8')
          : '';

        const fullPrompt = buildHtmlGenerationPrompt({
          tmpl,
          exampleHtml,
          priorHtml,
          history,
          userText,
          attachments,
        });

        // SSE response
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        let assistantText = '';
        const handle = spawnAgent({
          def: agentDef,
          prompt: fullPrompt,
          context: { cwd: projectDir },
          onEvent: (ev) => {
            if (ev.type === 'text') {
              assistantText += ev.chunk;
              res.write(`data: ${JSON.stringify(ev)}\n\n`);
            } else if (ev.type === 'error' || ev.type === 'message_end') {
              res.write(`data: ${JSON.stringify(ev)}\n\n`);
            }
          },
        });
        await handle.done;

        // Extract HTML if present; otherwise leave preview alone (chat-only turn)
        const extracted = extractHtmlDocument(assistantText);
        if (extracted) {
          await ctx.orchestrator.writePreviewHtmlRaw(id, extracted);
          res.write(`data: ${JSON.stringify({ type: 'preview_ready', preview_url: `/preview/${id}` })}\n\n`);
        }

        // Persist assistant message — strip the html block when present (UI sees summary line)
        const persistText = extracted
          ? assistantText.replace(/```html[\s\S]*?```/i, '✓ updated the HTML preview').trim() || '✓ updated the HTML preview'
          : assistantText;
        history.push({
          role: 'assistant',
          agent: agentDef.id,
          content: persistText,
          ts: Date.now(),
        });
        MESSAGES.set(id, history);
        // discard project0 reference to keep TS happy
        void project0;
        res.end();
        return;
      }

      // ============== File serving ==============

      // Project preview HTML (and any sibling files like assets/)
      const previewServeMatch = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (previewServeMatch && previewServeMatch[1]) {
        const projId = previewServeMatch[1];
        const sub = previewServeMatch[2] ?? '/preview.html';
        const project = await ctx.orchestrator.load(projId);
        const baseDir = project.lastPreviewHtmlPath
          ? dirname(project.lastPreviewHtmlPath)
          : null;
        if (!baseDir) {
          res.writeHead(404);
          return res.end('Preview not rendered yet');
        }
        const filePath = sub === '/preview.html' || sub === '/'
          ? project.lastPreviewHtmlPath!
          : join(baseDir, sub);
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          return serveFile(filePath, res);
        }
        // Fallback: also try project assets/
        const projAssets = join(dirname(baseDir), 'assets', basename(sub));
        if (existsSync(projAssets)) return serveFile(projAssets, res);
        res.writeHead(404);
        return res.end('Not found');
      }

      // Asset direct serve (so iframe can load image_path etc)
      // /asset?path=<absolute-path>  — must be inside .html-video/projects
      if (url.pathname === '/asset' && m === 'GET') {
        const p = url.searchParams.get('path');
        if (!p) {
          res.writeHead(400);
          return res.end('missing ?path');
        }
        const safe = resolve(p);
        if (!safe.includes('/.html-video/projects/')) {
          res.writeHead(403);
          return res.end('forbidden');
        }
        if (existsSync(safe)) return serveFile(safe, res);
        res.writeHead(404);
        return res.end();
      }

      // Template poster (e.g. /template-asset/<id>/preview.png)
      const tplAssetMatch = url.pathname.match(/^\/template-asset\/([^/]+)\/(.+)$/);
      if (tplAssetMatch && tplAssetMatch[1] && tplAssetMatch[2]) {
        const t = ctx.templates.get(tplAssetMatch[1]);
        const filePath = join(t.__dir!, tplAssetMatch[2]);
        if (existsSync(filePath)) return serveFile(filePath, res);
        res.writeHead(404);
        return res.end();
      }

      // ============== Static UI ==============
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = join(uiRoot, path);
      if (filePath.startsWith(uiRoot) && existsSync(filePath) && statSync(filePath).isFile()) {
        return serveFile(filePath, res);
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string }).code ?? 'unknown';
      json(res, 500, { error: msg, code });
    }
  });

  return new Promise((resolveFn) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolveFn({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': MIME['.json']! });
  res.end(JSON.stringify(body));
}

async function serveFile(filePath: string, res: ServerResponse): Promise<void> {
  const ext = extname(filePath).toLowerCase();
  const buf = await readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // Studio is a local dev tool — always serve fresh so v0.x updates show
    // up immediately on page load instead of being held in disk cache.
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  res.end(buf);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveFn, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolveFn(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolveFn(data));
    req.on('error', reject);
  });
}

/**
 * Minimal multipart parser — returns ALL parts (fields + files).
 * Files are written to a tmp path and the path is returned.
 * For production switch to formidable / busboy.
 */
type MultipartPart =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; tmpPath: string };

async function receiveMultipart(
  req: IncomingMessage,
  contentType: string,
): Promise<MultipartPart[]> {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) throw new Error('No multipart boundary');
  const boundary = `--${boundaryMatch[1]}`;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  const text = buf.toString('binary');
  const parts = text.split(boundary).slice(1, -1);
  const out: MultipartPart[] = [];
  const fs = await import('node:fs/promises');
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const bodyRaw = part.slice(headerEnd + 4, part.length - 2);
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch || !nameMatch[1]) continue;
    const name = nameMatch[1];
    const fnMatch = headers.match(/filename="([^"]+)"/);
    if (fnMatch && fnMatch[1]) {
      const filename = fnMatch[1];
      const tmpPath = join(tmpdir(), `hv-upload-${randomUUID().slice(0, 8)}-${filename}`);
      await mkdir(dirname(tmpPath), { recursive: true });
      await fs.writeFile(tmpPath, Buffer.from(bodyRaw, 'binary'));
      out.push({ kind: 'file', name, filename, tmpPath });
    } else {
      // Field — body is utf8 text
      out.push({ kind: 'field', name, value: Buffer.from(bodyRaw, 'binary').toString('utf8') });
    }
  }
  return out;
}

// Backward-compat shim used by the older /api/projects/:id/assets endpoint
async function receiveMultipartFile(
  req: IncomingMessage,
  contentType: string,
): Promise<{ filePath: string; filename: string }> {
  const parts = await receiveMultipart(req, contentType);
  const file = parts.find((p): p is Extract<MultipartPart, { kind: 'file' }> => p.kind === 'file');
  if (!file) throw new Error('No file field in multipart body');
  return { filePath: file.tmpPath, filename: file.filename };
}

// Keep TS aware that copyFile / AssetStore are used somewhere (they're indirectly via orchestrator)
void copyFile;
void AssetStore;

// ---------------------------------------------------------------------------
// In-memory message history (v0.2 — persistence in v0.3)
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  agent?: string;
  tool?: string;
  output?: unknown;
  ts: number;
}

const MESSAGES = new Map<string, ChatMessage[]>();

// `Attachment` is declared above (at the buildHtmlGenerationPrompt section)

interface BuildPromptArgs {
  tmpl: import('@html-video/core').TemplateMetadata;
  exampleHtml: string;
  priorHtml: string;
  history: ChatMessage[];
  userText: string;
  attachments: Attachment[];
}

interface Attachment {
  /** absolute path on disk */
  path: string;
  /** type the AssetStore detected */
  kind: 'image' | 'video' | 'audio' | 'data' | 'text' | 'reference-link';
  /** display name */
  filename: string;
  /** byte size */
  size: number;
}

/**
 * v0.5 chat prompt — guidance-first, not write-HTML-immediately.
 *
 * The system prompt tells the agent to:
 *   - On a vague first turn, ask 1–3 sharp questions instead of writing HTML
 *   - When the request + context are concrete enough, generate the full HTML
 *   - Use attachments as references / actual assets
 *   - Never use a fixed 4-question script — judge per turn what's missing
 *
 * Whether the agent writes HTML this turn is up to the agent. The server
 * extracts a fenced ```html block if present; if not, it's just a chat reply.
 */
function buildHtmlGenerationPrompt(args: BuildPromptArgs): string {
  const { tmpl, exampleHtml, priorHtml, history, userText, attachments } = args;

  const baseHtml = priorHtml && priorHtml !== exampleHtml ? priorHtml : exampleHtml;
  const isFirstTurn = history.filter((m) => m.role === 'user').length <= 1;

  const parts: string[] = [];

  parts.push(`# Role`);
  parts.push(
    `You are a Hyperframes video creation collaborator. The user wants ONE self-contained HTML file that opens with animation and is ready to be recorded into an MP4.`,
  );
  parts.push('');

  parts.push(`# Behaviour`);
  parts.push(`- If the user's request is concrete enough to make a good first draft, generate the HTML directly (see Output rules below).`);
  parts.push(`- If the request is too vague, ask 1–3 short, sharp questions to surface what's missing. Use your judgement: don't ask a fixed checklist of audience/platform/style/tone — pick whichever 1–3 things are blocking *this* particular project.`);
  parts.push(`- When the user attaches files, use them: images / video links as visual style references, logos / photos as actual assets to embed, data files as content, text files as copy.`);
  parts.push(`- When you have enough to draft, you may optionally summarise a one-paragraph creative brief and check in ("shall I draft now?"). Skip the brief if the user is clearly ready.`);
  parts.push(`- Don't perform a fixed onboarding script. Be a thoughtful collaborator, not a form.`);
  parts.push(`- Keep chat replies brief. The HTML is the artefact.`);
  parts.push('');

  parts.push(`# Template currently selected`);
  parts.push(`${tmpl.name} (${tmpl.category}) — ${tmpl.description}`);
  parts.push(`The template's visual signature (colors, animation timing, layout) should be preserved unless the user explicitly asks for a deviation.`);
  parts.push('');

  if (attachments.length > 0) {
    parts.push(`# Attachments in this turn`);
    for (const a of attachments) {
      parts.push(`- [${a.kind}] ${a.filename} (${a.size} bytes) — ${a.path}`);
    }
    parts.push(`Use these as references or assets. Reference image paths in <img src="..."> as needed.`);
    parts.push('');
  }

  parts.push(`# Source HTML (the current preview state)`);
  parts.push('```html');
  parts.push(baseHtml.slice(0, 6000));
  parts.push('```');
  parts.push('');

  const recentUserTurns = history
    .filter((m) => m.role === 'user')
    .slice(-4, -1)
    .map((m) => m.content);
  if (recentUserTurns.length > 0) {
    parts.push(`# Earlier user messages in this conversation`);
    for (const t of recentUserTurns) parts.push(`- ${t.slice(0, 240)}`);
    parts.push('');
  }

  parts.push(`# Latest user message`);
  parts.push(userText);
  if (isFirstTurn) {
    parts.push('');
    parts.push(`(This is the first turn for this project. If the message is concrete enough, just draft. Otherwise ask 1–3 questions to surface what's missing.)`);
  }
  parts.push('');

  parts.push(`# Output rules (only when you decide to draft HTML)`);
  parts.push(`- Reply with ONE complete HTML document inside a single \`\`\`html\`\`\` fenced code block.`);
  parts.push(`- Start with \`<!doctype html>\` and end with \`</html>\`.`);
  parts.push(`- Inline all CSS and JS (no external imports beyond CDN scripts already in the source).`);
  parts.push(`- Mark every user-visible text node with \`data-hv-text="<short-key>"\` (e.g. \`brand_name\`, \`tagline\`, \`headline\`, \`item_1\`, \`cta\`). Preserve any existing keys across rewrites.`);
  parts.push(`- No explanation outside the code block when you draft.`);
  parts.push('');
  parts.push(`# When you don't draft this turn`);
  parts.push(`- Reply in plain conversational text. Markdown is rendered: use **bold**, lists, and headings to keep replies readable.`);
  parts.push(`- Be concise.`);
  parts.push('');
  parts.push(`# Multiple-choice question format (RECOMMENDED for short option sets)`);
  parts.push(`When a question has a small set of natural options (2–6), present it as a clickable card.`);
  parts.push(`Emit a fenced code block with the language tag "hv-options" containing valid JSON with this shape:`);
  parts.push('');
  parts.push(`  { "question": "...", "options": [{ "label": "...", "hint": "..." }, ...], "allow_freeform": true }`);
  parts.push('');
  parts.push(`Rules:`);
  parts.push(`- Use 2–6 options. If a question is genuinely open-ended, ask in plain prose instead.`);
  parts.push(`- Each option label is short (≤ 30 chars). \`hint\` is optional, one clarifying line.`);
  parts.push(`- Concrete, distinct options. Don't invent choices the user wouldn't realistically pick.`);
  parts.push(`- The hv-options block must be the only block in that turn (markdown preamble above is fine; no prose after).`);
  parts.push(`- Set \`allow_freeform: true\` when the user might want a custom answer.`);
  parts.push(`- Skip this format when there's no clean small set; just ask in prose.`);
  parts.push('');
  parts.push(`## Avoid template-name tunnel vision`);
  parts.push(`Don't let the template's name (e.g. "Logo Outro Frame") force every option into that single use case.`);
  parts.push(`Templates are visual skeletons — users repurpose them. A "Logo Outro" template can also become an opener, a 30-second product teaser, a recurring motion brand block, or a full short-form video. So when you offer choices about scope or use case, include at least one option that opens the door wider:`);
  parts.push(`- "Use this as the visual style for a longer / full-length video"`);
  parts.push(`- "Series of short videos sharing this style"`);
  parts.push(`- "Adapt the style to a completely different scenario"`);
  parts.push(`Pick whichever is most likely given the user's signal. The point: never force the user to stay inside the template's literal name.`);

  return parts.join('\n');
}

/**
 * Extract a full HTML document from agent output.
 * Tries (1) `\`\`\`html ... \`\`\`` block, (2) bare `<!doctype html>...</html>`.
 */
function extractHtmlDocument(text: string): string | null {
  const fence = /```html\s*\n([\s\S]*?)```/i.exec(text);
  if (fence && fence[1]) {
    const html = fence[1].trim();
    if (/<\/html>/i.test(html)) return html;
  }
  const bare = /<!doctype html[\s\S]*?<\/html>/i.exec(text);
  if (bare) return bare[0];
  return null;
}
