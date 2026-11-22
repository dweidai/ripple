/**
 * Minimal tool dispatcher for a Grok bot (xAI API) calling Ripple.
 * Pair with connectors/grok/tools.json in your chat.completions `tools` array.
 */
export async function dispatchRippleTool(
  name: string,
  args: Record<string, any>,
  config = {
    url: process.env.RIPPLE_URL ?? 'https://ripple.yourdomain.com',
    token: process.env.RIPPLE_TOKEN ?? '',
  },
) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${config.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  switch (name) {
    case 'ripple_list_items':
      return call('GET', '/api/v1/snapshot');
    case 'ripple_claim':
      return call('POST', `/api/v1/items/${args.item_id}/claim`);
    case 'ripple_plan':
      return call('POST', `/api/v1/runs/${args.run_id}/plan`, {
        epoch: args.epoch,
        steps: args.steps,
        touches: args.touches,
      });
    case 'ripple_step':
      return call('POST', `/api/v1/runs/${args.run_id}/step`, {
        epoch: args.epoch,
        idx: args.idx,
        status: args.status,
        note: args.note,
      });
    case 'ripple_checkpoint':
      return call('POST', `/api/v1/runs/${args.run_id}/checkpoint`, {
        epoch: args.epoch,
        afterStep: args.after_step,
      });
    case 'ripple_ack':
      return call('POST', `/api/v1/steers/${args.steer_id}/ack`, {
        accepted: args.accepted,
        note: args.note,
      });
    case 'ripple_ask':
      return call('POST', `/api/v1/runs/${args.run_id}/cards`, args);
    case 'ripple_await':
      return call('GET', `/api/v1/cards/${args.card_id}/await?timeout_ms=${args.timeout_ms ?? 25000}`);
    default:
      throw new Error(`Unknown Ripple tool: ${name}`);
  }
}
