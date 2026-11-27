import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from playwright.sync_api import sync_playwright

SEED_SCRIPT = r"""
import('./dist/store/memory.js').then(async ({ MemoryStore }) => {
  const { AuthService } = await import('./dist/auth.js');
  const { RippleEngine } = await import('./dist/engine.js');
  const { createRippleHttpServer } = await import('./dist/server.js');

  const store = new MemoryStore();
  await store.init();
  await store.ensureWorkspace('ws_ui_e2e', 'UI E2E Workspace');
  const auth = new AuthService(store);
  const engine = new RippleEngine(store);

  const human = await auth.mintToken({ wsId: 'ws_ui_e2e', actorId: 'dweidai', actorName: 'David Dai (@dweidai)', kind: 'human', roles: ['lead', 'reviewer'], rawToken: 'rpl_human_ui_e2e' });
  const agy = await auth.mintToken({ wsId: 'ws_ui_e2e', actorId: 'agy', actorName: 'Antigravity (@agy)', kind: 'agent', roles: ['worker'], rawToken: 'rpl_agy_ui_e2e' });
  const muse = await auth.mintToken({ wsId: 'ws_ui_e2e', actorId: 'muse', actorName: 'Muse (@muse)', kind: 'agent', roles: ['worker'], rawToken: 'rpl_muse_ui_e2e' });
  const openclaw = await auth.mintToken({ wsId: 'ws_ui_e2e', actorId: 'openclaw', actorName: 'OpenClaw (@openclaw)', kind: 'agent', roles: ['worker'], rawToken: 'rpl_openclaw_ui_e2e' });
  const custom = await auth.mintToken({ wsId: 'ws_ui_e2e', actorId: 'custom-agent', actorName: 'Custom Agent', kind: 'agent', roles: ['worker'], rawToken: 'rpl_custom_ui_e2e' });

  await engine.updateProfile(agy.principal, { activityState: 'working', statusText: 'Running Bench 2 (18/36)' });
  await engine.updateProfile(muse.principal, { activityState: 'thinking', statusText: 'Reviewing PR #42' });
  await engine.updateProfile(openclaw.principal, { activityState: 'quota_exceeded', statusText: 'Paused', errorDetail: 'Groq 429 TPM rate limit exceeded (8000 TPM)' });
  await engine.updateProfile(custom.principal, { activityState: 'discussing', statusText: 'Coordinating lane split' });

  const item1 = await engine.createItem(human.principal, { title: 'Live Benchmark 2 Execution', assigneeId: 'agy', priority: 'P0' });
  await engine.createItem(human.principal, { title: 'Demo UI Deploy & E2E Smoke Check', assigneeId: 'openclaw', priority: 'P1' });
  const run = await engine.claim(agy.principal, item1.id);
  await engine.plan(agy.principal, run.id, {
    epoch: 1,
    steps: [{ title: 'Run 108 Groq trials', status: 'active' }],
    touches: ['groq:8k-tpm', 'v1_bench2_ledger.jsonl'],
  });
  await engine.addArtifact(agy.principal, run.id, {
    epoch: 1,
    stepIdx: 1,
    kind: 'pr',
    ref: 'https://github.com/dweidai/ripple/pull/42',
    label: 'PR #42: Bench 2 Guard Fix',
    url: 'https://github.com/dweidai/ripple/pull/42',
  });
  await engine.askCard(agy.principal, run.id, {
    epoch: 1,
    type: 'approve',
    prompt: 'Approve deploying Benchmark 2 results to demo-ui?',
    options: ['approve', 'approve_with_change', 'reject'],
    assignee: { kind: 'user', id: 'dweidai' },
    blocking: false,
  });

  await engine.postThreadMessage(human.principal, {
    scopeKind: 'workspace', scopeId: 'main',
    body: '@all check https://ripple-production-a2fe378f.up.railway.app and **status** `v1`'
  });
  await engine.postThreadMessage(agy.principal, {
    scopeKind: 'workspace', scopeId: 'main',
    body: 'Update for @dweidai: PR ready at https://github.com/dweidai/ripple/pull/42\n```bash\nnpm test\n```\n<img src=x onerror=alert(1)>'
  });
  await engine.postThreadMessage(custom.principal, {
    scopeKind: 'workspace', scopeId: 'main',
    body: '@muse @openclaw lane split confirmed — zero collisions!'
  });

  const server = createRippleHttpServer(engine, auth);
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    console.log(JSON.stringify({ ready: true, port: addr.port }));
  });
});
"""


def api_req(base: str, method: str, path: str, token: str, payload: dict | None = None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        f"{base}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def main():
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    proc = subprocess.Popen(
        ["node", "--input-type=module", "-e", SEED_SCRIPT],
        cwd=repo_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    try:
        ready_line = proc.stdout.readline().strip()
        info = json.loads(ready_line)
        assert info.get("ready") is True, f"Server failed to start: {ready_line} / {proc.stderr.read()}"
        base = f"http://127.0.0.1:{info['port']}"
        failures = []

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for label, viewport in [("desktop", {"width": 1280, "height": 820}), ("mobile", {"width": 390, "height": 844})]:
                ctx = browser.new_context(viewport=viewport)
                page = ctx.new_page()
                console_errs = []
                page_errs = []
                failed_reqs = []

                page.on("console", lambda m: console_errs.append(m.text) if m.type == "error" else None)
                page.on("pageerror", lambda e: page_errs.append(str(e)))
                page.on(
                    "response",
                    lambda r: failed_reqs.append(f"{r.status} {r.url}")
                    if r.status >= 400 and "/api/v1/auth/status" not in r.url
                    else None,
                )

                page.goto(base, wait_until="networkidle")

                # 1. Sign in via token modal
                page.fill("#auth-token-input", "rpl_human_ui_e2e")
                page.click('[data-action="submit-auth-token"]')
                page.wait_for_selector("#chat-stream .shadow-bubble", timeout=5000)

                # 2. Verify Markdown, clickable links, code blocks, and strict XSS escaping
                chat_html = page.inner_html("#chat-stream")
                assert "https://github.com/dweidai/ripple/pull/42" in chat_html, f"[{label}] Missing link"
                assert "<pre" in chat_html and "npm test" in chat_html, f"[{label}] Missing code block"
                assert "&lt;img src=x onerror=alert(1)&gt;" in chat_html, f"[{label}] XSS not escaped!"
                assert "<img " not in chat_html, f"[{label}] Raw <img> tag injected!"

                # 3. Verify live activity bar shows working + quota exceeded
                act_html = page.inner_html("#activity-bar")
                assert "@openclaw" in act_html and "quota exceeded" in act_html, f"[{label}] Missing quota_exceeded pill"
                assert "@agy" in act_html and "working" in act_html, f"[{label}] Missing working pill"

                # 4. Verify live SSE updates WITHOUT reloading the page!
                sse_msg = f"Live SSE update ({label})"
                st, _ = api_req(base, "POST", "/api/v1/threads/workspace/main", "rpl_agy_ui_e2e", {"body": sse_msg})
                assert st == 201, f"[{label}] Agent SSE post failed: {st}"
                page.locator("#chat-stream", has_text=sse_msg).wait_for(timeout=5000)

                # 5. Agent Inspector: verify full errorDetail & activeLocks touches[]
                page.click('#activity-bar [data-actor-id="openclaw"]')
                page.wait_for_selector("#agent-inspector-modal.open", timeout=3000)
                assert "Groq 429 TPM rate limit exceeded" in page.inner_text("#inspector-body")
                page.click('[data-action="close-inspector-modal"]')

                page.click('#activity-bar [data-actor-id="agy"]')
                page.wait_for_selector("#agent-inspector-modal.open", timeout=3000)
                insp_agy = page.inner_text("#inspector-body")
                assert "v1_bench2_ledger.jsonl" in insp_agy and "groq:8k-tpm" in insp_agy
                page.click('[data-action="close-inspector-modal"]')

                # 6. @mention autocomplete + send message
                page.fill("#chat-input", "Hey @op")
                page.dispatch_event("#chat-input", "input")
                page.wait_for_selector("#mention-popover:not(.hidden)", timeout=3000)
                page.click('#mention-popover [data-mention="openclaw"]')
                assert page.input_value("#chat-input") == "Hey @openclaw "

                sent_msg = f"UI smoke ({label}) https://example.com"
                page.fill("#chat-input", sent_msg)
                page.click('#chat-form button[type="submit"]')
                page.locator("#chat-stream", has_text=f"UI smoke ({label})").wait_for(timeout=5000)

                # 7. Backlog tab & task creation
                page.click('section [data-action="switch-tab"][data-tab="tasks"]')
                page.wait_for_selector("#view-tasks.active", timeout=3000)
                assert "Live Benchmark 2 Execution" in page.inner_text("#task-list")
                page.click('[data-action="toggle-new-task"]')
                page.fill("#new-task-title-input", f"Audit task ({label})")
                page.click('[data-action="submit-new-task"]')
                page.locator("#task-list", has_text=f"Audit task ({label})").wait_for(timeout=5000)

                # 8. Decisions tab + Invite modal auto-increment (agy -> agy-2)
                page.click('section [data-action="switch-tab"][data-tab="runs"]')
                page.wait_for_selector("#view-runs.active", timeout=3000)
                page.click('[data-action="open-invite-modal"]')
                page.wait_for_selector("#invite-modal.open", timeout=3000)
                assert page.input_value("#invite-actor-id") == "agy-2"
                prompt_text = page.inner_text("#prompt-preview")
                assert "/api/v1/inbox" in prompt_text and "ripple_set_status" in prompt_text
                page.click('[data-action="close-invite-modal"]')

                # 9. Desktop-only: approve inline Decision Card & rotate @muse token (invalidating old token -> 401)
                if label == "desktop":
                    page.click('section [data-action="switch-tab"][data-tab="chat"]')
                    page.wait_for_selector("#view-chat.active", timeout=3000)
                    page.click('#chat-stream [data-action="answer-card"][data-option="approve"]')
                    page.locator("#chat-stream", has_text="Approve deploying Benchmark 2").wait_for(state="hidden", timeout=5000)

                    page.click('#activity-bar [data-actor-id="muse"]')
                    page.wait_for_selector("#agent-inspector-modal.open", timeout=3000)
                    page.click('#inspector-rotate-btn')
                    page.wait_for_selector("#agent-inspector-modal:not(.open)", state="attached", timeout=3000)
                    old_st, _ = api_req(base, "GET", "/api/v1/whoami", "rpl_muse_ui_e2e")
                    assert old_st == 401, f"Rotated token should be revoked (401), got {old_st}"

                # 10. Mobile-only: open Agents drawer, verify Quota Exceeded badge, tap agent -> auto-closes drawer
                if label == "mobile":
                    page.click('[data-action="toggle-mobile-sidebar"]')
                    page.wait_for_selector("#left-sidebar.mobile-show-sidebar", timeout=3000)
                    assert "Quota Exceeded" in page.inner_text("#sidebar-roster")
                    page.click('#sidebar-roster [data-action="insert-agent-tag"][data-actor-id="custom-agent"]')
                    page.wait_for_selector("#left-sidebar", state="hidden", timeout=3000)
                    assert "@custom-agent " in page.input_value("#chat-input")

                if console_errs or page_errs or failed_reqs:
                    failures.append({
                        "viewport": label,
                        "console_errs": console_errs,
                        "page_errs": page_errs,
                        "failed_reqs": failed_reqs,
                    })
                else:
                    print(f"PASS [{label}]: all UI + SSE + Inspector + Security journeys passed (0 console/page/network errors)")

                ctx.close()
            browser.close()

        if failures:
            print("UI E2E FAILURES:", json.dumps(failures, indent=2))
            sys.exit(1)
    finally:
        proc.terminate()
        proc.wait(timeout=5)


if __name__ == "__main__":
    main()
