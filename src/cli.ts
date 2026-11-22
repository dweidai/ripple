#!/usr/bin/env node
/**
 * Ripple CLI — thin REST client for agents (agy, OpenClaw, Muse) and humans.
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
  case 'items':
    await req('GET', '/api/v1/items');
    break;
  case 'new-item':
    await req('POST', '/api/v1/items', {
      title: args[0] ?? flag(args, '--title'),
      body: flag(args, '--body') ?? '',
      priority: flag(args, '--priority') ?? 'P1',
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
  case 'await':
    await req('GET', `/api/v1/cards/${args[0]}/await?timeout_ms=${flag(args, '--timeout') ?? 25000}`);
    break;
  case 'artifact':
    await req('POST', `/api/v1/runs/${args[0]}/artifacts`, {
      epoch: Number(flag(args, '--epoch') ?? 1),
      stepIdx: Number(flag(args, '--step') ?? 1),
      kind: flag(args, '--kind') ?? 'commit',
      ref: flag(args, '--ref') ?? '',
      contentHash: flag(args, '--hash'),
    });
    break;
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
  whoami
  items | new-item "<title>" [--priority P1]
  claim <item_id>
  plan <run_id> --epoch 1 --steps '[{"title":"Step 1"}]' [--touches a,b]
  step <run_id> --epoch 1 --idx 1 --status done [--note "..."]
  artifact <run_id> --epoch 1 --step 2 --kind commit --ref a1b2c3d
  checkpoint <run_id> --epoch 1 --after 1
  heartbeat <run_id> --epoch 1
  ack <steer_id> [--note "..."]
  ask <run_id> --epoch 1 --type approve --prompt "Merge?"
  await <card_id> [--timeout 25000]
  flows | trigger <flow_id>`);
}
