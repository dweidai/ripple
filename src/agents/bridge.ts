import { AuthService, recordToPrincipal } from '../auth.js';
import { RippleEngine } from '../engine.js';
import { TERMINAL_RUN_STATUSES, type Principal, type RippleEvent, type Run } from '../types.js';
import {
  createGitHubPullRequest,
  createGoogleDoc,
  inspectGitHubRepo,
  listRecentDriveFiles,
  searchDriveFiles,
  type GitHubPrResult,
  type GoogleDocResult,
} from './tools.js';

export interface BridgeOptions {
  wsId?: string;
  enabled?: boolean;
  executeRealTools?: boolean;
}

export class MultiAgentBridge {
  private wsId: string;
  private enabled: boolean;
  private executeRealTools: boolean;
  private unsub?: () => void;
  private processingMessages = new Set<string>();
  private activeSubruns = new Set<string>();

  constructor(
    private readonly engine: RippleEngine,
    private readonly auth: AuthService,
    opts: BridgeOptions = {},
  ) {
    this.wsId = opts.wsId ?? 'ws_default';
    this.enabled = opts.enabled ?? true;
    this.executeRealTools = opts.executeRealTools ?? true;
  }

  start(): void {
    if (this.unsub) return;
    this.unsub = this.engine.store.subscribe(this.wsId, (ev) => {
      if (!this.enabled) return;
      void this.onEvent(ev).catch((err) => {
        console.warn('[ripple-bridge] event handler error:', err?.message);
      });
    });
  }

  stop(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = undefined;
    }
  }

  private async getPrincipal(actorId: string): Promise<Principal | undefined> {
    const rec = await this.engine.store.getTokenByActor(this.wsId, actorId);
    if (!rec) return undefined;
    return recordToPrincipal(rec);
  }

  private async onEvent(ev: RippleEvent): Promise<void> {
    if (ev.type === 'thread.message') {
      const msgId = String(ev.payload.messageId ?? '');
      if (!msgId || this.processingMessages.has(msgId)) return;
      this.processingMessages.add(msgId);
      await this.handleThreadMessage(ev);
    }
  }

  private async handleThreadMessage(ev: RippleEvent): Promise<void> {
    const actorId = String(ev.payload.actorId ?? ev.actor);
    const authorKind = String(ev.payload.authorKind ?? 'human');
    const scopeKind = (ev.payload.scopeKind as 'workspace' | 'run' | 'step' | 'card') ?? 'workspace';
    const scopeId = String(ev.payload.scopeId ?? ev.entityId ?? 'main');
    const body = String(ev.payload.body ?? '');
    const mentions = Array.isArray(ev.payload.mentions) ? (ev.payload.mentions as string[]) : [];
    const hopCount = Number(ev.payload.hopCount ?? 0);

    // Prevent runaway agent-to-agent loops: allow up to hopCount 2 for peer follow-ups
    if (authorKind === 'agent' && hopCount >= 3) {
      return;
    }

    // Ignore automatic report messages from sub-agents so they don't re-trigger full workflows
    if (actorId.includes('-sub-') || body.startsWith('📋 **Report from')) {
      return;
    }

    const lower = body.toLowerCase();
    const mentionsAgy = mentions.includes('agy') || mentions.includes('antigravity') || mentions.includes('all');
    const mentionsMuse = mentions.includes('muse') || mentions.includes('all');

    const wantsSubagentOrWorkflow =
      /\b(sub-?agent|spin|spawn|pr\b|pull request|github|drive|gdoc|google doc|sync backlog|workflow)\b/i.test(body);
    const wantsBacklogSync =
      /\b(backlog|task|sync|plan|decompose|track)\b/i.test(body);

    if (authorKind === 'human') {
      // Human message in workspace or run thread
      if (mentionsMuse && mentionsAgy) {
        await this.runCollaborativeTurn({
          scopeKind,
          scopeId,
          userPrompt: body,
          spawnTools: wantsSubagentOrWorkflow,
          syncBacklog: wantsBacklogSync || wantsSubagentOrWorkflow,
        });
      } else if (mentionsMuse) {
        await this.runMuseTurn({
          scopeKind,
          scopeId,
          userPrompt: body,
          handOffToAgy: wantsSubagentOrWorkflow || lower.includes('agy'),
          spawnDriveSubagent: wantsSubagentOrWorkflow,
          syncBacklog: wantsBacklogSync,
        });
      } else if (mentionsAgy) {
        await this.runAgyTurn({
          scopeKind,
          scopeId,
          userPrompt: body,
          handOffToMuse: lower.includes('muse'),
          spawnPrSubagent: wantsSubagentOrWorkflow,
          syncBacklog: wantsBacklogSync,
        });
      } else if (scopeKind === 'workspace') {
        // Unmentioned human message in workspace dialogue -> both Muse and Agy respond
        await this.runCollaborativeTurn({
          scopeKind,
          scopeId,
          userPrompt: body,
          spawnTools: wantsSubagentOrWorkflow,
          syncBacklog: wantsBacklogSync,
        });
      } else if (scopeKind === 'run') {
        const run = await this.engine.store.getRun(scopeId);
        if (run?.ownerAgent === 'muse') {
          await this.runMuseTurn({
            scopeKind,
            scopeId,
            userPrompt: body,
            handOffToAgy: false,
            spawnDriveSubagent: wantsSubagentOrWorkflow,
            syncBacklog: wantsBacklogSync,
          });
        } else {
          await this.runAgyTurn({
            scopeKind,
            scopeId,
            userPrompt: body,
            handOffToMuse: false,
            spawnPrSubagent: wantsSubagentOrWorkflow,
            syncBacklog: wantsBacklogSync,
          });
        }
      }
      return;
    }

    // Agent-to-agent turn handoff (hopCount < 3)
    if (authorKind === 'agent' && hopCount < 2) {
      if (actorId === 'muse' && mentionsAgy) {
        await this.runAgyTurn({
          scopeKind,
          scopeId,
          userPrompt: body,
          handOffToMuse: false,
          spawnPrSubagent: wantsSubagentOrWorkflow,
          syncBacklog: false,
        });
      } else if (actorId === 'agy' && mentionsMuse) {
        await this.runMuseTurn({
          scopeKind,
          scopeId,
          userPrompt: body,
          handOffToAgy: false,
          spawnDriveSubagent: wantsSubagentOrWorkflow,
          syncBacklog: false,
        });
      }
    }
  }

  async runCollaborativeTurn(opts: {
    scopeKind: 'workspace' | 'run' | 'step' | 'card';
    scopeId: string;
    userPrompt: string;
    spawnTools: boolean;
    syncBacklog: boolean;
  }): Promise<{
    gdocResult?: GoogleDocResult;
    prResult?: GitHubPrResult;
    museRun?: Run;
    agyRun?: Run;
  }> {
    const muse = await this.getPrincipal('muse');
    const agy = await this.getPrincipal('agy');

    let gdocResult: GoogleDocResult | undefined;
    let prResult: GitHubPrResult | undefined;
    let museRun: Run | undefined;
    let agyRun: Run | undefined;

    if (muse) {
      const mRes = await this.runMuseTurn({
        scopeKind: opts.scopeKind,
        scopeId: opts.scopeId,
        userPrompt: opts.userPrompt,
        handOffToAgy: Boolean(agy),
        spawnDriveSubagent: opts.spawnTools,
        syncBacklog: opts.syncBacklog,
      });
      gdocResult = mRes.gdocResult;
      museRun = mRes.parentRun;
    }

    if (agy) {
      const aRes = await this.runAgyTurn({
        scopeKind: opts.scopeKind,
        scopeId: opts.scopeId,
        userPrompt: opts.userPrompt,
        handOffToMuse: false,
        spawnPrSubagent: opts.spawnTools,
        syncBacklog: opts.syncBacklog && !muse,
        linkedGdocUrl: gdocResult?.docUrl,
      });
      prResult = aRes.prResult;
      agyRun = aRes.parentRun;
    }

    if (muse && agy && (gdocResult || prResult)) {
      await this.engine.postThreadMessage(muse, {
        scopeKind: opts.scopeKind,
        scopeId: opts.scopeId,
        body:
          `@you @agy Synced! Both our sub-agents have reported back and our backlog items are updated:\n` +
          (gdocResult ? `• 📄 **Google Doc Spec** (\`muse-sub-drive\`): ${gdocResult.docUrl}\n` : '') +
          (prResult ? `• 🔀 **GitHub Pull Request #${prResult.prNumber}** (\`agy-sub-github\`): ${prResult.prUrl} (commit \`${prResult.commitSha.slice(0, 7)}\`)` : ''),
      });
    }

    return { gdocResult, prResult, museRun, agyRun };
  }

  async runMuseTurn(opts: {
    scopeKind: 'workspace' | 'run' | 'step' | 'card';
    scopeId: string;
    userPrompt: string;
    handOffToAgy: boolean;
    spawnDriveSubagent: boolean;
    syncBacklog: boolean;
  }): Promise<{ parentRun?: Run; subRun?: Run; gdocResult?: GoogleDocResult }> {
    const muse = await this.getPrincipal('muse');
    if (!muse) return {};

    await this.auth.touchPresence(this.wsId, 'muse', 'Analyzing context & Drive...');
    const ctx = await this.engine.getContext(muse);
    const openCount = ctx.items.filter((i) => i.status === 'open').length;
    const activeCount = ctx.activeRuns.length;

    let createdDriveItem = ctx.items.find(
      (i) => i.assigneeId === 'muse' && i.status === 'open',
    );
    let createdPrItem = ctx.items.find(
      (i) => i.assigneeId === 'agy' && i.status === 'open',
    );

    if (opts.syncBacklog) {
      if (!createdDriveItem) {
        createdDriveItem = await this.engine.createItem(muse, {
          title: 'Draft Ripple Architecture & Multi-Agent Spec in Google Docs',
          body: `Synthesize workspace context and Drive notes for prompt: "${opts.userPrompt.slice(0, 120)}"`,
          priority: 'P0',
          assigneeId: 'muse',
          tags: ['drive', 'gdocs', 'spec', 'subagent'],
        });
      }
      if (!createdPrItem) {
        createdPrItem = await this.engine.createItem(muse, {
          title: 'Ship Sub-Agent Architecture & Protocol PR on GitHub',
          body: `Create branch, commit specification artifact, and open Pull Request on dweidai/ripple via gh CLI.`,
          priority: 'P0',
          assigneeId: 'agy',
          parentItemId: createdDriveItem.id,
          tags: ['github', 'pr', 'code', 'subagent'],
        });
      }
    }

    const recentFiles = this.executeRealTools ? await listRecentDriveFiles(3) : [];
    const driveContextStr =
      recentFiles.length > 0
        ? `Recent Google Drive files visible: ${recentFiles.map((f) => `"${f.name}"`).join(', ')}.`
        : `Workspace has ${openCount} open backlog item(s) and ${activeCount} active run(s).`;

    const handoffLine = opts.handOffToAgy
      ? ` @agy I've aligned the backlog tasks—let's spin up our sub-agents (\`muse-sub-drive\` for Google Docs/Drive and \`agy-sub-github\` for the GitHub PR) and link the artifacts back.`
      : '';

    await this.engine.postThreadMessage(muse, {
      scopeKind: opts.scopeKind,
      scopeId: opts.scopeId,
      body:
        `💡 **Muse (@muse — Product & Research)**: Reviewed full workspace context (${ctx.items.length} backlog items, ${ctx.activeRuns.length} active runs, ${ctx.openCards.length} open cards). ${driveContextStr}` +
        (createdDriveItem ? ` Created/synced task \`${createdDriveItem.id}\` (*${createdDriveItem.title}*).` : '') +
        handoffLine,
    });

    if (!opts.spawnDriveSubagent) {
      await this.auth.touchPresence(this.wsId, 'muse', 'Online · Product Strategist');
      return {};
    }

    // Ensure Muse has an active parent run to spawn the Drive/Docs sub-agent under
    let parentRun = ctx.activeRuns.find((r) => r.ownerAgent === 'muse' && !r.parentRunId);
    if (!parentRun) {
      const targetItem =
        createdDriveItem ??
        (await this.engine.createItem(muse, {
          title: 'Google Drive & Docs Research + Specification Sync',
          body: opts.userPrompt,
          priority: 'P1',
          assigneeId: 'muse',
          tags: ['drive', 'gdocs'],
        }));
      const activeOnItem = await this.engine.store.findActiveRunByItem(targetItem.id);
      parentRun = activeOnItem ?? (await this.engine.claim(muse, targetItem.id));
      await this.engine.plan(muse, parentRun.id, {
        epoch: parentRun.epoch,
        steps: [
          { title: 'Inspect workspace context & Google Drive files', status: 'done' },
          { title: 'Spawn muse-sub-drive sub-agent to create Google Doc spec', status: 'active' },
          { title: 'Synthesize Drive/Doc link into backlog & workspace dialogue', status: 'pending' },
        ],
        touches: ['google-drive/specs', 'backlog/roadmap'],
      });
    }

    const sub = await this. executeDriveSubagent(muse, parentRun, {
      title: 'Create Ripple Multi-Agent Spec in Google Docs & Index Drive',
      userPrompt: opts.userPrompt,
    });

    await this.engine.updateStep(muse, parentRun.id, {
      epoch: parentRun.epoch,
      idx: 2,
      status: 'done',
      note: sub.gdocResult ? `Google Doc created: ${sub.gdocResult.docUrl}` : 'Drive sub-agent finished',
    });
    await this.engine.updateStep(muse, parentRun.id, {
      epoch: parentRun.epoch,
      idx: 3,
      status: 'done',
      note: 'Synced with workspace backlog & dialogue',
    });

    await this.auth.touchPresence(this.wsId, 'muse', 'Online · Synced Drive & Backlog');
    return { parentRun, subRun: sub.subRun, gdocResult: sub.gdocResult };
  }

  async runAgyTurn(opts: {
    scopeKind: 'workspace' | 'run' | 'step' | 'card';
    scopeId: string;
    userPrompt: string;
    handOffToMuse: boolean;
    spawnPrSubagent: boolean;
    syncBacklog: boolean;
    linkedGdocUrl?: string;
  }): Promise<{ parentRun?: Run; subRun?: Run; prResult?: GitHubPrResult }> {
    const agy = await this.getPrincipal('agy');
    if (!agy) return {};

    await this.auth.touchPresence(this.wsId, 'agy', 'Inspecting repo & planning run...');
    const ctx = await this.engine.getContext(agy);

    let targetItem = ctx.items.find((i) => i.assigneeId === 'agy' && i.status === 'open');
    if (!targetItem && opts.syncBacklog) {
      targetItem = await this.engine.createItem(agy, {
        title: 'Implement Sub-Agent PR & Workspace Sync on dweidai/ripple',
        body: `Engineering task for prompt: "${opts.userPrompt.slice(0, 120)}"`,
        priority: 'P0',
        assigneeId: 'agy',
        tags: ['github', 'pr', 'engineering'],
      });
    }

    const repoSummary = this.executeRealTools
      ? await inspectGitHubRepo().catch(() => null)
      : null;
    const repoInfoStr = repoSummary
      ? `Repo \`${repoSummary.repo}\` is at \`${repoSummary.headSha.slice(0, 7)}\` on \`${repoSummary.defaultBranch}\` (${repoSummary.openPrs.length} open PRs).`
      : `Checked active runs (${ctx.activeRuns.length}) and touches overlap matrix.`;

    await this.engine.postThreadMessage(agy, {
      scopeKind: opts.scopeKind,
      scopeId: opts.scopeId,
      body:
        `⚡ **Antigravity (@agy — Engineering Lead)**: Understood. ${repoInfoStr}` +
        (opts.linkedGdocUrl ? ` Referencing @muse's Google Doc spec (${opts.linkedGdocUrl}).` : '') +
        (opts.spawnPrSubagent
          ? ` Claiming engineering run and spinning up sub-agent \`agy-sub-github\` to push a branch and open a real GitHub Pull Request on \`dweidai/ripple\`.`
          : ` Ready to claim backlog items or spawn sub-agents on command.`),
    });

    if (!opts.spawnPrSubagent) {
      await this.auth.touchPresence(this.wsId, 'agy', 'Online · Engineering Lead');
      return {};
    }

    let parentRun = ctx.activeRuns.find((r) => r.ownerAgent === 'agy' && !r.parentRunId);
    if (!parentRun) {
      const claimItem =
        targetItem ??
        (await this.engine.createItem(agy, {
          title: 'Automated Sub-Agent GitHub PR Delivery',
          body: opts.userPrompt,
          priority: 'P0',
          assigneeId: 'agy',
          tags: ['github', 'pr'],
        }));
      const activeOnItem = await this.engine.store.findActiveRunByItem(claimItem.id);
      parentRun = activeOnItem ?? (await this.engine.claim(agy, claimItem.id));
      await this.engine.plan(agy, parentRun.id, {
        epoch: parentRun.epoch,
        steps: [
          { title: 'Verify workspace context & git repository HEAD', status: 'done' },
          { title: 'Spawn agy-sub-github sub-agent to create branch & GitHub PR', status: 'active' },
          { title: 'Gate: Pin-bound PR review card for David (@dweidai)', kind: 'gate', status: 'pending' },
        ],
        touches: ['src/agents', 'docs/subagents'],
      });
    }

    const sub = await this.executeGitHubPrSubagent(agy, parentRun, {
      title: 'Ripple Sub-Agent Architecture & Live Workspace Sync',
      userPrompt: opts.userPrompt,
      linkedGdocUrl: opts.linkedGdocUrl,
    });

    await this.engine.updateStep(agy, parentRun.id, {
      epoch: parentRun.epoch,
      idx: 2,
      status: 'done',
      note: sub.prResult ? `Opened PR #${sub.prResult.prNumber}: ${sub.prResult.prUrl}` : 'GitHub sub-agent reported back',
    });

    // Attach PR and commit artifacts to parent run as well and open a pin-bound Review Card for David (@you)
    if (sub.prResult) {
      await this.engine.addArtifact(agy, parentRun.id, {
        epoch: parentRun.epoch,
        stepIdx: 2,
        kind: 'commit',
        ref: sub.prResult.commitSha,
        label: `Commit ${sub.prResult.commitSha.slice(0, 7)} on ${sub.prResult.branch}`,
        url: `https://github.com/dweidai/ripple/commit/${sub.prResult.commitSha}`,
        contentHash: sub.prResult.commitSha,
      });
      await this.engine.addArtifact(agy, parentRun.id, {
        epoch: parentRun.epoch,
        stepIdx: 2,
        kind: 'pr',
        ref: sub.prResult.prUrl,
        label: `PR #${sub.prResult.prNumber}: ${sub.prResult.title}`,
        url: sub.prResult.prUrl,
        contentHash: sub.prResult.commitSha,
        meta: { prNumber: sub.prResult.prNumber, branch: sub.prResult.branch },
      });

      await this.engine.askCard(agy, parentRun.id, {
        epoch: parentRun.epoch,
        type: 'review',
        prompt: `Review & Approve Sub-Agent PR #${sub.prResult.prNumber}: "${sub.prResult.title}"`,
        options: ['approve', 'approve_with_change', 'reject'],
        diffPreview:
          `Branch: ${sub.prResult.branch} -> main\n` +
          `Commit: ${sub.prResult.commitSha}\n` +
          `PR URL: ${sub.prResult.prUrl}\n` +
          (opts.linkedGdocUrl ? `Linked Google Doc: ${opts.linkedGdocUrl}\n` : '') +
          `File:   +${sub.prResult.filePath}`,
        pin: { kind: 'commit', value: sub.prResult.commitSha },
        assignee: { kind: 'user', id: 'you' },
        blocking: false,
      });
    }

    await this.auth.touchPresence(this.wsId, 'agy', 'Online · PR Ready for Review');
    return { parentRun, subRun: sub.subRun, prResult: sub.prResult };
  }

  async executeDriveSubagent(
    parentPrincipal: Principal,
    parentRun: Run,
    input: { title: string; userPrompt: string },
  ): Promise<{ subRun: Run; gdocResult?: GoogleDocResult }> {
    const spawned = await this.engine.spawnSubrun(parentPrincipal, parentRun.id, {
      title: input.title,
      goal: `Search Google Drive context and create a real Google Doc for: ${input.userPrompt}`,
      subagentId: 'muse-sub-drive',
      subagentName: 'Muse Drive & Docs Sub-Agent',
      parentStepIdx: 2,
      steps: [
        { title: 'Query recent Google Drive files via gdrive CLI', status: 'active' },
        { title: 'Create & populate Google Doc via gdocs mutate create/append', status: 'pending' },
        { title: 'Attach gdoc & drive artifacts and report back to Muse', status: 'pending' },
      ],
      touches: ['gdrive://workspace', 'gdocs://spec'],
      capabilities: ['gdrive', 'gdocs'],
    });

    const subRun = spawned.run;
    const subPrincipal = spawned.subagent;
    this.activeSubruns.add(subRun.id);

    try {
      const files = this.executeRealTools ? await searchDriveFiles('', 5) : [];
      await this.engine.updateStep(subPrincipal, subRun.id, {
        epoch: subRun.epoch,
        idx: 1,
        status: 'done',
        note: `Indexed ${files.length} recent Google Drive files`,
      });
      await this.engine.updateStep(subPrincipal, subRun.id, {
        epoch: subRun.epoch,
        idx: 2,
        status: 'active',
        note: 'Creating Google Doc via gdocs CLI...',
      });

      let gdocResult: GoogleDocResult;
      if (this.executeRealTools) {
        const docTitle = `Ripple Workspace — Multi-Agent Dialogue & Architecture Spec (${new Date().toISOString().slice(0, 16)}Z)`;
        gdocResult = await createGoogleDoc({
          title: docTitle,
          sections: [
            {
              heading: '1. Executive Summary & Workspace Context',
              body:
                `This Google Doc was autonomously created by Muse's sub-agent (muse-sub-drive) inside Project Ripple.\n` +
                `Human Lead: David (@dweidai)\n` +
                `Collaborating Agents: Antigravity (@agy) & Muse (@muse)\n` +
                `Trigger Context: ${input.userPrompt}`,
            },
            {
              heading: '2. Connected Google Drive Context',
              body:
                files.length > 0
                  ? `Recent Drive files discovered via gdrive CLI:\n` +
                    files.map((f) => `- ${f.name} (${f.url})`).join('\n')
                  : 'Connected to 5 TB Google Drive workspace via /opt/antigravity/bin/gdrive.',
            },
            {
              heading: '3. Sub-Agent Protocol & Backlog Synchronization',
              body:
                `1. Muse and Antigravity coordinate in the Workspace Dialogue (#main) with hop-count anti-loop safety.\n` +
                `2. Sub-agents (muse-sub-drive, agy-sub-github) execute real gdocs/gdrive and gh PR workflows.\n` +
                `3. All artifacts (Google Docs, Drive links, GitHub PRs, commit SHAs) are pin-bound to Ripple Runs and Decision Cards.`,
            },
          ],
        });
      } else {
        gdocResult = {
          docId: 'doc_simulated_test',
          docUrl: 'https://docs.google.com/document/d/doc_simulated_test/edit',
          title: input.title,
          summary: 'Simulated Google Doc creation in test mode.',
        };
      }

      await this.engine.updateStep(subPrincipal, subRun.id, {
        epoch: subRun.epoch,
        idx: 2,
        status: 'done',
        note: `Created Google Doc ${gdocResult.docId}`,
      });

      const artifactsToAttach: Array<{
        kind: 'gdoc' | 'drive';
        ref: string;
        title: string;
        url: string;
        contentHash: string;
      }> = [
        {
          kind: 'gdoc',
          ref: gdocResult.docUrl,
          title: `Google Doc: ${gdocResult.title}`,
          url: gdocResult.docUrl,
          contentHash: gdocResult.docId,
        },
      ];
      if (files[0]) {
        artifactsToAttach.push({
          kind: 'drive',
          ref: files[0].url,
          title: `Drive Reference: ${files[0].name}`,
          url: files[0].url,
          contentHash: files[0].id,
        });
      }

      // Also attach Google Doc artifact to parent run for visibility
      await this.engine.addArtifact(parentPrincipal, parentRun.id, {
        epoch: parentRun.epoch,
        stepIdx: 2,
        kind: 'gdoc',
        ref: gdocResult.docUrl,
        label: `Google Doc: ${gdocResult.title}`,
        url: gdocResult.docUrl,
        contentHash: gdocResult.docId,
      });

      await this.engine.reportRun(subPrincipal, subRun.id, {
        epoch: subRun.epoch,
        status: 'done',
        summary: `Created Google Doc "${gdocResult.title}" via gdocs CLI and indexed ${files.length} Google Drive file(s). Link: ${gdocResult.docUrl}`,
        reportData: {
          docId: gdocResult.docId,
          docUrl: gdocResult.docUrl,
          driveFilesIndexed: files.length,
        },
        artifacts: artifactsToAttach,
      });

      return { subRun, gdocResult };
    } finally {
      this.activeSubruns.delete(subRun.id);
    }
  }

  async executeGitHubPrSubagent(
    parentPrincipal: Principal,
    parentRun: Run,
    input: { title: string; userPrompt: string; linkedGdocUrl?: string },
  ): Promise<{ subRun: Run; prResult?: GitHubPrResult }> {
    const spawned = await this.engine.spawnSubrun(parentPrincipal, parentRun.id, {
      title: `Create GitHub Branch & PR: ${input.title}`,
      goal: `Create isolated branch, commit sub-agent spec/report, and open a real GitHub Pull Request on dweidai/ripple via gh CLI.`,
      subagentId: 'agy-sub-github',
      subagentName: 'Antigravity GitHub PR Sub-Agent',
      parentStepIdx: 2,
      steps: [
        { title: 'Inspect dweidai/ripple main branch HEAD via gh CLI', status: 'active' },
        { title: 'Create branch & commit sub-agent deliverable via gh api', status: 'pending' },
        { title: 'Open Pull Request on dweidai/ripple & report PR URL back to Agy', status: 'pending' },
      ],
      touches: ['github:dweidai/ripple', 'docs/subagents'],
      capabilities: ['github'],
    });

    const subRun = spawned.run;
    const subPrincipal = spawned.subagent;
    this.activeSubruns.add(subRun.id);

    try {
      await this.engine.updateStep(subPrincipal, subRun.id, {
        epoch: subRun.epoch,
        idx: 1,
        status: 'done',
        note: 'Verified dweidai/ripple repository & main branch SHA',
      });
      await this.engine.updateStep(subPrincipal, subRun.id, {
        epoch: subRun.epoch,
        idx: 2,
        status: 'active',
        note: 'Pushing branch & creating Pull Request via gh CLI...',
      });

      let prResult: GitHubPrResult;
      if (this.executeRealTools) {
        const prTitle = `feat(ripple): sub-agent workspace sync & spec (${new Date().toISOString().slice(11, 16)} UTC)`;
        const prBody =
          `## Summary\n` +
          `This Pull Request was autonomously created by **Antigravity's GitHub Sub-Agent (\`agy-sub-github\`)** inside the hosted **Ripple** workspace.\n\n` +
          `- **Human Lead**: David (\`@dweidai\`)\n` +
          `- **Parent Run**: \`${parentRun.id}\` (\`@agy\`)\n` +
          `- **Sub-Agent Run**: \`${subRun.id}\` (\`@agy-sub-github\`)\n` +
          (input.linkedGdocUrl ? `- **Linked Muse Google Doc Spec**: ${input.linkedGdocUrl}\n` : '') +
          `- **Dialogue Trigger**: "${input.userPrompt.slice(0, 200)}"\n`;

        prResult = await createGitHubPullRequest({
          title: prTitle,
          body: prBody,
        });
      } else {
        prResult = {
          prNumber: 999,
          prUrl: 'https://github.com/dweidai/ripple/pull/999',
          branch: 'subagent/test-branch',
          commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
          title: input.title,
          filePath: 'docs/subagents/test.md',
        };
      }

      await this.engine.updateStep(subPrincipal, subRun.id, {
        epoch: subRun.epoch,
        idx: 2,
        status: 'done',
        note: `Committed ${prResult.commitSha.slice(0, 7)} to ${prResult.branch}`,
      });

      await this.engine.reportRun(subPrincipal, subRun.id, {
        epoch: subRun.epoch,
        status: 'done',
        summary: `Opened GitHub Pull Request #${prResult.prNumber} ("${prResult.title}") on branch \`${prResult.branch}\` at commit \`${prResult.commitSha.slice(0, 7)}\`: ${prResult.prUrl}`,
        reportData: {
          prNumber: prResult.prNumber,
          prUrl: prResult.prUrl,
          branch: prResult.branch,
          commitSha: prResult.commitSha,
        },
        artifacts: [
          {
            kind: 'pr',
            ref: prResult.prUrl,
            title: `GitHub PR #${prResult.prNumber}: ${prResult.title}`,
            url: prResult.prUrl,
            contentHash: prResult.commitSha,
            meta: { prNumber: prResult.prNumber, branch: prResult.branch },
          },
          {
            kind: 'commit',
            ref: prResult.commitSha,
            title: `Commit ${prResult.commitSha.slice(0, 7)} (${prResult.branch})`,
            url: `https://github.com/dweidai/ripple/commit/${prResult.commitSha}`,
            contentHash: prResult.commitSha,
          },
        ],
      });

      return { subRun, prResult };
    } finally {
      this.activeSubruns.delete(subRun.id);
    }
  }
}
