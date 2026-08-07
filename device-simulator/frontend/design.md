# Design — SmartHome Device Simulator

A locked design system for the Device Simulator dashboard. Every screen reads
this file before changing visual structure. The interface is an operations tool:
device state and actions take priority over decoration.

## Genre

Modern-minimal with a technical-utilitarian voice. Copy is Vietnamese, concrete,
and action-led. Machine identifiers and raw payloads remain in their original
technical form.

## Audience and primary job

- Audience: project owner, developers, and functional testers.
- Primary job: choose a virtual device, understand its current state, change a
  physical value, and verify what the device publishes to the main system.
- Secondary jobs: generate users/devices, inspect runs, and diagnose infrastructure.

## Macrostructure family

- App screens: **Workbench** — compact navigation rail, a quiet functional
  heading, and one dominant work surface.
- Device detail: **Workbench + F3 Tabular Spec Sheet** — live controls are the
  primary surface; identity, topology, and history support it.
- Utility screens: **Workbench** with a single-column form or registry table.

## Information architecture

1. Thiết bị — default route; searchable virtual-device inventory.
2. Người dùng — virtual accounts and their owned devices.
3. Tạo dữ liệu — simulation-run configuration.
4. Lần chạy — generation progress, retention, and cleanup.
5. Hệ thống — admin token, dependency checks, totals, and events.

## Theme

Coral, warm-light. Accent is reserved for focus, active navigation, and primary
actions; it must not become a large decorative fill.

- `--color-paper`: `oklch(97.5% 0.009 62)`
- `--color-paper-2`: `oklch(94.8% 0.014 58)`
- `--color-paper-3`: `oklch(90.8% 0.019 55)`
- `--color-ink`: `oklch(24% 0.018 38)`
- `--color-ink-2`: `oklch(33% 0.016 39)`
- `--color-muted`: `oklch(46% 0.014 42)`
- `--color-rule`: `oklch(86% 0.018 55)`
- `--color-rule-2`: `oklch(75% 0.026 50)`
- `--color-accent`: `oklch(52% 0.17 29)`
- `--color-accent-ink`: `oklch(98% 0.008 60)`
- `--color-focus`: `oklch(46% 0.18 28)`

The LCD is a semantic hardware surface, not a second brand accent. Its green
characters are confined to the LCD component.

## Typography

- Display: Geist, weight 700, normal style.
- Body: Geist, weight 400.
- Technical values: Geist Mono, weight 500.
- Display tracking: `-0.025em`.
- Type scale anchor: `--text-display: clamp(2.2rem, 4vw + 0.5rem, 4.2rem)`.
- All changing metrics use tabular numerals.

## Spacing

4-point named scale from `--space-3xs` through `--space-4xl`. Components use
named tokens only. App controls share a 44 px minimum interactive height.

## Motion

- No page reveal sequence and no decorative animation.
- Device values may crossfade/tick when refreshed.
- Buttons and switches use a short press response only.
- Easings: `--ease-out`, `--ease-in`, and `--ease-in-out` from `tokens.css`.
- Reduced motion: opacity-only, no longer than 150 ms.

## Microinteractions stance

- Physical controls update optimistically and roll back on request failure.
- Success is silent when the new state is visible.
- Errors name the failed action and the next corrective step.
- Focus is immediate; hover exists only on fine pointers.
- Long-running operations retain readable loading labels.

## Component voice

- Navigation: compact left rail on desktop; horizontal scroll-free tab bar on
  small screens.
- Primary action: ink fill, short Vietnamese verb, restrained radius.
- Secondary action: paper surface with a visible rule.
- Device cards: one containment layer, no card-in-card nesting.
- Controls: native checkbox/range/select semantics with custom presentation.
- Telemetry: labelled values first; raw JSON behind a disclosure.
- Camera: an honest unavailable state until stream simulation is implemented.

## Per-screen allowances

- Device detail MAY use a dark hardware surface for the LCD only.
- App screens MUST NOT use hero art, stock imagery, gradients, or metric claims.
- Raw JSON is allowed only in technical disclosure panels.

## What screens MUST share

- Navigation rail, page-title rhythm, button geometry, focus ring, and status language.
- Coral accent placement under five percent of the viewport.
- Geist/Geist Mono typography and the named 4-point spacing scale.
- Vietnamese action labels and explicit loading/error copy.

## What screens MAY differ on

- Device detail may use a two-pane workbench on wide viewports.
- Registry screens may use compact lists; forms may use a narrow reading column.
- Only LCD-capable products render the LCD simulator.

## Exports

### tokens.css

```css
:root {
  --color-paper: oklch(97.5% 0.009 62);
  --color-paper-2: oklch(94.8% 0.014 58);
  --color-paper-3: oklch(90.8% 0.019 55);
  --color-rule: oklch(86% 0.018 55);
  --color-rule-2: oklch(75% 0.026 50);
  --color-muted: oklch(46% 0.014 42);
  --color-neutral: oklch(39% 0.015 40);
  --color-ink-2: oklch(33% 0.016 39);
  --color-ink: oklch(24% 0.018 38);
  --color-accent: oklch(52% 0.17 29);
  --color-accent-ink: oklch(98% 0.008 60);
  --color-focus: oklch(46% 0.18 28);

  --font-display: "Geist", "Segoe UI", sans-serif;
  --font-body: "Geist", "Segoe UI", sans-serif;
  --font-outlier: "Geist Mono", "Cascadia Mono", monospace;

  --space-3xs: 0.125rem;
  --space-2xs: 0.25rem;
  --space-xs: 0.5rem;
  --space-sm: 0.75rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2.5rem;
  --space-2xl: 4rem;
  --space-3xl: 6rem;
  --space-4xl: 9rem;

  --text-xs: 0.7rem;
  --text-sm: 0.8rem;
  --text-base: 1rem;
  --text-md: 1.25rem;
  --text-lg: 1.5625rem;
  --text-xl: 1.9531rem;
  --text-2xl: 2.4414rem;
  --text-display: clamp(2.2rem, 4vw + 0.5rem, 4.2rem);

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-micro: 120ms;
  --dur-short: 220ms;
  --dur-long: 420ms;
  --rule-fine: 1px;
  --rule-focus: 2px;
  --radius-card: 0.75rem;
  --radius-pill: 999px;
  --radius-input: 0.5rem;
}
```

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper: oklch(97.5% 0.009 62);
  --color-paper-2: oklch(94.8% 0.014 58);
  --color-paper-3: oklch(90.8% 0.019 55);
  --color-rule: oklch(86% 0.018 55);
  --color-rule-2: oklch(75% 0.026 50);
  --color-muted: oklch(46% 0.014 42);
  --color-neutral: oklch(39% 0.015 40);
  --color-ink-2: oklch(33% 0.016 39);
  --color-ink: oklch(24% 0.018 38);
  --color-accent: oklch(52% 0.17 29);
  --color-focus: oklch(46% 0.18 28);
  --font-display: "Geist", "Segoe UI", sans-serif;
  --font-body: "Geist", "Segoe UI", sans-serif;
  --font-outlier: "Geist Mono", "Cascadia Mono", monospace;
  --spacing-xs: 0.5rem;
  --spacing-sm: 0.75rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;
  --spacing-xl: 2.5rem;
  --text-sm: 0.8rem;
  --text-base: 1rem;
  --text-md: 1.25rem;
  --radius-card: 0.75rem;
  --radius-pill: 999px;
  --radius-input: 0.5rem;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
}
```

### DTCG `tokens.json`

```json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "paper": { "$value": "oklch(97.5% 0.009 62)", "$type": "color" },
    "paper-2": { "$value": "oklch(94.8% 0.014 58)", "$type": "color" },
    "ink": { "$value": "oklch(24% 0.018 38)", "$type": "color" },
    "ink-2": { "$value": "oklch(33% 0.016 39)", "$type": "color" },
    "rule": { "$value": "oklch(86% 0.018 55)", "$type": "color" },
    "accent": { "$value": "oklch(52% 0.17 29)", "$type": "color" },
    "focus": { "$value": "oklch(46% 0.18 28)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "Geist, Segoe UI, sans-serif", "$type": "fontFamily" },
    "body": { "$value": "Geist, Segoe UI, sans-serif", "$type": "fontFamily" },
    "outlier": { "$value": "Geist Mono, Cascadia Mono, monospace", "$type": "fontFamily" }
  },
  "space": {
    "xs": { "$value": "0.5rem", "$type": "dimension" },
    "sm": { "$value": "0.75rem", "$type": "dimension" },
    "md": { "$value": "1rem", "$type": "dimension" },
    "lg": { "$value": "1.5rem", "$type": "dimension" },
    "xl": { "$value": "2.5rem", "$type": "dimension" }
  },
  "duration": {
    "micro": { "$value": "120ms", "$type": "duration" },
    "short": { "$value": "220ms", "$type": "duration" },
    "long": { "$value": "420ms", "$type": "duration" }
  }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background: 97.5% 0.009 62;
  --foreground: 24% 0.018 38;
  --card: 94.8% 0.014 58;
  --card-foreground: 24% 0.018 38;
  --popover: 97.5% 0.009 62;
  --popover-foreground: 24% 0.018 38;
  --primary: 52% 0.17 29;
  --primary-foreground: 98% 0.008 60;
  --secondary: 90.8% 0.019 55;
  --secondary-foreground: 33% 0.016 39;
  --muted: 86% 0.018 55;
  --muted-foreground: 46% 0.014 42;
  --accent: 52% 0.17 29;
  --accent-foreground: 98% 0.008 60;
  --destructive: 47% 0.18 25;
  --destructive-foreground: 98% 0.008 60;
  --border: 86% 0.018 55;
  --input: 86% 0.018 55;
  --ring: 46% 0.18 28;
  --radius: 0.75rem;
}
```
