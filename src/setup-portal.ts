import { randomBytes } from "node:crypto";
import { chmod, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const fields = z.object({
  SCSB_ID: z.string().trim().min(1).max(20),
  SCSB_USER_CODE: z.string().trim().min(6).max(12),
  SCSB_PASSWORD: z.string().min(8).max(128),
  OPENROUTER_API_KEY: z.string().trim().min(10).max(500),
  TYPESAFE_API_KEY: z.string().trim().min(10).max(500),
});

const token = randomBytes(32).toString("base64url");
const nonce = randomBytes(16).toString("base64url");
const expiresAt = Date.now() + 20 * 60_000;
const secretsPath = resolve(import.meta.dir, "../credentials.json");
let used = false;

const headers = {
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SCSB automation setup</title>
<style>body{font:16px system-ui,sans-serif;background:#f4f6f8;color:#17212b;margin:0;padding:24px}main{max-width:520px;margin:36px auto;background:white;border:1px solid #dce3ea;border-radius:16px;padding:28px;box-shadow:0 12px 30px #11223312}h1{font-size:1.55rem;margin:0 0 8px}p{line-height:1.45;color:#445363}label{display:block;font-weight:650;margin:18px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #a9b7c5;border-radius:8px;font:inherit}input:focus{outline:2px solid #1458a8;outline-offset:1px}button{margin-top:24px;padding:12px 18px;background:#1458a8;color:white;border:0;border-radius:8px;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.5;cursor:wait}#status{min-height:1.5em;margin-top:16px}small{color:#586674}</style></head>
<body><main><h1>SCSB automation setup</h1><p>Enter these values once. They will be saved only to the private config file on Howard's Mac. This page expires after 20 minutes and closes after saving.</p>
<form id="setup" autocomplete="off">
<label for="bankId">身分證字號／統編</label><input id="bankId" name="SCSB_ID" required maxlength="20" autocomplete="off">
<label for="userCode">使用者代號</label><input id="userCode" name="SCSB_USER_CODE" required minlength="6" maxlength="12" autocomplete="off">
<label for="password">網銀密碼</label><input id="password" name="SCSB_PASSWORD" type="password" required minlength="8" autocomplete="new-password">
<label for="openrouter">OpenRouter API key</label><input id="openrouter" name="OPENROUTER_API_KEY" type="password" required autocomplete="off">
<label for="typesafe">TypeSafe API key</label><input id="typesafe" name="TYPESAFE_API_KEY" type="password" required autocomplete="off">
<button type="submit">Save private configuration</button><div id="status" role="status" aria-live="polite"></div></form>
<small>Use only the link Howard received for this setup. Do not send these values through chat.</small></main>
<script nonce="${nonce}">const form=document.getElementById('setup');const status=document.getElementById('status');const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Saving…';try{const data=Object.fromEntries(new FormData(form));const response=await fetch('/save',{method:'POST',headers:{'content-type':'application/json','x-setup-token':token},body:JSON.stringify(data),cache:'no-store'});if(!response.ok)throw new Error(response.status===403?'This setup link is invalid or expired.':'Could not save the configuration.');form.replaceChildren(status);status.textContent='Saved. You can close this page.';}catch(error){status.textContent=error.message;button.disabled=false;}});</script></body></html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (used || Date.now() >= expiresAt) return new Response("Setup link expired", { status: 410, headers });
    if (request.method === "GET" && url.pathname === "/") return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
    if (request.method !== "POST" || url.pathname !== "/save") return new Response("Not found", { status: 404, headers });
    if (request.headers.get("x-setup-token") !== token) return new Response("Invalid setup token", { status: 403, headers });
    if (Number(request.headers.get("content-length")) > 8_192) return new Response("Too large", { status: 413, headers });
    const raw = await request.text();
    if (raw.length > 8_192) return new Response("Too large", { status: 413, headers });
    let data: z.infer<typeof fields>;
    try { data = fields.parse(JSON.parse(raw)); }
    catch { return new Response("Invalid values", { status: 400, headers }); }
    used = true;
    const temporary = `${secretsPath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, secretsPath);
      console.log("SCSB_SETUP_SAVED");
      setTimeout(() => server.stop(), 1_000).unref();
      return new Response("Saved", { headers });
    } catch {
      used = false;
      return new Response("Save failed", { status: 500, headers });
    }
  },
});

setTimeout(() => { console.log("SCSB_SETUP_EXPIRED"); server.stop(); }, 20 * 60_000).unref();
console.log(`SCSB_SETUP_PORT=${server.port}`);
console.log(`SCSB_SETUP_TOKEN=${token}`);
