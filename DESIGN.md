# Stitch Design System — Ripple (WhatsApp-Style Human+Agent Workspace)

> Design DNA and component specifications for Ripple, designed following Google Stitch principles: minimalistic, mobile-first, and conversational.

## 1. Design Philosophy
- **Conversational Core:** Work happens in a shared stream, not scattered across 10 dense dashboard panels. The primary screen feels like a modern messaging app (WhatsApp / Telegram).
- **Embedded State, Not Separate Silos:** Approvals (Cards), sub-agent PRs, Google Docs, and task updates appear directly inline as interactive chat bubbles in the flow of conversation.
- **Single-Tap Agent Navigation (`+`):** Adding an agent should be as easy as tapping `+` and copying an onboarding prompt that the agent can read and execute autonomously.

## 2. Design Tokens (YAML)

```yaml
tokens:
  color:
    background:
      main: "#0b141a"       # WhatsApp dark theme deep background
      elevated: "#111b21"   # Header & top navigation bar
      panel: "#111b21"      # Drawers and sheets
      input: "#202c33"      # Search & chat input fields
      bubble_human: "#005c4b" # Outgoing human message bubble (WhatsApp green)
      bubble_agent: "#202c33" # Incoming agent message bubble (Slate)
      bubble_system: "#182229" # System notices & milestones
    foreground:
      primary: "#e9edef"    # High-contrast text
      secondary: "#8696a0"  # Timestamps & meta text
      muted: "#667781"      # Subtle borders and dividers
    accent:
      whatsapp_green: "#00a884"
      agent_agy: "#58a6ff"       # Antigravity blue
      agent_muse: "#bc8cff"      # Muse purple
      agent_grok: "#f778ba"      # Grok pink
      agent_openclaw: "#d29922"  # OpenClaw amber
      success: "#25d366"
      warning: "#f59e0b"
      error: "#ef4444"
  typography:
    font_family: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    mono_family: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    sizes:
      xs: "11px"
      sm: "12px"
      base: "13px"
      md: "14px"
      lg: "16px"
      xl: "18px"
  spacing:
    bubble_padding: "8px 12px"
    input_height: "44px"
    touch_target: "40px"
    card_radius: "12px"
    bubble_radius: "12px"
```

## 3. Screen Hierarchy
1. **Header (Group Bar):**
   - Left: Ripple logo, title "Ripple", subtitle "David (You), Antigravity, Muse (2 agents online)" with green pulse dot.
   - Right: **`+ Invite` button** (triggers Agent Prompt Generator modal), Tab switcher (`💬 Chat`, `📋 Tasks`, `⚡ Runs`).
2. **Main Conversational Stream:**
   - Message bubbles grouped by actor.
   - Human messages aligned right in WhatsApp green (`#005c4b`).
   - Agent messages aligned left in slate (`#202c33`) with colored agent names and badges (`@agy`, `@muse`).
   - Inline Cards:
     - **Approval Card:** Inlined inside agent chat bubble with commit SHA pin, diff preview, and one-tap `Approve` / `With Change` / `Reject` buttons.
     - **GitHub PR Card:** Clickable GitHub badge with PR title, number, branch, and status.
     - **Google Doc Card:** Clickable Drive badge with Doc title and link.
3. **Chat Input Bar:**
   - Sticky at bottom.
   - One-tap quick tags (`@agy`, `@muse`, `New Task`).
   - Clean rounded input field + send icon button.
4. **`+ Invite Agent` Modal:**
   - Selector for agent type (`Antigravity`, `Muse`, `OpenClaw`, `Grok`, `Custom`).
   - Instant live prompt preview: "You are invited to join David's collaborative workspace..."
   - One-click **"📋 Copy Prompt for Agent"** button.
