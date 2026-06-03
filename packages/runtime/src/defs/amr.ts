import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { AgentDef } from '../types.js';

const exec = promisify(execFile);

/**
 * Open Design AMR (Vela) agent.
 *
 * AMR is the `vela` CLI's ACP stdio mode: `vela agent run --runtime opencode`
 * starts a private OpenCode server and speaks ACP JSON-RPC over stdio. The user
 * authenticates once in the Open Design app (`vela login`, browser OAuth) — we
 * reuse that login state, never ask for an API key.
 *
 * `vela` ships INSIDE the Open Design app bundle, not on PATH, so detection
 * falls back to the known bundle locations. Login state lives in
 * ~/.vela/config.json (profile → runtimeKey/apiUrl/user); we treat a profile
 * with a runtimeKey + `vela whoami` success as "logged in".
 *
 * v0.1 (this file): detection + login gate + spawn argv. The ACP JSON-RPC
 * client that drives initialize → session/new → session/prompt and reads
 * streamed session/update is wired in a dedicated spawn path (stage 02).
 */

const VELA_BUNDLE_FALLBACKS = [
  '/Applications/Open Design.app/Contents/Resources/open-design/bin/vela',
  join(homedir(), 'Applications/Open Design.app/Contents/Resources/open-design/bin/vela'),
];

interface VelaProfile {
  runtimeKey?: string;
  apiUrl?: string;
  user?: { email?: string; plan?: string } | null;
}

/** Read ~/.vela/config.json and return the active profile (prod by default). */
export function readVelaProfile(): { name: string; profile: VelaProfile } | null {
  try {
    const raw = readFileSync(join(homedir(), '.vela', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw) as { profiles?: Record<string, VelaProfile> };
    const profiles = cfg.profiles ?? {};
    const name = process.env.VELA_PROFILE?.trim() || (profiles.prod ? 'prod' : Object.keys(profiles)[0] ?? '');
    const profile = profiles[name];
    return profile ? { name, profile } : null;
  } catch {
    return null;
  }
}

export const amr: AgentDef = {
  id: 'amr',
  name: 'Open Design AMR',
  bin: 'vela',
  binFallbacks: VELA_BUNDLE_FALLBACKS,
  versionArgs: ['--version'],
  // ACP stdio runtime: starts a private OpenCode server, talks JSON-RPC.
  buildArgs: () => ['agent', 'run', '--runtime', 'opencode'],
  streamFormat: 'acp-json-rpc',
  installUrl: 'https://open-design.ai',

  // Found on disk → confirm the user is actually logged in. AMR needs no API
  // key, but it does need a live `vela login` session.
  async extraDetect(resolvedBin: string) {
    const prof = readVelaProfile();
    if (!prof || !prof.profile.runtimeKey) {
      return { available: false, hint: 'Sign in to AMR in the Open Design app first (vela login).' };
    }
    // whoami is the authoritative liveness check — the stored runtimeKey can
    // expire even when config.json still looks populated.
    try {
      const { stdout } = await exec(resolvedBin, ['whoami'], { timeout: 6000 });
      const out = stdout.trim();
      if (/not logged in|run `?vela login`?/i.test(out)) {
        return { available: false, hint: 'AMR session expired — re-run vela login in Open Design.' };
      }
      const email = prof.profile.user?.email;
      const plan = prof.profile.user?.plan;
      return { available: true, version: `AMR${email ? ` · ${email}` : ''}${plan ? ` (${plan})` : ''}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not logged in/i.test(msg)) {
        return { available: false, hint: 'AMR session expired — re-run vela login in Open Design.' };
      }
      return { available: false, hint: `vela whoami failed: ${msg.slice(0, 120)}` };
    }
  },
};
