#!/usr/bin/env node
/**
 * Ripple CLI — thin REST client for agents (agy, OpenClaw, Muse, sub-agents) and humans.
 * Env: RIPPLE_URL (default http://localhost:8787), RIPPLE_TOKEN
 */

const baseUrl = (process.env.RIPPLE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const token = process.env.RIPPLE_TOKEN ?? '';

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain text
  }
  if (!res.ok) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case 'whoami':
    await req('GET', '/api/v1/whoami');
    break;
  case 'me':
    await req('PATCH', '/api/v1/me', {
      actorName: flag(args, '--name') ?? args[0],
      statusText: flag(args, '--status'),
      bio: flag(args, '--bio'),
      avatarColor: flag(args, '--color'),
    });
    break;
  case 'invite':
    await req('POST', '/api/v1/invites', {
      actorId: args[0] ?? flag(args, '--id') ?? 'agy',
      actorName: flag(args, '--name'),
      kind: flag(args, '--kind') ?? 'agent',
      roles: flag(args, '--roles')?.split(',').filter(Boolean),
      rotate: args.includes('--rotate'),
      announceInDialogue: args.includes('--announce'),
    });
    break;
  case 'context': {
    const runId = flag(args, '--run');
    const limit = flag(args, '--limit');
    const qs = new URLSearchParams();
    if (runId) qs.set('run_id', runId);
    if (limit) qs.set('limit', limit);
    await req('GET', `/api/v1/context${qs.toString() ? `?${qs.toString()}` : ''}`);
    break;
  }
  case 'items':
    await req('GET', '/api/v1/items');
    break;
  case 'new-item':
    await req('POST', '/api/v1/items', {
      title: args[0] && !args[0].startsWith('--') ? args[0] : flag(args, '--title'),
      body: flag(args, '--body') ?? '',
      priority: flag(args, '--priority') ?? 'P1',
      assigneeId: flag(args, '--assignee'),
      parentItemId: flag(args, '--parent'),
      tags: flag(args, '--tags')?.split(',').filter(Boolean),
    });
    break;
  case 'update-item':
    await req('PATCH', `/api/v1/items/${args[0]}`, {
      title: flag(args, '--title'),
      body: flag(args, '--body'),
      priority: flag(args, '--priority'),
      status: flag(args, '--status'),
      assigneeId: flag(args, '--assignee'),
      parentItemId: flag(args, '--parent'),
      tags: flag(args, '--tags')?.split(',').filter(Boolean),
      resultUrl: flag(args, '--url'),
    });
    break;
  case 'claim':
    await req('POST', `/api/v1/items/${args[0]}/claim`);
    break;
  case 'plan': {
    const runId = args[0];
    const epoch = Number(flag(args, '--epoch') ?? 1);
    const stepsJson = flag(args, '--steps') ?? '[]';
    const touches = flag(args, '--touches')?.split(',').filter(Boolean);
    await req('POST', `/api/v1/runs/${runId}/plan`, { epoch, steps: JSON.parse(stepsJson), touches });
    break;
  }
  case 'step':
    await req('POST', `/api/v1/runs/${args[0]}/step`, {
      epoch: Number(flag(args, '--epoch') ?? 1),
      idx: Number(flag(args, '--idx') ?? 1),
      status: flag(args, '--status') ?? 'done',
      note: flag(args, '--note'),
    });
    break;
  case 'spawn-subrun': {
    const parentRunId = args[0];
    const stepsRaw = flag(args, '--steps');
    await req('POST', `/api/v1/runs/${parentRunId}/subruns`, {
      title: flag(args, '--title') ?? args[1] ?? 'Sub-agent task',
      goal: flag(args, '--goal'),
      subagentId: flag(args, '--subagent') ?? flag(args, '--agent'),
      subagentName: flag(args, '--name'),
      itemId: flag(args, '--item'),
      parentStepIdx: flag(args, '--step') ? Number(flag(args, '--step')) : undefined,
      steps: stepsRaw ? JSON.parse(stepsRaw) : undefined,
      touches: flag(args, '--touches')?.split(',').filter(Boolean),
      executeTool: flag(args, '--tool'),
    });
    break;
  }
  case 'report': {
    const runId = args[0];
    const artifactsRaw = flag(args, '--artifacts');
    await req('POST', `/api/v1/runs/${runId}/report`, {
      epoch: flag(args, '--epoch') ? Number(flag(args, '--epoch')) : undefined,
      summary: flag(args, '--summary') ?? args[1] ?? 'Sub-agent task completed',
      status: flag(args, '--status') ?? 'done',
      artifacts: artifactsRaw ? JSON.parse(artifactsRaw) : undefined,
    });
    break;
  }
  case 'checkpoint':
    await req('POST', `/api/v1/runs/${args[0]}/checkpoint`, {
      epoch: Number(flag(args, '--epoch') ?? 1),
      afterStep: Number(flag(args, '--after') ?? 0),
    });
    break;
  case 'heartbeat':
    await req('POST', `/api/v1/runs/${args[0]}/heartbeat`, {
      epoch: Number(flag(args, '--epoch') ?? 1),
    });
    break;
  case 'ack':
    await req('POST', `/api/v1/steers/${args[0]}/ack`, {
      accepted: flag(args, '--reject') ? false : true,
      note: flag(args, '--note') ?? '',
    });
    break;
  case 'ask':
    await req('POST', `/api/v1/runs/${args[0]}/cards`, {
      epoch: Number(flag(args, '--epoch') ?? 1),
      type: flag(args, '--type') ?? 'approve',
      prompt: flag(args, '--prompt') ?? 'Approve?',
      options: flag(args, '--options')?.split(','),
      diffPreview: flag(args, '--diff'),
    });
    break;
  case 'answer':
    await req('POST', `/api/v1/cards/${args[0]}/answer`, {
      option: flag(args, '--option') ?? args[1] ?? 'approve',
      onPin: flag(args, '--pin') ?? args[2] ?? '',
      note: flag(args, '--note') ?? '',
    });
    break;
  case 'await':
    await req('GET', `/api/v1/cards/${args[0]}/await?timeout_ms=${flag(args, '--timeout') ?? 25000}`);
    break;
  case 'artifact':
    await req('POST', `/api/v1/runs/${args[0]}/artifacts`, {
      epoch: Number(flag(args, '--epoch') ?? 1),
      stepIdx: Number(flag(args, '--step') ?? 1),
      kind: flag(args, '--kind') ?? 'commit',
      ref: flag(args, '--ref') ?? '',
      label: flag(args, '--label'),
      url: flag(args, '--url'),
      contentHash: flag(args, '--hash'),
    });
    break;
  case 'chat': {
    const scopeKind = flag(args, '--scope') ?? 'workspace';
    const scopeId = flag(args, '--scope-id') ?? flag(args, '--run') ?? 'main';
    const body =
      flag(args, '--body') ??
      args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--'))).join(' ');
    await req('POST', `/api/v1/threads/${scopeKind}/${scopeId}`, {
      body,
      sendToAgent: args.includes('--steer'),
    });
    break;
  }
  case 'messages': {
    const scopeKind = flag(args, '--scope') ?? (args[0] && !args[0].startsWith('--') ? args[0] : 'workspace');
    const scopeId = flag(args, '--scope-id') ?? (args[1] && !args[1].startsWith('--') ? args[1] : 'main');
    await req('GET', `/api/v1/threads/${scopeKind}/${scopeId}`);
    break;
  }
  case 'flows':
    await req('GET', '/api/v1/flows');
    break;
  case 'trigger':
    await req('POST', `/api/v1/flows/${args[0]}/trigger`);
    break;
  default:
    console.log(`Ripple CLI
Usage:
  RIPPLE_URL=https://... RIPPLE_TOKEN=rpl_... ripple <command>

Commands:
  whoami | me --name "David (@dweidai)" [--status "Online"]
  invite <actor_id> [--name "..."] [--kind agent|human] [--rotate] [--announce]
  context [--run <run_id>] [--limit 30]
  items | new-item "<title>" [--priority P1] [--assignee agy|muse|you] [--parent <item_id>] [--tags a,b]
  update-item <item_id> [--status open|active|done|dropped] [--assignee agy|muse|you] [--priority P0] [--url https://...]
  claim <item_id>
  plan <run_id> --epoch 1 --steps '[{"title":"Step 1"}]' [--touches a,b]
  step <run_id> --epoch 1 --idx 1 --status done [--note "..."]
  spawn-subrun <parent_run_id> --title "Draft PR" [--subagent agy-sub-github] [--tool github_pr|drive_doc]
  report <run_id> --summary "Completed PR" [--status done|failed] [--artifacts '[{"kind":"pr","ref":"https://..."}]']
  artifact <run_id> --epoch 1 --step 2 --kind commit|pr|gdoc|drive|file|url --ref a1b2c3d
  checkpoint <run_id> --epoch 1 --after 1
  heartbeat <run_id> --epoch 1
  ack <steer_id> [--note "..."]
  ask <run_id> --epoch 1 --type approve --prompt "Merge?"
  answer <card_id> --option approve --pin <pin_value> [--note "..."]
  await <card_id> [--timeout 25000]
  chat "<message>" [--scope workspace|run] [--scope-id main|<run_id>] [--steer]
  messages [workspace|run] [main|<run_id>]
  flows | trigger <flow_id>`);
}

